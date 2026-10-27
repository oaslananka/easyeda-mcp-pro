import {
  DurableTaskStore,
  READ_ONLY_TASK_OPERATIONS,
  type SafeTaskOperation,
  type TaskRecord,
} from './task-store.js';

// This component is NOT connected to the production server. It requires
// validated authorization and a safe dispatcher at any future call site.
export interface AuthorizedTaskPrincipal {
  ownerId: string;
  authorizedOperations: ReadonlySet<SafeTaskOperation>;
}

export type ReadOnlyTaskExecutor = (
  operation: SafeTaskOperation,
  args: unknown,
  signal: AbortSignal,
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 64;
const MAX_EXECUTION_MS = 30000;

type Pending = { task: TaskRecord; ownerId: string };

export class DurableReadOnlyTaskRunner {
  private readonly queue: Pending[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private active = 0;
  private stopped = false;

  constructor(
    private readonly store: DurableTaskStore,
    private readonly executor: ReadOnlyTaskExecutor,
  ) {}

  submit(
    principal: AuthorizedTaskPrincipal,
    operation: SafeTaskOperation,
    args: unknown,
  ): TaskRecord {
    if (this.stopped) throw new Error('Task executor is stopped');
    if (
      !principal.ownerId ||
      principal.ownerId.trim() !== principal.ownerId ||
      principal.ownerId.length > 256 ||
      !READ_ONLY_TASK_OPERATIONS.includes(operation) ||
      !principal.authorizedOperations.has(operation)
    )
      throw new Error('Unauthorized task operation');
    if (this.queue.length >= MAX_QUEUED) throw new Error('Task queue at capacity');

    // SQLite transaction commits before the handle is returned to the client.
    const task = this.store.create(principal.ownerId, operation, args);
    this.queue.push({ task, ownerId: principal.ownerId });
    queueMicrotask(() => this.dispatch());
    return task;
  }

  cancel(principal: AuthorizedTaskPrincipal, taskId: string): boolean {
    const task = this.store.get(principal.ownerId, taskId);
    if (!task || !principal.authorizedOperations.has(task.operation)) return false;
    const accepted = this.store.requestCancel(principal.ownerId, taskId);
    if (accepted) {
      this.controllers.get(taskId)?.abort();
      // A task not yet executing can be finalized without any CAD access.
      if (!this.controllers.has(taskId)) this.store.markCancelled(principal.ownerId, taskId);
    }
    return accepted;
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
  }

  private dispatch(): void {
    if (this.stopped) return;
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) break;
      const state = this.store.get(pending.ownerId, pending.task.id);
      if (!state || state.cancelRequested || state.status !== 'working') {
        if (state?.cancelRequested) this.store.markCancelled(pending.ownerId, pending.task.id);
        continue;
      }
      this.active++;
      const controller = new AbortController();
      this.controllers.set(pending.task.id, controller);
      void this.execute(pending, controller).finally(() => {
        this.controllers.delete(pending.task.id);
        this.active--;
        queueMicrotask(() => this.dispatch());
      });
    }
  }

  private async execute(pending: Pending, controller: AbortController): Promise<void> {
    const { task, ownerId } = pending;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const executing = this.executor(task.operation, task.arguments, controller.signal);
      const watchdog = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Read-only operation deadline exceeded'));
        }, MAX_EXECUTION_MS);
      });
      const result = await Promise.race([executing, watchdog]);
      if (this.store.get(ownerId, task.id)?.cancelRequested) {
        this.store.markCancelled(ownerId, task.id);
      } else {
        this.store.finish(ownerId, task.id, result);
      }
    } catch (error) {
      if (this.store.get(ownerId, task.id)?.cancelRequested) {
        this.store.markCancelled(ownerId, task.id);
      } else {
        this.store.fail(
          ownerId,
          task.id,
          error instanceof Error && error.message === 'Read-only operation deadline exceeded'
            ? 'execution_timeout'
            : 'execution_failed',
        );
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

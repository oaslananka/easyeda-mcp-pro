import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type DurableTaskStore, type SafeTaskOperation, type TaskRecord } from './task-store.js';

// Staging adapter only: NOT registered in createServer until a worker exists.
const EXTENSION = 'io.modelcontextprotocol/tasks';
const params = z.object({ taskId: z.string().uuid() });
const ack = z.object({ resultType: z.literal('complete') });
export interface TrustedTaskPrincipal {
  ownerId: string; // Derived server-side from validated auth/session, never request params.
  allowedOperations: ReadonlySet<SafeTaskOperation>;
}
export interface TaskProtocolDependencies {
  store: DurableTaskStore;
  trustedPrincipal: (ctx: ServerContext) => TrustedTaskPrincipal | undefined;
}
function requireCapability(ctx: ServerContext): void {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  if (envelope?.[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') {
    throw new ProtocolError(
      ProtocolErrorCode.MethodNotFound,
      'Modern Tasks require protocol 2026-07-28',
    );
  }
  const caps = envelope[CLIENT_CAPABILITIES_META_KEY] as
    { extensions?: Record<string, unknown> } | undefined;
  if (!caps?.extensions || !Object.hasOwn(caps.extensions, EXTENSION)) {
    throw new ProtocolError(
      ProtocolErrorCode.MissingRequiredClientCapability,
      'The client must declare Tasks support on each request',
      { requiredCapabilities: { extensions: { [EXTENSION]: {} } } },
    );
  }
}
function authorize(
  dependencies: TaskProtocolDependencies,
  ctx: ServerContext,
  taskId: string,
): { task: TaskRecord; principal: TrustedTaskPrincipal } {
  requireCapability(ctx);
  const principal = dependencies.trustedPrincipal(ctx);
  if (
    !principal ||
    principal.ownerId.trim() !== principal.ownerId ||
    principal.ownerId.length < 1 ||
    principal.ownerId.length > 256
  ) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not accessible');
  }
  const task = dependencies.store.get(principal.ownerId, taskId);
  if (!task || !principal.allowedOperations.has(task.operation)) {
    // Do not disclose whether a task belongs to a different principal.
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown or unauthorized task');
  }
  return { task, principal };
}
export function toTaskGetResponse(task: TaskRecord) {
  const base = {
    resultType: 'complete' as const,
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: 1500,
  };
  if (task.status === 'completed') {
    if (
      typeof task.result !== 'object' ||
      task.result === null ||
      Array.isArray(task.result) ||
      !Array.isArray((task.result as Record<string, unknown>).content)
    ) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Malformed persisted tool result');
    }
    return { ...base, result: task.result };
  }
  if (task.status === 'failed') {
    return {
      ...base,
      error: { code: ProtocolErrorCode.InternalError, message: task.error ?? 'Task failed' },
    };
  }
  return base;
}
export function registerTaskStatusHandlers(
  server: McpServer,
  dependencies: TaskProtocolDependencies,
): void {
  server.server.setRequestHandler(
    'tasks/get',
    { params, result: ack.passthrough() },
    async (input, ctx) => toTaskGetResponse(authorize(dependencies, ctx, input.taskId).task),
  );
  server.server.setRequestHandler(
    'tasks/update',
    { params: params.extend({ inputResponses: z.record(z.string(), z.unknown()) }), result: ack },
    async (input, ctx) => {
      // No input_required tasks exist yet; unknown response keys are ignored.
      authorize(dependencies, ctx, input.taskId);
      return { resultType: 'complete' as const };
    },
  );
  server.server.setRequestHandler('tasks/cancel', { params, result: ack }, async (input, ctx) => {
    const { task, principal } = authorize(dependencies, ctx, input.taskId);
    if (task.status === 'working') {
      dependencies.store.requestCancel(principal.ownerId, task.id);
    }
    // Cooperative intent; a worker must later persist terminal cancellation.
    return { resultType: 'complete' as const };
  });
}

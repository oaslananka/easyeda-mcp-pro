import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import { type ToolRegistry } from '../tools/registry.js';
import {
  validateReadOnlyTaskArguments,
  type TaskAuthorizationPolicy,
} from './task-authorization.js';
import {
  resolveLocalStdioTaskPrincipal,
  type TrustedLocalStdioTaskSession,
} from './task-local-session.js';
import { assertModernTaskCapability, registerTaskStatusHandlers } from './task-protocol.js';
import { type DurableReadOnlyTaskRunner } from './task-runner.js';
import {
  READ_ONLY_TASK_OPERATIONS,
  type DurableTaskStore,
  type SafeTaskOperation,
  type TaskRecord,
} from './task-store.js';

// Testable, isolated 2026-07-28 tools/call producer; production intentionally
// does NOT call this function. Replacing the default tools/call handler would
// suppress ordinary synchronous tools and requires separate rollout design.
type LocalConfig = Pick<EnvConfig, 'TRANSPORT' | 'MCP_BRIDGE_BACKEND' | 'TOOL_SCOPES'>;
export interface LocalTaskProducerDependencies {
  config: LocalConfig;
  registry: ToolRegistry;
  session: TrustedLocalStdioTaskSession;
  store: DurableTaskStore;
  runner: DurableReadOnlyTaskRunner;
}

const toolCallParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
const taskResult = z
  .object({
    resultType: z.literal('task'),
    taskId: z.string().uuid(),
    status: z.enum(['working', 'completed', 'failed', 'cancelled']),
  })
  .passthrough();

function localPrincipal(deps: LocalTaskProducerDependencies) {
  const principal = resolveLocalStdioTaskPrincipal(deps.session, deps.config, deps.registry);
  if (!principal) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not authorized');
  return principal;
}

/**
 * An unavailable durable store must never echo native or SQLite exception
 * details to an MCP client. A missing record is never acknowledged.
 */
function enqueueReadOnlyTask(
  deps: LocalTaskProducerDependencies,
  principal: { ownerId: string; allowedOperations: ReadonlySet<SafeTaskOperation> },
  operation: SafeTaskOperation,
  arguments_: unknown,
): TaskRecord | undefined {
  try {
    return deps.runner.submit(
      { ownerId: principal.ownerId, authorizedOperations: principal.allowedOperations },
      operation,
      arguments_,
    );
  } catch {
    return undefined;
  }
}

export function createLocalTaskFromToolCall(
  deps: LocalTaskProducerDependencies,
  input: z.infer<typeof toolCallParams>,
  ctx: ServerContext,
) {
  assertModernTaskCapability(ctx);
  const principal = localPrincipal(deps);
  if (!READ_ONLY_TASK_OPERATIONS.includes(input.name as SafeTaskOperation)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool is not task eligible');
  }
  const operation = input.name as SafeTaskOperation;
  const policy: TaskAuthorizationPolicy = {
    registry: deps.registry,
    configuredScopes: deps.config.TOOL_SCOPES,
    bridgeBackend: 'local',
  };
  let arguments_: unknown;
  try {
    arguments_ = validateReadOnlyTaskArguments(principal, policy, operation, input.arguments ?? {});
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task input not authorized');
  }
  // The SQLite insert/readback happen synchronously BEFORE returning a task
  // handle. The injected executor is never a native design write tool.
  const task = enqueueReadOnlyTask(deps, principal, operation, arguments_);
  if (!task) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'Read-only task unavailable');
  }
  return {
    resultType: 'task' as const,
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.updatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: 1500,
  };
}

/**
 * Staging-only low-level handler for a dedicated test server, NOT createServer.
 * The future product adapter must preserve synchronous built-in tools/call
 * handling for legacy clients and ineligible tools.
 */
export function registerStagedLocalTaskProducer(
  server: McpServer,
  dependencies: LocalTaskProducerDependencies,
): void {
  server.server.setRequestHandler(
    'tools/call',
    { params: toolCallParams, result: taskResult },
    async (input, ctx) => createLocalTaskFromToolCall(dependencies, input, ctx),
  );
  registerTaskStatusHandlers(server, {
    store: dependencies.store,
    trustedPrincipal: () =>
      resolveLocalStdioTaskPrincipal(
        dependencies.session,
        dependencies.config,
        dependencies.registry,
      ),
    cancelTask: (principal, task) => {
      dependencies.runner.cancel(
        { ownerId: principal.ownerId, authorizedOperations: principal.allowedOperations },
        task.id,
      );
    },
  });
}

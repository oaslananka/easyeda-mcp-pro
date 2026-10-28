import { handleRegisteredToolCall, type ToolRegistry } from '../tools/registry.js';
import { type ToolContext } from '../tools/types.js';
import {
  deriveTrustedReadOnlyTaskPrincipal,
  validateReadOnlyTaskArguments,
  type VerifiedOAuthTaskIdentity,
  type TaskAuthorizationPolicy,
} from './task-authorization.js';
import { READ_ONLY_TASK_OPERATIONS, type SafeTaskOperation } from './task-store.js';

interface TaskDispatchDependencies {
  registry: ToolRegistry;
  context: ToolContext;
  policy: TaskAuthorizationPolicy;
}

/**
 * Offline staging adapter: reuse the real MCP ToolRegistry handler, including
 * declared input/output schemas, scope controls and structured errors.
 *
 * A future worker MUST supply the validated identity from a trusted verifier
 * again at execution time. Never hydrate this identity from persisted task
 * args, client headers or an unverified token.
 */
function requireTrustedRuntime(deps: TaskDispatchDependencies): void {
  const runtime = deps.context.config;
  if (
    deps.registry !== deps.policy.registry ||
    deps.policy.bridgeBackend !== 'local' ||
    runtime.MCP_BRIDGE_BACKEND !== 'local_bridge' ||
    runtime.TOOL_SCOPES !== deps.policy.configuredScopes
  ) {
    throw new Error('Task policy does not match the active tool registry');
  }
}

function requirePrincipalAuthorization(
  deps: TaskDispatchDependencies,
  identity: VerifiedOAuthTaskIdentity | undefined,
  ownerId: string,
  operation: SafeTaskOperation,
): NonNullable<ReturnType<typeof deriveTrustedReadOnlyTaskPrincipal>> {
  const principal = deriveTrustedReadOnlyTaskPrincipal(identity, deps.policy);
  if (!principal || principal.ownerId !== ownerId || !principal.allowedOperations.has(operation)) {
    throw new Error('Task principal or operation is not authorized');
  }
  return principal;
}

export async function dispatchAuthorizedReadOnlyTask(
  deps: TaskDispatchDependencies,
  identity: VerifiedOAuthTaskIdentity | undefined,
  ownerId: string,
  operation: SafeTaskOperation,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  if (signal.aborted || !READ_ONLY_TASK_OPERATIONS.includes(operation)) {
    throw new Error('Task execution not authorized');
  }
  requireTrustedRuntime(deps);
  const principal = requirePrincipalAuthorization(deps, identity, ownerId, operation);
  const parsed = validateReadOnlyTaskArguments(principal, deps.policy, operation, rawArgs);
  const tool = deps.registry.getEnabledTools().find((item) => item.name === operation);
  if (!tool) throw new Error('Task tool not enabled');

  // Route through existing ToolRegistry parsing, scope and output validators,
  // never directly through tool.handler or an unchecked native bridge method.
  const output = await handleRegisteredToolCall(tool, deps.context, parsed, undefined);
  if (signal.aborted) throw new Error('Task cancelled during execution');

  // Current permissions and expiration must hold even after a long bridge read.
  requireTrustedRuntime(deps);
  requirePrincipalAuthorization(deps, identity, ownerId, operation);
  if (
    ('isError' in output && output.isError === true) ||
    !Array.isArray(output.content) ||
    ('structuredContent' in output &&
      'not_available' in output.structuredContent &&
      output.structuredContent.not_available === true)
  ) {
    // The runner converts this failure to a static, non-sensitive error string.
    throw new Error('Read-only tool invocation was unsuccessful');
  }
  return {
    content: output.content,
    ...(output.structuredContent ? { structuredContent: output.structuredContent } : {}),
  };
}

import { randomUUID } from 'node:crypto';
import { type EnvConfig } from '../config/env.js';
import {
  isToolScopeAllowedByServer,
  remoteRiskForTool,
  sideEffectForTool,
  type ToolRegistry,
} from '../tools/registry.js';
import { READ_ONLY_TASK_OPERATIONS, type SafeTaskOperation } from './task-store.js';
import { type TrustedTaskPrincipal } from './task-protocol.js';

type LocalConfig = Pick<EnvConfig, 'TRANSPORT' | 'MCP_BRIDGE_BACKEND' | 'TOOL_SCOPES'>;

// Mint a session only in stdio process bootstrap, never from MCP parameters.
export interface TrustedLocalStdioTaskSession {
  readonly mode: 'stdio';
}
type SessionState = {
  readonly ownerId: string;
  readonly registry: ToolRegistry;
  readonly configuredScopes: string;
};
const sessions = new WeakMap<TrustedLocalStdioTaskSession, SessionState>();

function trustedStdioConfig(config: LocalConfig): boolean {
  return config.TRANSPORT === 'stdio' && config.MCP_BRIDGE_BACKEND === 'local_bridge';
}

/**
 * Local users never require OAuth or browser login. One process has an
 * unpredictable owner identity; unfinished tasks from a dead process cannot
 * be impersonated or automatically restarted from an old identifier.
 */
export function createLocalStdioTaskSession(
  config: LocalConfig,
  registry: ToolRegistry,
): TrustedLocalStdioTaskSession {
  if (!trustedStdioConfig(config)) {
    throw new Error('Trusted local task sessions require a local stdio server');
  }
  const session = Object.freeze({ mode: 'stdio' as const });
  sessions.set(session, {
    ownerId: randomUUID(),
    registry,
    configuredScopes: config.TOOL_SCOPES,
  });
  return session;
}

function auditedReadOnlyOperation(registry: ToolRegistry, operation: SafeTaskOperation) {
  const tool = registry.getEnabledTools().find((entry) => entry.name === operation);
  if (
    !tool ||
    tool.confirmWrite ||
    tool.risk !== 'low' ||
    tool.annotations.readOnlyHint !== true ||
    sideEffectForTool(tool) !== 'read-only' ||
    remoteRiskForTool(tool) !== 'read'
  )
    return undefined;
  return tool;
}

/**
 * Revalidate read-only tool permissions and active scopes on every call.
 * HTTP, Relay, foreign registry and forged JSON objects fail closed.
 */
export function resolveLocalStdioTaskPrincipal(
  session: unknown,
  config: LocalConfig,
  registry: ToolRegistry,
): TrustedTaskPrincipal | undefined {
  if (!trustedStdioConfig(config) || !session || typeof session !== 'object') return undefined;
  const state = sessions.get(session as TrustedLocalStdioTaskSession);
  if (!state || state.registry !== registry || state.configuredScopes !== config.TOOL_SCOPES)
    return undefined;

  const allowedOperations = new Set<SafeTaskOperation>();
  for (const operation of READ_ONLY_TASK_OPERATIONS) {
    const tool = auditedReadOnlyOperation(registry, operation);
    if (tool && isToolScopeAllowedByServer(tool, config.TOOL_SCOPES)) {
      allowedOperations.add(operation);
    }
  }
  return allowedOperations.size ? { ownerId: state.ownerId, allowedOperations } : undefined;
}

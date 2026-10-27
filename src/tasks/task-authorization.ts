import { createHash } from 'node:crypto';
import {
  getRequiredToolScopes,
  remoteRiskForTool,
  sideEffectForTool,
  type ToolRegistry,
} from '../tools/registry.js';
import { READ_ONLY_TASK_OPERATIONS, type SafeTaskOperation } from './task-store.js';
import { type TrustedTaskPrincipal } from './task-protocol.js';

/**
 * Authenticated identity as produced by a trusted server-side OAuth verifier.
 * DO NOT construct this from client request body, headers, or unverified JWTs.
 * This is an isolated policy evaluator, NOT connected to the MCP factory.
 */
export interface VerifiedOAuthTaskIdentity {
  kind: 'verified-oauth';
  issuer: string;
  subject: string;
  clientId: string;
  scopes: readonly string[];
  expiresAtEpochSeconds: number;
}
export interface TaskAuthorizationPolicy {
  registry: ToolRegistry;
  configuredScopes: string;
  bridgeBackend: 'local' | 'remote_relay';
  nowEpochSeconds?: () => number;
}
const MAX_FIELD_LENGTH = 512;

function validField(field: unknown): field is string {
  return (
    typeof field === 'string' &&
    field.length > 0 &&
    field.length <= MAX_FIELD_LENGTH &&
    field === field.trim()
  );
}

function allowedByScope(scope: string, permissions: ReadonlySet<string>): boolean {
  if (permissions.has(scope)) return true;
  return scope.endsWith(':read') && permissions.has('easyeda:read');
}

function configuredScopeAllowed(scope: string, configured: string): boolean {
  const normalized = configured.trim();
  if (!normalized) return false; // Fail closed for missing or malformed config.
  const scopes = new Set(normalized.split(/[\s,]+/).filter(Boolean));
  return scopes.has('*') || allowedByScope(scope, scopes);
}

function verifiedIdentityIsValid(
  identity: VerifiedOAuthTaskIdentity | undefined,
  policy: TaskAuthorizationPolicy,
): identity is VerifiedOAuthTaskIdentity {
  if (!identity || identity.kind !== 'verified-oauth' || policy.bridgeBackend !== 'local')
    return false;
  if (![identity.issuer, identity.subject, identity.clientId].every(validField)) return false;
  if (!Array.isArray(identity.scopes) || !Number.isSafeInteger(identity.expiresAtEpochSeconds))
    return false;
  return (
    identity.expiresAtEpochSeconds > (policy.nowEpochSeconds?.() ?? Math.floor(Date.now() / 1000))
  );
}

function auditedReadOnlyTool(
  tool: ReturnType<ToolRegistry['get']>,
): tool is NonNullable<ReturnType<ToolRegistry['get']>> {
  return Boolean(
    tool &&
    !tool.confirmWrite &&
    tool.risk === 'low' &&
    tool.annotations.readOnlyHint === true &&
    sideEffectForTool(tool) === 'read-only' &&
    remoteRiskForTool(tool) === 'read',
  );
}

function permittedByBothScopes(
  tool: NonNullable<ReturnType<ToolRegistry['get']>>,
  authorized: ReadonlySet<string>,
  configuredScopes: string,
): boolean {
  const requiredScopes = getRequiredToolScopes(tool);
  return (
    requiredScopes.length > 0 &&
    requiredScopes.every(
      (scope) =>
        allowedByScope(scope, authorized) && configuredScopeAllowed(scope, configuredScopes),
    )
  );
}

/** Metadata and current OAuth scope policy only; no tools are invoked here. */
export function deriveTrustedReadOnlyTaskPrincipal(
  identity: VerifiedOAuthTaskIdentity | undefined,
  policy: TaskAuthorizationPolicy,
): TrustedTaskPrincipal | undefined {
  if (!verifiedIdentityIsValid(identity, policy)) return undefined;
  const authorized = new Set(identity.scopes.filter(validField));
  const operations = new Set<SafeTaskOperation>();
  for (const operation of READ_ONLY_TASK_OPERATIONS) {
    const tool = policy.registry
      .getEnabledTools()
      .find((candidate) => candidate.name === operation);
    if (
      auditedReadOnlyTool(tool) &&
      tool &&
      permittedByBothScopes(tool, authorized, policy.configuredScopes)
    ) {
      operations.add(operation);
    }
  }
  if (operations.size === 0) return undefined;
  // Stable across token refresh, scoped to issuer, user AND OAuth client.
  // Never store raw access tokens, emails or subject claims as task owner IDs.
  const ownerId = createHash('sha256')
    .update(
      JSON.stringify([
        'easyeda-mcp-tasks-v1',
        identity.issuer,
        identity.subject,
        identity.clientId,
      ]),
    )
    .digest('hex');
  return { ownerId, allowedOperations: operations };
}

/** Validate the original tool schema at task creation, not after enqueuing. */
export function validateReadOnlyTaskArguments(
  principal: TrustedTaskPrincipal,
  policy: TaskAuthorizationPolicy,
  operation: SafeTaskOperation,
  args: unknown,
): unknown {
  if (
    !principal.allowedOperations.has(operation) ||
    !READ_ONLY_TASK_OPERATIONS.includes(operation) ||
    policy.bridgeBackend !== 'local'
  ) {
    throw new Error('Task not authorized');
  }
  const tool = policy.registry.getEnabledTools().find((entry) => entry.name === operation);
  if (!auditedReadOnlyTool(tool)) {
    throw new Error('Task not available in this profile');
  }
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    Object.keys(args).some((key) =>
      ['remoteSessionId', 'remoteApprovalId', 'confirmWrite', 'writeMode', 'ownerId'].includes(key),
    )
  )
    throw new TypeError('Unsafe task arguments');
  const parsed = tool.inputSchema.parse(args) as unknown;
  const projectId = (parsed as Record<string, unknown>).projectId;
  if (!validField(projectId) || projectId.length > 128) {
    throw new TypeError('A bounded, explicit project identity is required');
  }
  return parsed;
}

import { createHash, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Express, Request, Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { ApprovalStore, requiresApproval, type ApprovalDecision } from './approval-policy.js';
import { RemoteInvocationGrantStore } from './invocation-grants.js';
import { RemoteAuditLog } from './observability.js';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  RemoteRiskLevelSchema,
  type ApprovalRequestMessage,
  type RemoteDeploymentMode,
  type RemoteRiskLevel,
  type ToolRequestMessage,
  type ToolResponseMessage,
  ToolResponseMessageSchema,
  RelayMessageSchema,
  type RegisterSessionMessage,
} from './protocol.js';
import { type RemoteIdentity, checkRemoteScope } from './scope.js';
import {
  type ExtensionSession,
  type ManagedExtensionSession,
  RemoteSessionRouter,
} from './session-router.js';
import { SessionDispatchQueue } from './session-dispatch-queue.js';

const RouteToolRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  toolName: z.string().min(1),
  riskLevel: RemoteRiskLevelSchema,
  input: z.unknown().optional(),
  approvalId: z.string().min(1).optional(),
  deadlineMs: z.number().int().positive().optional(),
});

const CreatePairingCodeSchema = z.object({
  sessionId: z.string().min(1).optional(),
  ttlMs: z.number().int().positive().optional(),
});

const CompletePairingSchema = z.object({
  code: z.string().min(1),
  sessionId: z.string().min(1),
});

export type RemoteGatewayErrorCode =
  | 'BAD_REQUEST'
  | 'IDENTITY_MISSING'
  | 'IDENTITY_EXPIRED'
  | 'SCOPE_MISSING'
  | 'SESSION_UNPAIRED'
  | 'SESSION_DISCONNECTED'
  | 'SESSION_EXPIRED'
  | 'SESSION_AMBIGUOUS'
  | 'PROJECT_INACTIVE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_APPROVED'
  | 'APPROVAL_UI_UNAVAILABLE'
  | 'REMOTE_EXTENSION_ERROR'
  | 'REMOTE_TOOL_UNSUPPORTED'
  | 'REMOTE_EXTENSION_TIMEOUT';

// Only these dispatcher refusals are proven to precede public RPC invocation.
const ExtensionRpcRefusalCodeSchema = z.enum([
  'UNSUPPORTED_RUNTIME',
  'INVALID_PARAMS',
  'CONFIRM_WRITE_REQUIRED',
  'REMOTE_EXECUTION_NOT_ENABLED',
]);

export type RemoteGatewayFailure = {
  ok: false;
  status: number;
  code: RemoteGatewayErrorCode;
  message: string;
  approvalId?: string;
  approvalExpiresAt?: string;
  extensionRpcRefusalCode?: z.infer<typeof ExtensionRpcRefusalCodeSchema>;
};

export type RemoteGatewayToolResult =
  | {
      ok: true;
      sessionId: string;
      toolName: string;
      result: unknown;
      durationMs: number;
    }
  | RemoteGatewayFailure;

export type RemoteGatewayAuthorizationResult =
  | {
      ok: true;
      sessionId: string;
      grantId: string;
    }
  | RemoteGatewayFailure;

export type RemoteToolDispatcher = (request: ToolRequestMessage) => Promise<ToolResponseMessage>;
export type RemoteApprovalRequester = (request: ApprovalRequestMessage) => Promise<void> | void;

interface RegisteredConnection {
  sessionId: string;
  dispatch: RemoteToolDispatcher;
  requestApproval?: RemoteApprovalRequester;
  closeConnection?: () => void;
  notifyRevoked?: () => void;
}

// EasyEDA native SYS_WebSocket has no close callback and may discard a final
// message if its transport closes in the same turn. Keep only the already-
// revoked socket alive briefly so the notice can reach the extension.
const REVOKE_NOTICE_GRACE_MS = 750;

function notifyRevokedConnection(connection: RegisteredConnection | undefined): boolean {
  try {
    if (!connection?.notifyRevoked) return false;
    connection.notifyRevoked();
    return true;
  } catch {
    // Owner revocation remains final even when the transport notification fails.
    return false;
  }
}

function closeRevokedConnection(connection: RegisteredConnection | undefined): void {
  try {
    connection?.closeConnection?.();
  } catch {
    // Ownership and grants were revoked before attempting transport cleanup.
  }
}

type ResolvedRemoteConnection =
  | {
      ok: true;
      session: ExtensionSession;
      connection: RegisteredConnection;
    }
  | RemoteGatewayFailure;

/** Authenticated owner/device association implemented only in Hosted Cloud. */
export interface RemoteDeviceResumeStore {
  issue(userId: string, sessionId: string, extensionVersion: string): string;
  redeem(
    credential: string,
    nextSessionId: string,
    extensionVersion: string,
  ): { userId: string; previousSessionId: string; credential: string } | undefined;
  list(userId: string): ManagedExtensionSession[];
  revoke(userId: string, sessionId: string): boolean;
}

export interface RemoteGatewayOptions {
  router?: RemoteSessionRouter;
  resumeStore?: RemoteDeviceResumeStore;
  approvals?: ApprovalStore;
  audit?: RemoteAuditLog;
  now?: () => Date;
  makeId?: () => string;
  hashInput?: (value: unknown) => string;
  approvalTtlMs?: number;
  invocationGrantTtlMs?: number;
  projectSessionGrantTtlMs?: number;
  toolRiskResolver?: (toolName: string) => RemoteRiskLevel | undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function defaultHashInput(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value ?? null))
    .digest('hex');
}

function gatewayError(
  status: number,
  code: RemoteGatewayErrorCode,
  message: string,
  details: { approvalId?: string; approvalExpiresAt?: string } = {},
): RemoteGatewayFailure {
  return { ok: false, status, code, message, ...details };
}

class RemoteDispatchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Remote extension did not respond within ${timeoutMs}ms.`);
    this.name = 'RemoteDispatchTimeoutError';
  }
}

class RemoteSessionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super(`Remote extension session ${sessionId} became unavailable during dispatch.`);
    this.name = 'RemoteSessionUnavailableError';
  }
}

async function dispatchWithDeadline(
  dispatch: RemoteToolDispatcher,
  request: ToolRequestMessage,
): Promise<ToolResponseMessage> {
  // A client may request a shorter deadline, but it must never control the
  // allocation duration of a timer. Keep at most one bounded, fixed-delay
  // timer active, checking the monotonic elapsed time between chunks.
  const requestedTimeoutMs = request.deadlineMs;
  const timeoutMs =
    requestedTimeoutMs !== undefined &&
    Number.isSafeInteger(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? Math.min(requestedTimeoutMs, 120_000)
      : 30_000;
  const startedAt = performance.now();

  return await new Promise<ToolResponseMessage>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const checkDeadline = (): void => {
      if (settled) return;
      const remainingMs = timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        settled = true;
        reject(new RemoteDispatchTimeoutError(timeoutMs));
        return;
      }

      // These are policy-owned literal durations, not client-supplied values.
      // Larger chunks avoid one timer per millisecond during long EDA exports;
      // shorter chunks near expiry retain millisecond-level deadlines.
      if (remainingMs >= 120_000) timeout = setTimeout(checkDeadline, 120_000);
      else if (remainingMs >= 30_000) timeout = setTimeout(checkDeadline, 30_000);
      else if (remainingMs >= 10_000) timeout = setTimeout(checkDeadline, 10_000);
      else if (remainingMs >= 1_000) timeout = setTimeout(checkDeadline, 1_000);
      else if (remainingMs >= 100) timeout = setTimeout(checkDeadline, 100);
      else if (remainingMs >= 10) timeout = setTimeout(checkDeadline, 10);
      else timeout = setTimeout(checkDeadline, 1);
    };

    checkDeadline();
    void Promise.resolve()
      .then(() => dispatch(request))
      .then(
        (response) => {
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(response);
        },
        (error: unknown) => {
          settled = true;
          if (timeout) clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

function isUnsupportedRemoteMethod(code: string | undefined): boolean {
  return code === 'METHOD_NOT_ALLOWED' || code === 'METHOD_NOT_FOUND';
}

function relayExtensionFailure(
  method: string,
  error?: { code: string; message: string },
): RemoteGatewayFailure {
  if (error?.code === 'PROJECT_INACTIVE') {
    return gatewayError(
      409,
      'PROJECT_INACTIVE',
      error.message || 'EasyEDA switched projects. Select the project again.',
    );
  }
  if (isUnsupportedRemoteMethod(error?.code)) {
    return gatewayError(
      422,
      'REMOTE_TOOL_UNSUPPORTED',
      `${error?.code}: ${error?.message ?? 'Remote extension does not support this method.'}`,
    );
  }
  const failure = gatewayError(
    502,
    'REMOTE_EXTENSION_ERROR',
    error?.message ?? 'Remote extension returned an error.',
  );
  if (method === EXTENSION_RPC_METHOD) {
    const refusal = ExtensionRpcRefusalCodeSchema.safeParse(error?.code);
    if (refusal.success) return { ...failure, extensionRpcRefusalCode: refusal.data };
  }
  return failure;
}

function scopeStringToList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => scopeStringToList(item));
  return [];
}

function normalizeScope(scope: string): string {
  return scope
    .trim()
    .replace(/^easyeda:/, 'easyeda.')
    .replace('project-admin', 'project_admin');
}

export function identityFromRequest(
  req: Request,
  res: Response,
  config: EnvConfig,
): RemoteIdentity | undefined {
  const claims = res.locals.claims as Record<string, unknown> | undefined;
  if (claims) {
    const userId =
      typeof claims.sub === 'string'
        ? claims.sub
        : typeof claims.userId === 'string'
          ? claims.userId
          : undefined;
    if (!userId) return undefined;
    const scopes = new Set<string>();
    for (const claim of ['scope', 'scp', 'permissions', 'roles']) {
      for (const scope of scopeStringToList(claims[claim])) scopes.add(normalizeScope(scope));
    }
    const exp = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined;
    return { userId, scopes: [...scopes] as RemoteIdentity['scopes'], expiresAt: exp };
  }

  if (config.OAUTH_ENABLED || config.NODE_ENV === 'production') return undefined;

  const userId = req.header('x-remote-user-id');
  if (!userId) return undefined;
  const scopes = (req.header('x-remote-scopes') ?? 'easyeda.read')
    .split(/[\s,]+/)
    .map(normalizeScope)
    .filter(Boolean);
  const expiresAtHeader = req.header('x-remote-expires-at');
  const expiresAt = expiresAtHeader ? new Date(expiresAtHeader) : undefined;
  return { userId, scopes: scopes as RemoteIdentity['scopes'], expiresAt };
}

const MAX_RELAY_WEBSOCKETS = 64;
const RELAY_UPGRADE_WINDOW_MS = 60_000;

function validUpgradeHost(
  host: string | undefined,
  config: EnvConfig,
  canonicalHostedOrigin?: string,
): boolean {
  if (!host) return false;
  if (
    canonicalHostedOrigin &&
    host.toLowerCase() === new URL(canonicalHostedOrigin).host.toLowerCase()
  ) {
    return true;
  }
  const hostname = host.toLowerCase().replace(/:\d+$/, '');
  const expected = config.HTTP_HOST.toLowerCase();
  if (expected === '127.0.0.1' || expected === 'localhost' || expected === '::1') {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  }
  return hostname === expected || hostname === '127.0.0.1' || hostname === 'localhost';
}

function validUpgradeOrigin(origin: string | undefined, config: EnvConfig, path: string): boolean {
  if (!origin) return true; // Non-browser extension clients do not set Origin.
  // EasyEDA Pro 3.2.209's native SYS_WebSocket sends this Electron origin.
  // Admit it only to the paired relay; Origin never grants a user session.
  if (path === '/remote/relay' && origin === 'https://client') return true;
  if (
    config.ALLOWED_ORIGINS.split(',')
      .map((value) => value.trim())
      .includes(origin)
  )
    return true;
  if (config.CORS_ORIGIN === origin) return true;
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.HTTP_HOST)) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function allowRelayUpgradeAttempt(
  attempts: Map<string, { count: number; expiresAt: number }>,
  ip: string,
  now: number,
  rateLimit: number,
): boolean {
  // A public relay cannot retain an unbounded entry for every unique source.
  if (!attempts.has(ip) && attempts.size >= 1024) {
    for (const [address, entry] of attempts) {
      if (entry.expiresAt <= now) attempts.delete(address);
    }
    if (attempts.size >= 1024) return false;
  }
  const previous = attempts.get(ip);
  const current =
    previous && previous.expiresAt > now
      ? previous
      : { count: 0, expiresAt: now + RELAY_UPGRADE_WINDOW_MS };
  current.count += 1;
  attempts.set(ip, current);
  return current.count <= rateLimit;
}

interface SelectedProject {
  sessionId: string;
  projectKey: string;
  projectId?: string;
  documentId?: string;
  projectName?: string;
  documentType: string;
}

function hasNativeDocumentIdentity(
  required: boolean,
  project?: ExtensionSession['activeProject'],
): boolean {
  return !required || Boolean(project?.projectId && project.documentId);
}

function requestedNativeProjectId(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return (input as { projectId?: unknown }).projectId;
}

function projectIdentity(project?: ExtensionSession['activeProject']): string | undefined {
  if (project?.projectId) return `id:${project.projectId}:document:${project.documentId ?? ''}`;
  if (project?.projectName) {
    return `name:${project.documentType}:${project.projectName}:${project.url ?? ''}`;
  }
  return project?.url ? `url:${project.url}` : undefined;
}

const EXTENSION_RPC_METHOD = 'extension.rpcCall';
const EXTENSION_RPC_TOOL = 'easyeda_extension_call';

// Only the bounded, validated service selector is displayed; never include
// arbitrary service message data in the native approval dialog.
function approvalActionLabel(toolName: string, input: unknown): string | undefined {
  if (toolName !== EXTENSION_RPC_TOOL) return 'MCP tool';
  const parsed = z
    .object({ topic: z.string().regex(/^mcp\.[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/) })
    .safeParse(input);
  return parsed.success ? `MCP tool (service topic: ${parsed.data.topic})` : undefined;
}

function sessionConsentEligible(
  input: { sessionApprovalEligible?: boolean; riskLevel: RemoteRiskLevel },
  effectiveRisk: RemoteRiskLevel,
): boolean {
  return input.sessionApprovalEligible === true && effectiveRisk === input.riskLevel;
}

function extensionRpcGrantInput(input: unknown): unknown {
  // The MCP handler sends an explicit null for an omitted message.
  const parsed = z
    .object({
      topic: z.string(),
      message: z.unknown().optional(),
      timeoutMs: z.number(),
      confirmWrite: z.literal(true),
    })
    .safeParse(input);
  return parsed.success ? { ...parsed.data, message: parsed.data.message ?? null } : input;
}

const DESTRUCTIVE_TOOL_RE =
  /^(?:easyeda_execute|api\.execute)$|delete|hotswap|hot_swap|regression/i;
const WRITE_TOOL_RE = /place|add|create|set|update|write|route|apply|remove|clear/i;
const EXPORT_TOOL_RE = /export/i;

function defaultToolRiskHeuristic(toolName: string): RemoteRiskLevel | undefined {
  if (DESTRUCTIVE_TOOL_RE.test(toolName)) return 'destructive';
  if (WRITE_TOOL_RE.test(toolName)) return 'write';
  if (EXPORT_TOOL_RE.test(toolName)) return 'export';
  return undefined;
}

export class RemoteGateway {
  readonly router: RemoteSessionRouter;
  readonly approvals: ApprovalStore;
  readonly audit: RemoteAuditLog;
  private readonly connections = new Map<string, RegisteredConnection>();
  private readonly selectedProjects = new Map<string, SelectedProject>();
  private readonly resumeStore?: RemoteDeviceResumeStore;
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly hashInput: (value: unknown) => string;
  private readonly approvalTtlMs: number;
  private readonly invocationGrants: RemoteInvocationGrantStore;
  private readonly projectSessionGrantTtlMs: number;
  private readonly projectSessionGrants = new Map<string, number>();
  private readonly dispatchQueue = new SessionDispatchQueue();
  private readonly toolRiskResolver?: (toolName: string) => RemoteRiskLevel | undefined;
  private wsAttached = false;
  private relayMaxPayloadSize = 1_048_576;
  private explicitSelectionRequired = false;

  /** Called only for the first-party Hosted Cloud transport; preserves Custom Remote compatibility. */
  requireExplicitProjectSelection(): void {
    this.explicitSelectionRequired = true;
  }

  constructor(options: RemoteGatewayOptions = {}) {
    this.resumeStore = options.resumeStore;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? (() => randomUUID());
    this.hashInput = options.hashInput ?? defaultHashInput;
    this.approvalTtlMs = options.approvalTtlMs ?? 60_000;
    this.projectSessionGrantTtlMs = options.projectSessionGrantTtlMs ?? 30 * 60_000;
    this.router = options.router ?? new RemoteSessionRouter(this.now, this.makeId);
    this.approvals = options.approvals ?? new ApprovalStore();
    this.audit = options.audit ?? new RemoteAuditLog();
    this.toolRiskResolver = options.toolRiskResolver;
    this.invocationGrants = new RemoteInvocationGrantStore(
      this.makeId,
      options.invocationGrantTtlMs ?? 300_000,
    );
  }

  /** A native owner approval can cover routine changes only for one paired,
   *  authenticated client and native project. It is never a bearer credential. */
  private projectGrantKey(
    identity: RemoteIdentity,
    session: ExtensionSession,
    riskLevel: RemoteRiskLevel,
  ): string | undefined {
    if (
      !identity.clientId ||
      !session.activeProject?.projectId ||
      (riskLevel !== 'write' && riskLevel !== 'export')
    )
      return undefined;
    return JSON.stringify([
      identity.userId,
      identity.clientId,
      session.sessionId,
      session.activeProject.projectId,
      riskLevel,
    ]);
  }

  private hasProjectSessionGrant(
    identity: RemoteIdentity,
    session: ExtensionSession,
    riskLevel: RemoteRiskLevel,
    now: Date,
  ): boolean {
    const key = this.projectGrantKey(identity, session, riskLevel);
    if (!key) return false;
    const expiry = this.projectSessionGrants.get(key);
    if (expiry === undefined) return false;
    if (expiry <= now.getTime()) {
      this.projectSessionGrants.delete(key);
      return false;
    }
    return true;
  }

  private allowProjectSession(
    identity: RemoteIdentity,
    session: ExtensionSession,
    riskLevel: RemoteRiskLevel,
    now: Date,
  ): void {
    const key = this.projectGrantKey(identity, session, riskLevel);
    if (!key) return;
    // Fixed duration, no sliding renewal, bounded by the native session.
    // Token expiry is checked on every call; refreshing an OAuth token for
    // the same verified client must not force another native prompt.
    const expiry = Math.min(
      now.getTime() + this.projectSessionGrantTtlMs,
      session.expiresAt.getTime(),
    );
    if (expiry <= now.getTime()) return;
    if (this.projectSessionGrants.size >= 512) {
      for (const [entry, deadline] of this.projectSessionGrants) {
        if (deadline <= now.getTime()) this.projectSessionGrants.delete(entry);
      }
      if (this.projectSessionGrants.size >= 512) {
        const oldest = this.projectSessionGrants.keys().next().value;
        if (oldest !== undefined) this.projectSessionGrants.delete(oldest);
      }
    }
    this.projectSessionGrants.set(key, expiry);
  }

  private revokeProjectSessionGrants(sessionId: string): void {
    for (const key of this.projectSessionGrants.keys()) {
      const values = JSON.parse(key) as string[];
      if (values[2] === sessionId) this.projectSessionGrants.delete(key);
    }
  }

  private resolveOwnerSelection(
    identity: RemoteIdentity,
    requestedSessionId?: string,
  ): { ok: true; sessionId?: string } | RemoteGatewayFailure {
    const selected = this.selectedProjects.get(identity.userId);
    if (this.explicitSelectionRequired && !selected) {
      const sessions = this.listPairedExtensions(identity);
      if (sessions.length === 0) {
        return gatewayError(
          404,
          'SESSION_UNPAIRED',
          'Pair your EasyEDA extension from your Cloud account before using MCP.',
        );
      }
      if (!sessions.some((session) => session.connected)) {
        return gatewayError(
          424,
          'SESSION_DISCONNECTED',
          'Your linked EasyEDA extension is offline. Open EasyEDA and allow its existing Cloud pairing to reconnect. Generate a new pairing code only if pairing expired or was revoked.',
        );
      }
      return gatewayError(
        409,
        'PROJECT_INACTIVE',
        'Select an EasyEDA extension and its active project in your Cloud account before using MCP.',
      );
    }
    if (!selected) return { ok: true, sessionId: requestedSessionId };
    if (requestedSessionId && requestedSessionId !== selected.sessionId) {
      return gatewayError(
        403,
        'SESSION_UNPAIRED',
        'This session differs from the owner-selected EasyEDA project.',
      );
    }
    const current = this.router.getSession(selected.sessionId);
    if (!current || current.userId !== identity.userId) {
      // A resumed extension has a different session ID: do not silently carry
      // the previous project's authorization over to the new connection.
      // Give the owner the actual recovery action only if one of their own
      // connected devices is visible. Other owners' devices never qualify.
      const replacementAvailable = this.listPairedExtensions(identity).some(
        (session) => session.connected && session.sessionId !== selected.sessionId,
      );
      if (replacementAvailable) {
        return gatewayError(
          409,
          'PROJECT_INACTIVE',
          'Your previous EasyEDA session is unavailable. Select the open schematic or PCB on your connected device in Cloud; no new pairing code is needed.',
        );
      }
      return gatewayError(404, 'SESSION_UNPAIRED', 'Selected EasyEDA session is unavailable.');
    }
    if (projectIdentity(current.activeProject) !== selected.projectKey) {
      return gatewayError(
        409,
        'PROJECT_INACTIVE',
        'The EasyEDA active project changed. Select the project again in Cloud.',
      );
    }
    return { ok: true, sessionId: selected.sessionId };
  }

  /** Hosted MCP calls must not relabel selected-editor data as a different project.
   * The owner-selected native project is the authority, never a tool argument. */
  private selectedProjectArgumentFailure(
    session: ExtensionSession,
    input: unknown,
  ): RemoteGatewayFailure | undefined {
    const projectId = requestedNativeProjectId(input);
    if (
      !this.explicitSelectionRequired ||
      projectId === undefined ||
      projectId === session.activeProject?.projectId
    ) {
      return undefined;
    }
    return gatewayError(
      409,
      'PROJECT_INACTIVE',
      'The requested EasyEDA project differs from your Cloud-selected project. Select the intended design before retrying.',
    );
  }

  private resolveProjectBoundConnection(input: {
    identity: RemoteIdentity;
    sessionId?: string;
    riskLevel: RemoteRiskLevel;
    toolInput?: unknown;
  }): ResolvedRemoteConnection {
    const route = this.resolveConnection(input);
    if (!route.ok) return route;
    return this.selectedProjectArgumentFailure(route.session, input.toolInput) ?? route;
  }

  private resolveEffectiveRisk(toolName: string, assertedRisk?: RemoteRiskLevel): RemoteRiskLevel {
    if (toolName === EXTENSION_RPC_METHOD || toolName === EXTENSION_RPC_TOOL) return 'destructive';
    const intrinsic = this.toolRiskResolver?.(toolName) ?? defaultToolRiskHeuristic(toolName);
    if (!intrinsic) return assertedRisk ?? 'read';
    const rank: Record<RemoteRiskLevel, number> = { read: 0, export: 1, write: 2, destructive: 3 };
    if (!assertedRisk || rank[intrinsic] > rank[assertedRisk]) {
      return intrinsic;
    }
    return assertedRisk;
  }

  private resolveConnection(input: {
    identity: RemoteIdentity;
    sessionId?: string;
    riskLevel: RemoteRiskLevel;
  }): ResolvedRemoteConnection {
    const selection = this.resolveOwnerSelection(input.identity, input.sessionId);
    if (!selection.ok) return selection;
    const route = this.router.resolve({
      userId: input.identity.userId,
      riskLevel: input.riskLevel,
      sessionId: selection.sessionId,
    });
    if (!route.ok) {
      const status =
        route.code === 'SESSION_AMBIGUOUS' ? 409 : route.code === 'SESSION_EXPIRED' ? 410 : 404;
      return gatewayError(status, route.code, route.message);
    }

    const connection = this.connections.get(route.session.sessionId);
    if (!connection) {
      this.router.disconnect(route.session.sessionId);
      this.approvals.deleteForSession(route.session.sessionId);
      return gatewayError(424, 'SESSION_DISCONNECTED', 'Paired EasyEDA extension is disconnected.');
    }
    return { ok: true, session: route.session, connection };
  }

  private async requestRemoteApproval(input: {
    identity: RemoteIdentity;
    session: ExtensionSession;
    connection: RegisteredConnection;
    toolName: string;
    riskLevel: RemoteRiskLevel;
    inputHash: string;
    now: Date;
    actionLabel: string;
    retryMessage: string;
    sessionApprovalEligible?: boolean;
  }): Promise<RemoteGatewayFailure> {
    if (!input.connection.requestApproval) {
      return gatewayError(
        424,
        'APPROVAL_UI_UNAVAILABLE',
        'The paired EasyEDA extension does not expose an approval UI.',
      );
    }

    const existing = this.approvals.findPending({
      userId: input.identity.userId,
      clientId: input.identity.clientId,
      activeProject: input.session.activeProject,
      sessionId: input.session.sessionId,
      toolName: input.toolName,
      inputHash: input.inputHash,
      now: input.now,
    });
    const approvalId = existing?.approvalId ?? `appr_${this.makeId()}`;
    const expiresAt = existing?.expiresAt ?? new Date(input.now.getTime() + this.approvalTtlMs);

    if (!existing) {
      const actionSummary = `${input.riskLevel} ${input.actionLabel} ${input.toolName}${
        input.session.activeProject?.projectName
          ? ` on ${input.session.activeProject.projectName}`
          : ''
      }${
        input.sessionApprovalEligible &&
        this.projectGrantKey(input.identity, input.session, input.riskLevel)
          ? `. Approve routine ${input.riskLevel} actions from this MCP client on this project for 30 minutes; destructive actions always need a separate approval.`
          : ''
      }`;
      this.approvals.request({
        approvalId,
        userId: input.identity.userId,
        clientId: input.identity.clientId,
        allowsProjectSession: Boolean(
          input.sessionApprovalEligible &&
          this.projectGrantKey(input.identity, input.session, input.riskLevel),
        ),
        sessionId: input.session.sessionId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        inputHash: input.inputHash,
        actionSummary,
        activeProject: input.session.activeProject,
        expiresAt,
      });
      const approvalRequest: ApprovalRequestMessage = {
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'approval_request',
        messageId: `msg_${this.makeId()}`,
        sessionId: input.session.sessionId,
        timestamp: input.now.toISOString(),
        approvalId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        actionSummary,
        inputHash: input.inputHash,
        activeProject: input.session.activeProject,
        expiresAt: expiresAt.toISOString(),
      };
      try {
        await input.connection.requestApproval(approvalRequest);
      } catch (error) {
        this.approvals.delete(approvalId);
        return gatewayError(
          502,
          'REMOTE_EXTENSION_ERROR',
          error instanceof Error ? error.message : String(error),
        );
      }
      this.audit.record({
        event: 'remote.approval.requested',
        mode: input.session.mode,
        userId: input.identity.userId,
        sessionId: input.session.sessionId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        inputHash: input.inputHash,
      });
    }

    return gatewayError(403, 'APPROVAL_REQUIRED', input.retryMessage, {
      approvalId,
      approvalExpiresAt: expiresAt.toISOString(),
    });
  }

  private consumeRemoteApproval(input: {
    approvalId: string;
    identity: RemoteIdentity;
    session: ExtensionSession;
    toolName: string;
    inputHash: string;
    now: Date;
    mismatchTarget: string;
  }): RemoteGatewayFailure | undefined {
    const record = this.approvals.get(input.approvalId);
    const approved = this.approvals.consumeApproved({
      approvalId: input.approvalId,
      userId: input.identity.userId,
      clientId: input.identity.clientId,
      activeProject: input.session.activeProject,
      sessionId: input.session.sessionId,
      toolName: input.toolName,
      inputHash: input.inputHash,
      now: input.now,
    });
    if (approved) return undefined;

    const message = !record
      ? 'Remote approval is missing or invalid.'
      : record.expiresAt.getTime() <= input.now.getTime() || record.decision === 'timeout'
        ? 'Remote approval expired.'
        : record.decision === 'rejected'
          ? 'Remote approval was rejected by the user.'
          : record.decision === undefined
            ? 'Remote approval is still pending user action.'
            : `Remote approval does not match this user, session, ${input.mismatchTarget}, or input.`;
    return gatewayError(403, 'APPROVAL_NOT_APPROVED', message, {
      approvalId: input.approvalId,
      approvalExpiresAt: record?.expiresAt.toISOString(),
    });
  }

  registerExtension(input: {
    connectionId: string;
    mode: Exclude<RemoteDeploymentMode, 'local'>;
    extensionVersion: string;
    activeProject?: ExtensionSession['activeProject'];
    ttlMs?: number;
    dispatch: RemoteToolDispatcher;
    requestApproval?: RemoteApprovalRequester;
    closeConnection?: () => void;
    notifyRevoked?: () => void;
    pairingCode?: string;
  }): ExtensionSession {
    const session = this.router.registerSession(input);
    this.connections.set(session.sessionId, {
      sessionId: session.sessionId,
      dispatch: input.dispatch,
      requestApproval: input.requestApproval,
      closeConnection: input.closeConnection,
      notifyRevoked: input.notifyRevoked,
    });
    if (input.pairingCode) this.router.completePairingByCode(input.pairingCode, session.sessionId);
    this.audit.record({
      event: 'remote.session.registered',
      mode: session.mode,
      sessionId: session.sessionId,
      connectionId: session.connectionId,
    });
    if (session.userId) {
      this.audit.record({
        event: 'remote.session.paired',
        mode: session.mode,
        userId: session.userId,
        sessionId: session.sessionId,
      });
    }
    return session;
  }

  createPairingCode(input: {
    identity: RemoteIdentity;
    sessionId?: string;
    ttlMs?: number;
  }): string {
    return this.router.createPairingCode({
      userId: input.identity.userId,
      sessionId: input.sessionId,
      ttlMs: input.ttlMs,
    });
  }

  completePairing(input: { identity: RemoteIdentity; code: string; sessionId: string }): boolean {
    const paired = this.router.completePairing({
      code: input.code,
      userId: input.identity.userId,
      sessionId: input.sessionId,
    });
    const session = this.router.getSession(input.sessionId);
    if (paired && session) {
      this.audit.record({
        event: 'remote.session.paired',
        mode: session.mode,
        userId: input.identity.userId,
        sessionId: input.sessionId,
      });
    }
    return paired;
  }

  /**
   * Owner-scoped, read-only readiness check for MCP diagnostics.
   * A working HTTP/OAuth connection is NOT proof that a usable EasyEDA editor
   * is paired, online and (in Hosted Cloud) selected for this owner.
   * Do not mutate the session router or dispatch a native call here.
   */
  hasRoutableSession(identity?: RemoteIdentity, sessionId?: string): boolean {
    if (!identity || !checkRemoteScope(identity, 'read', this.now()).ok) return false;
    const selected = this.resolveOwnerSelection(identity, sessionId);
    if (!selected.ok) return false;
    const route = this.router.resolve({
      userId: identity.userId,
      riskLevel: 'read',
      sessionId: selected.sessionId,
    });
    return route.ok && this.connections.has(route.session.sessionId);
  }

  /**
   * A resume identifies the extension's owner only. It never restores OAuth
   * grants, an owner-selected native document, or pending write approvals.
   */
  private issueOrResumeHostedDevice(
    session: ExtensionSession,
    pairingCode?: string,
    resumeCredential?: string,
  ): string | undefined {
    const store = this.resumeStore;
    if (!store || session.mode !== 'hosted') return undefined;
    if (session.userId && pairingCode) {
      return store.issue(session.userId, session.sessionId, session.extensionVersion);
    }
    if (session.userId || !resumeCredential) return undefined;
    const resumed = store.redeem(resumeCredential, session.sessionId, session.extensionVersion);
    if (!resumed) return undefined;
    if (!this.router.bindResumedOwner(session.sessionId, resumed.userId)) {
      throw new Error('A verified device association could not be bound to the relay.');
    }
    this.invalidatePreviousResumedSession(resumed.previousSessionId, session.sessionId);
    this.audit.record({
      event: 'remote.session.paired',
      mode: session.mode,
      userId: resumed.userId,
      sessionId: session.sessionId,
    });
    return resumed.credential;
  }

  private invalidatePreviousResumedSession(previousSessionId: string, nextSessionId: string): void {
    if (previousSessionId === nextSessionId) return;
    const closeOld = this.connections.get(previousSessionId)?.closeConnection;
    this.disconnect(previousSessionId);
    this.router.forgetSession(previousSessionId);
    try {
      closeOld?.();
    } catch {
      // Revocation already invalidated any former approvals and grants.
    }
  }

  listPairedExtensions(identity: RemoteIdentity): ManagedExtensionSession[] {
    const live = this.router.listPairedSessions(identity.userId);
    if (!this.resumeStore) return live;
    // Show durable *offline* owner devices for revocation, without carrying
    // native document selection across a restart.
    const durable = this.resumeStore.list(identity.userId);
    const authorized = new Set(durable.map((entry) => entry.sessionId));
    const visible = live.filter(
      (session) => session.mode !== 'hosted' || authorized.has(session.sessionId),
    );
    const present = new Set(visible.map((session) => session.sessionId));
    return [...visible, ...durable.filter((session) => !present.has(session.sessionId))];
  }

  /** An explicit selection pins both extension session and its active project identity. */
  selectPairedProject(identity: RemoteIdentity, sessionId: string): boolean {
    const session = this.router.getSession(sessionId);
    const projectKey = projectIdentity(session?.activeProject);
    if (
      !session ||
      session.userId !== identity.userId ||
      // Hosted Cloud cannot authorize a title-only/URL-only project claim:
      // native document + parent project UUIDs are required at selection.
      !hasNativeDocumentIdentity(this.explicitSelectionRequired, session.activeProject) ||
      !session.connected ||
      session.expiresAt.getTime() <= this.now().getTime() ||
      !projectKey
    ) {
      return false;
    }
    const previousSelection = this.selectedProjects.get(identity.userId);
    // Explicitly selecting even the same project starts a fresh native consent epoch.
    if (previousSelection) this.revokeProjectSessionGrants(previousSelection.sessionId);
    this.selectedProjects.set(identity.userId, {
      sessionId,
      projectKey,
      projectId: session.activeProject?.projectId,
      documentId: session.activeProject?.documentId,
      projectName: session.activeProject?.projectName,
      documentType: session.activeProject?.documentType ?? 'unknown',
    });
    return true;
  }

  getSelectedProject(identity: RemoteIdentity): Omit<SelectedProject, 'projectKey'> | undefined {
    const selection = this.selectedProjects.get(identity.userId);
    if (!selection) return undefined;
    const session = this.router.getSession(selection.sessionId);
    // Keep the durable device association revocable, but never advertise an
    // expired/disconnected session as an authorized selected document.
    if (
      !session ||
      session.userId !== identity.userId ||
      !session.connected ||
      session.expiresAt.getTime() <= this.now().getTime() ||
      projectIdentity(session.activeProject) !== selection.projectKey
    )
      return undefined;
    const { projectKey: _key, ...publicSelection } = selection;
    return publicSelection;
  }

  revokePairedExtension(identity: RemoteIdentity, sessionId: string): boolean {
    const session = this.router.getSession(sessionId);
    // Missing and another owner's session must be indistinguishable to callers.
    if (!session || session.userId !== identity.userId) {
      // A restart leaves the owner-bound device association offline, but it
      // must remain revocable before the next auto-resume attempt.
      return this.resumeStore?.revoke(identity.userId, sessionId) ?? false;
    }
    if (
      session.mode === 'hosted' &&
      this.resumeStore &&
      !this.resumeStore.revoke(identity.userId, sessionId)
    )
      return false;
    const connection = this.connections.get(sessionId);
    this.disconnect(sessionId);
    this.router.forgetSession(sessionId);
    if (this.selectedProjects.get(identity.userId)?.sessionId === sessionId) {
      this.selectedProjects.delete(identity.userId);
    }
    this.audit.record({
      event: 'remote.session.revoked',
      mode: session.mode,
      userId: identity.userId,
      sessionId,
    });
    if (notifyRevokedConnection(connection)) {
      // The session is already unroutable: this delay grants no access.
      // Native clients get one event-loop interval to process SESSION_REVOKED.
      const timer = setTimeout(() => closeRevokedConnection(connection), REVOKE_NOTICE_GRACE_MS);
      timer.unref();
    } else {
      closeRevokedConnection(connection);
    }
    return true;
  }

  disconnect(sessionId: string): void {
    const session = this.router.getSession(sessionId);
    this.router.disconnect(sessionId);
    this.connections.delete(sessionId);
    this.approvals.deleteForSession(sessionId);
    this.invocationGrants.deleteForSession(sessionId);
    this.revokeProjectSessionGrants(sessionId);
    if (session) {
      this.audit.record({
        event: 'remote.session.disconnected',
        mode: session.mode,
        userId: session.userId,
        sessionId,
      });
    }
  }

  private quarantineSession(sessionId: string): void {
    const closeConnection = this.connections.get(sessionId)?.closeConnection;
    this.disconnect(sessionId);
    try {
      closeConnection?.();
    } catch {
      // The route is already removed. A socket-close failure must not make the
      // quarantined session routable again.
    }
  }

  resolveApprovalFromExtension(input: {
    sessionId: string;
    approvalId: string;
    result: ApprovalDecision;
  }): boolean {
    const record = this.approvals.get(input.approvalId);
    const session = this.router.getSession(input.sessionId);
    if (!record || !session || record.sessionId !== input.sessionId) return false;
    const resolved = this.approvals.resolve(input.approvalId, input.result, this.now());
    if (!resolved) return false;
    this.audit.record({
      event: 'remote.approval.resolved',
      mode: session.mode,
      userId: record.userId,
      sessionId: input.sessionId,
      toolName: record.toolName,
      riskLevel: record.riskLevel,
      inputHash: record.inputHash,
      status:
        resolved.decision === 'approved'
          ? 'ok'
          : resolved.decision === 'timeout'
            ? 'timeout'
            : 'rejected',
    });
    return true;
  }

  private invocationGrantHash(toolName: string, input: unknown, originalHash: string): string {
    return toolName === EXTENSION_RPC_TOOL
      ? this.hashInput(extensionRpcGrantInput(input))
      : originalHash;
  }

  async authorizeToolInvocation(input: {
    identity?: RemoteIdentity;
    sessionId?: string;
    toolName: string;
    riskLevel: Exclude<RemoteRiskLevel, 'read'>;
    input?: unknown;
    approvalId?: string;
    /** Trusted tool-registry metadata, never a client-supplied MCP argument. */
    sessionApprovalEligible?: boolean;
  }): Promise<RemoteGatewayAuthorizationResult> {
    const effectiveRisk = this.resolveEffectiveRisk(input.toolName, input.riskLevel);
    const scope = checkRemoteScope(input.identity, effectiveRisk, this.now());
    if (!scope.ok) {
      return gatewayError(scope.code === 'SCOPE_MISSING' ? 403 : 401, scope.code, scope.message);
    }
    const identity = input.identity;
    if (!identity) return gatewayError(401, 'IDENTITY_MISSING', 'Remote identity is required.');

    const route = this.resolveProjectBoundConnection({
      identity,
      riskLevel: effectiveRisk,
      sessionId: input.sessionId,
      toolInput: input.input,
    });
    if (!route.ok) return route;

    const actionLabel = approvalActionLabel(input.toolName, input.input);
    if (!actionLabel) return gatewayError(400, 'BAD_REQUEST', 'Invalid extension RPC topic.');
    const now = this.now();
    const inputHash = this.hashInput(input.input);
    // A caller may assert a lower risk than the server-resolved tool policy.
    // A temporary native grant can never lower the effective risk tier.
    const consentEligible = sessionConsentEligible(input, effectiveRisk);
    const reusable = Boolean(
      consentEligible && this.hasProjectSessionGrant(identity, route.session, effectiveRisk, now),
    );
    if (!input.approvalId && !reusable) {
      return await this.requestRemoteApproval({
        identity,
        session: route.session,
        connection: route.connection,
        toolName: input.toolName,
        riskLevel: effectiveRisk,
        inputHash,
        now,
        actionLabel,
        sessionApprovalEligible: consentEligible,
        retryMessage:
          'Approval was requested in EasyEDA. Retry the same MCP tool call with remoteApprovalId after the user decides.',
      });
    }

    if (input.approvalId) {
      const nativeApproval = this.approvals.get(input.approvalId);
      const approvalFailure = this.consumeRemoteApproval({
        approvalId: input.approvalId,
        identity,
        session: route.session,
        toolName: input.toolName,
        inputHash,
        now,
        mismatchTarget: 'MCP tool',
      });
      if (approvalFailure) return approvalFailure;
      if (
        consentEligible &&
        nativeApproval?.allowsProjectSession &&
        nativeApproval.clientId === identity.clientId
      ) {
        this.allowProjectSession(identity, route.session, effectiveRisk, now);
      }
    }

    const grantId = this.invocationGrants.issue(
      {
        userId: identity.userId,
        sessionId: route.session.sessionId,
        toolName: input.toolName,
        riskLevel: effectiveRisk,
        inputHash: this.invocationGrantHash(input.toolName, input.input, inputHash),
      },
      now,
    );
    return { ok: true, sessionId: route.session.sessionId, grantId };
  }

  revokeInvocationGrant(grantId: string): boolean {
    return this.invocationGrants.revoke(grantId);
  }

  private validateDispatchGrant(
    input: {
      grantId: string;
      userId: string;
      sessionId: string;
      riskLevel: RemoteRiskLevel;
      toolName: string;
      input?: unknown;
    },
    now: Date,
  ): boolean {
    if (input.toolName !== EXTENSION_RPC_METHOD) {
      return this.invocationGrants.validate(
        {
          grantId: input.grantId,
          userId: input.userId,
          sessionId: input.sessionId,
          riskLevel: input.riskLevel,
        },
        now,
      );
    }
    const valid = this.invocationGrants.validate(
      {
        grantId: input.grantId,
        userId: input.userId,
        sessionId: input.sessionId,
        riskLevel: input.riskLevel,
        toolName: EXTENSION_RPC_TOOL,
        inputHash: this.hashInput(extensionRpcGrantInput(input.input)),
      },
      now,
    );
    // RPC is one external action, never a reusable multi-method grant.
    return valid && this.invocationGrants.revoke(input.grantId);
  }

  private rejectRawExtensionRpc(
    toolName: string,
    grantId?: string,
  ): RemoteGatewayFailure | undefined {
    if (toolName === EXTENSION_RPC_METHOD && !grantId) {
      return gatewayError(
        403,
        'APPROVAL_NOT_APPROVED',
        'Extension RPC requires the allowlisted MCP tool invocation; direct relay dispatch is disabled.',
      );
    }
    return undefined;
  }

  private dispatchScopeFailure(
    input: { identity?: RemoteIdentity; sessionId?: string; toolName: string },
    effectiveRisk: RemoteRiskLevel,
  ): RemoteGatewayFailure | undefined {
    const scope = checkRemoteScope(input.identity, effectiveRisk, this.now());
    if (!scope.ok) {
      this.audit.record({
        event: 'remote.identity.rejected',
        mode: 'hosted',
        userId: input.identity?.userId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        riskLevel: effectiveRisk,
        status: 'rejected',
        errorCode: scope.code,
      });
      return gatewayError(scope.code === 'SCOPE_MISSING' ? 403 : 401, scope.code, scope.message);
    }
    return undefined;
  }

  async routeToolRequest(input: {
    identity?: RemoteIdentity;
    sessionId?: string;
    toolName: string;
    riskLevel: RemoteRiskLevel;
    input?: unknown;
    approvalId?: string;
    grantId?: string;
    deadlineMs?: number;
  }): Promise<RemoteGatewayToolResult> {
    const effectiveRisk = this.resolveEffectiveRisk(input.toolName, input.riskLevel);
    const scopeFailure = this.dispatchScopeFailure(input, effectiveRisk);
    if (scopeFailure) return scopeFailure;

    const identity = input.identity;
    if (!identity) {
      return gatewayError(401, 'IDENTITY_MISSING', 'Remote identity is required.');
    }

    const rawRpcFailure = this.rejectRawExtensionRpc(input.toolName, input.grantId);
    if (rawRpcFailure) return rawRpcFailure;
    const route = this.resolveProjectBoundConnection({
      identity,
      riskLevel: effectiveRisk,
      sessionId: input.sessionId,
      toolInput: input.input,
    });
    if (!route.ok) return route;
    const connection = route.connection;

    const now = this.now();
    const inputHash = this.hashInput(input.input);
    if (requiresApproval(effectiveRisk)) {
      if (input.grantId) {
        const validGrant = this.validateDispatchGrant(
          {
            grantId: input.grantId,
            userId: identity.userId,
            sessionId: route.session.sessionId,
            riskLevel: effectiveRisk,
            toolName: input.toolName,
            input: input.input,
          },
          now,
        );
        if (!validGrant) {
          return gatewayError(
            403,
            'APPROVAL_NOT_APPROVED',
            'Remote invocation grant is missing, expired, or does not match this session.',
          );
        }
      } else if (!input.approvalId) {
        return await this.requestRemoteApproval({
          identity,
          session: route.session,
          connection,
          toolName: input.toolName,
          riskLevel: effectiveRisk,
          inputHash,
          now,
          actionLabel: 'action',
          retryMessage:
            'Approval was requested in EasyEDA. Retry with remoteApprovalId after the user decides.',
        });
      }

      if (!input.grantId) {
        const approvalId = input.approvalId;
        if (!approvalId) {
          return gatewayError(403, 'APPROVAL_NOT_APPROVED', 'Remote approval id is required.');
        }
        const approvalFailure = this.consumeRemoteApproval({
          approvalId,
          identity,
          session: route.session,
          toolName: input.toolName,
          inputHash,
          now,
          mismatchTarget: 'method',
        });
        if (approvalFailure) return approvalFailure;
      }
    }

    const request: ToolRequestMessage = {
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      type: 'tool_request',
      messageId: `msg_${this.makeId()}`,
      sessionId: route.session.sessionId,
      timestamp: this.now().toISOString(),
      toolName: input.toolName,
      riskLevel: effectiveRisk,
      requiresApproval: requiresApproval(effectiveRisk),
      input: input.input,
      inputHash,
      activeProjectHint: route.session.activeProject,
      deadlineMs: input.deadlineMs,
    };

    this.audit.record({
      event: 'remote.tool.requested',
      mode: route.session.mode,
      userId: identity.userId,
      sessionId: route.session.sessionId,
      toolName: input.toolName,
      riskLevel: effectiveRisk,
      inputHash,
    });

    const startedAt = Date.now();
    try {
      const response = ToolResponseMessageSchema.parse(
        await this.dispatchQueue.run(route.session.sessionId, async () => {
          if (this.connections.get(route.session.sessionId) !== connection) {
            throw new RemoteSessionUnavailableError(route.session.sessionId);
          }
          this.audit.record({
            event: 'remote.tool.dispatched',
            mode: route.session.mode,
            userId: identity.userId,
            sessionId: route.session.sessionId,
            toolName: input.toolName,
            riskLevel: input.riskLevel,
            inputHash,
          });
          try {
            return await dispatchWithDeadline(connection.dispatch, request);
          } catch (error) {
            if (error instanceof RemoteDispatchTimeoutError) {
              // The extension may still be executing after the caller's deadline. Quarantine
              // this session before releasing the per-session queue so no later request can
              // overlap with an operation whose final state is unknown.
              this.quarantineSession(route.session.sessionId);
            }
            throw error;
          }
        }),
      );
      if (!response.ok) {
        this.audit.record({
          event: 'remote.tool.failed',
          mode: route.session.mode,
          userId: identity.userId,
          sessionId: route.session.sessionId,
          toolName: input.toolName,
          riskLevel: input.riskLevel,
          inputHash,
          status: 'error',
          errorCode: response.error?.code ?? 'REMOTE_EXTENSION_ERROR',
          durationMs: Date.now() - startedAt,
        });
        return relayExtensionFailure(input.toolName, response.error);
      }
      this.audit.record({
        event: 'remote.tool.completed',
        mode: route.session.mode,
        userId: identity.userId,
        sessionId: route.session.sessionId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        inputHash,
        status: 'ok',
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        sessionId: route.session.sessionId,
        toolName: input.toolName,
        result: response.result,
        durationMs: response.durationMs,
      };
    } catch (error) {
      const timedOut = error instanceof RemoteDispatchTimeoutError;
      const sessionUnavailable = error instanceof RemoteSessionUnavailableError;
      const errorCode: RemoteGatewayErrorCode = sessionUnavailable
        ? 'SESSION_DISCONNECTED'
        : timedOut
          ? 'REMOTE_EXTENSION_TIMEOUT'
          : 'REMOTE_EXTENSION_ERROR';
      this.audit.record({
        event: 'remote.tool.failed',
        mode: route.session.mode,
        userId: identity.userId,
        sessionId: route.session.sessionId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        inputHash,
        status: 'error',
        errorCode,
        durationMs: Date.now() - startedAt,
      });
      return gatewayError(
        sessionUnavailable ? 424 : timedOut ? 504 : 502,
        errorCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  registerHttpRoutes(app: Express, config: EnvConfig): void {
    const manageIdentity = (req: Request, res: Response): RemoteIdentity | undefined => {
      const identity = identityFromRequest(req, res, config);
      const result = checkRemoteScope(identity, 'read');
      if (!result.ok) {
        res.status(result.code === 'SCOPE_MISSING' ? 403 : 401).json({
          ok: false,
          code: result.code,
          message: result.message,
        });
        return undefined;
      }
      return identity;
    };

    app.get('/remote/sessions', (req: Request, res: Response) => {
      const identity = manageIdentity(req, res);
      if (!identity) return;
      res.json({ ok: true, sessions: this.listPairedExtensions(identity) });
    });

    app.delete('/remote/sessions/:sessionId', (req: Request, res: Response) => {
      const identity = manageIdentity(req, res);
      if (!identity) return;
      const target = z
        .string()
        .regex(/^sess_[a-zA-Z0-9_-]{1,100}$/)
        .safeParse(req.params.sessionId);
      if (!target.success || !this.revokePairedExtension(identity, target.data)) {
        res
          .status(404)
          .json({ ok: false, code: 'SESSION_UNPAIRED', message: 'Session not found.' });
        return;
      }
      res.status(204).end();
    });

    app.post('/remote/pairing-codes', (req: Request, res: Response) => {
      const identity = identityFromRequest(req, res, config);
      if (!identity) {
        res
          .status(401)
          .json({ ok: false, code: 'IDENTITY_MISSING', message: 'Remote identity is required.' });
        return;
      }
      const body = CreatePairingCodeSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ ok: false, code: 'BAD_REQUEST', issues: body.error.issues });
        return;
      }
      const pairingCode = this.createPairingCode({ identity, ...body.data });
      res.json({ ok: true, pairingCode });
    });

    app.post('/remote/pairings', (req: Request, res: Response) => {
      const identity = identityFromRequest(req, res, config);
      if (!identity) {
        res
          .status(401)
          .json({ ok: false, code: 'IDENTITY_MISSING', message: 'Remote identity is required.' });
        return;
      }
      const body = CompletePairingSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ ok: false, code: 'BAD_REQUEST', issues: body.error.issues });
        return;
      }
      const paired = this.completePairing({ identity, ...body.data });
      res.status(paired ? 200 : 409).json({ ok: paired, paired });
    });

    app.post('/remote/tool-requests', async (req: Request, res: Response) => {
      const body = RouteToolRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ ok: false, code: 'BAD_REQUEST', issues: body.error.issues });
        return;
      }
      const result = await this.routeToolRequest({
        identity: identityFromRequest(req, res, config),
        ...body.data,
      });
      res.status(result.ok ? 200 : result.status).json(result);
    });

    app.get('/remote/audit', (req: Request, res: Response) => {
      const identity = identityFromRequest(req, res, config);
      const scope = checkRemoteScope(identity, 'destructive');
      if (!scope.ok) {
        res.status(scope.code === 'SCOPE_MISSING' ? 403 : 401).json(scope);
        return;
      }
      res.json({ ok: true, events: this.audit.recent(100) });
    });
  }

  attachWebSocketServer(
    server: HttpServer,
    config?: EnvConfig,
    canonicalHostedOrigin?: string,
  ): void {
    if (this.wsAttached) return;
    this.wsAttached = true;
    this.relayMaxPayloadSize = config?.BRIDGE_MAX_PAYLOAD_SIZE ?? 1_048_576;
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.relayMaxPayloadSize,
    });
    const attempts = new Map<string, { count: number; expiresAt: number }>();

    server.on('upgrade', (request, socket, head) => {
      const path = parseUpgradePath(request);
      if (path !== '/remote/relay' && path !== '/session') return;
      const reject = (status: number, reason: string) => {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      };
      if (config && !validUpgradeHost(request.headers.host, config, canonicalHostedOrigin)) {
        reject(400, 'Bad Request');
        return;
      }
      if (config && !validUpgradeOrigin(request.headers.origin, config, path)) {
        reject(403, 'Forbidden');
        return;
      }
      if (
        !allowRelayUpgradeAttempt(
          attempts,
          request.socket.remoteAddress ?? 'unknown',
          Date.now(),
          config?.HTTP_RATE_LIMIT_MAX ?? 100,
        ) ||
        wss.clients.size >= MAX_RELAY_WEBSOCKETS
      ) {
        reject(429, 'Too Many Requests');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws) => {
      ws.on('error', (error: Error & { code?: string }) => {
        getLogger().warn({ code: error.code }, 'relay WebSocket rejected invalid frame');
      });
      this.handleRelaySocket(ws);
    });
  }

  private handleRelaySocket(ws: WebSocket): void {
    const connectionId = `conn_${this.makeId()}`;
    let sessionId: string | undefined;
    const pending = new Map<
      string,
      { resolve: (response: ToolResponseMessage) => void; reject: (error: Error) => void }
    >();

    const send = (payload: Record<string, unknown>) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          messageId: `msg_${this.makeId()}`,
          sessionId,
          timestamp: this.now().toISOString(),
          ...payload,
        }),
      );
    };

    const rejectPending = (error: Error): void => {
      for (const handler of pending.values()) handler.reject(error);
      pending.clear();
    };

    const disconnectCurrentSession = (): void => {
      const currentSessionId = sessionId;
      if (!currentSessionId) return;
      this.disconnect(currentSessionId);
      rejectPending(new RemoteSessionUnavailableError(currentSessionId));
      sessionId = undefined;
    };

    const messageMatchesCurrentSession = (messageSessionId: string | undefined): boolean => {
      if (messageSessionId === sessionId) return true;
      send({
        type: 'error',
        code: 'SESSION_MISMATCH',
        message: 'Relay message sessionId does not match the active socket session.',
      });
      return false;
    };

    const handleHeartbeat = (heartbeat: {
      sessionId?: string;
      source?: string;
      activeProject?: ExtensionSession['activeProject'] | null;
    }) => {
      if (!sessionId || !messageMatchesCurrentSession(heartbeat.sessionId)) return;
      // A live WebSocket can outlive its immutable session TTL. Close it so an
      // extension with an owner-bound resume credential can reconnect through
      // the normal authenticated handshake; never silently extend an expired grant.
      if (!this.router.heartbeat(sessionId)) {
        send({
          type: 'error',
          code: 'SESSION_EXPIRED',
          message: 'Cloud relay session expired. Reconnect with valid device access.',
        });
        disconnectCurrentSession();
        ws.close(1000, 'session_expired');
        return;
      }
      if (Object.hasOwn(heartbeat, 'activeProject')) {
        const previousProject = this.router.getSession(sessionId)?.activeProject?.projectId;
        const incomingProject = heartbeat.activeProject?.projectId;
        if (previousProject !== incomingProject) this.revokeProjectSessionGrants(sessionId);
        this.router.updateActiveProject(sessionId, heartbeat.activeProject ?? undefined);
      }
      // Only acknowledge extension-sourced heartbeats, never acknowledgements.
      if (heartbeat.source === 'extension') send({ type: 'heartbeat', source: 'server' });
    };

    const dispatch: RemoteToolDispatcher = async (request) => {
      if (ws.readyState !== ws.OPEN) {
        throw new RemoteSessionUnavailableError(request.sessionId);
      }
      ws.send(JSON.stringify(request));
      return await new Promise<ToolResponseMessage>((resolve, reject) => {
        pending.set(request.messageId, { resolve, reject });
      });
    };

    const handleRegistration = (
      registration: RegisterSessionMessage,
      record: Record<string, unknown>,
    ): void => {
      const pairingCode = typeof record.pairingCode === 'string' ? record.pairingCode : undefined;
      const resumeCredential =
        typeof registration.resumeCredential === 'string'
          ? registration.resumeCredential
          : undefined;
      // A client must choose precisely one association mechanism. A resume
      // credential never weakens one-time pairing or origin restrictions.
      if (pairingCode && resumeCredential) {
        send({ type: 'error', code: 'BAD_MESSAGE', message: 'Choose pairing or device resume.' });
        return;
      }
      disconnectCurrentSession();
      const session = this.registerExtension({
        connectionId,
        mode: registration.mode,
        extensionVersion: registration.extensionVersion,
        activeProject: registration.activeProject,
        dispatch,
        requestApproval: async (request) => {
          if (ws.readyState !== ws.OPEN) throw new Error('Remote relay socket is closed.');
          ws.send(JSON.stringify(request));
        },
        closeConnection: () => {
          if (ws.readyState === ws.OPEN) ws.close(1011, 'remote_dispatch_timeout');
        },
        notifyRevoked: () => {
          send({
            type: 'error',
            code: 'SESSION_REVOKED',
            message: 'Device access removed by its owner. Generate a new pairing code.',
          });
        },
        pairingCode,
      });
      sessionId = session.sessionId;
      let nextCredential: string | undefined;
      try {
        nextCredential = this.issueOrResumeHostedDevice(session, pairingCode, resumeCredential);
      } catch {
        // A storage fault must not silently authorize an unrevocable device.
        send({
          type: 'error',
          code: 'DEVICE_RESUME_UNAVAILABLE',
          message: 'Device pairing could not be safely completed. Reconnect with a new code.',
        });
        disconnectCurrentSession();
        ws.close(1011, 'device_resume_unavailable');
        return;
      }
      send({
        type: 'session_registered',
        paired: Boolean(session.userId),
        maxPayloadSize: this.relayMaxPayloadSize,
        expiresAt: session.expiresAt.toISOString(),
        ...(nextCredential ? { resumeCredential: nextCredential } : {}),
      });
      return;
    };

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', code: 'BAD_JSON', message: 'Relay message must be JSON.' });
        return;
      }

      const record =
        parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const message = RelayMessageSchema.safeParse(parsed);
      if (!message.success) {
        send({
          type: 'error',
          code: 'BAD_MESSAGE',
          message: 'Relay message schema validation failed.',
        });
        return;
      }

      if (message.data.type === 'register_session') {
        handleRegistration(message.data, record);
        return;
      }

      if (!sessionId) {
        send({
          type: 'error',
          code: 'SESSION_NOT_REGISTERED',
          message: 'Register the session first.',
        });
        return;
      }

      if (message.data.type === 'heartbeat') {
        handleHeartbeat(message.data);
        return;
      }

      if (message.data.type === 'approval_result') {
        if (!messageMatchesCurrentSession(message.data.sessionId)) return;
        const resolved = this.resolveApprovalFromExtension({
          sessionId,
          approvalId: message.data.approvalId,
          result: message.data.result,
        });
        if (!resolved) {
          send({
            type: 'error',
            code: 'APPROVAL_NOT_FOUND',
            message: 'Approval result did not match this relay session.',
          });
        }
        return;
      }

      if (message.data.type === 'tool_response') {
        if (!messageMatchesCurrentSession(message.data.sessionId)) return;
        const handler = pending.get(message.data.requestMessageId);
        if (!handler) {
          send({
            type: 'error',
            code: 'REQUEST_NOT_FOUND',
            message: 'Tool response did not match an active relay request.',
          });
          return;
        }
        pending.delete(message.data.requestMessageId);
        handler.resolve(message.data);
        return;
      }

      if (message.data.type === 'session_closed') {
        if (!messageMatchesCurrentSession(message.data.sessionId)) return;
        disconnectCurrentSession();
      }
    });

    ws.on('close', () => {
      disconnectCurrentSession();
    });
  }
}

function parseUpgradePath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

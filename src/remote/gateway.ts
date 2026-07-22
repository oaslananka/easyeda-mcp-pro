import { createHash, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Express, Request, Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import { ApprovalStore, requiresApproval, type ApprovalDecision } from './approval-policy.js';
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
} from './protocol.js';
import { type RemoteIdentity, checkRemoteScope } from './scope.js';
import { type ExtensionSession, RemoteSessionRouter } from './session-router.js';
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

export type RemoteGatewayFailure = {
  ok: false;
  status: number;
  code: RemoteGatewayErrorCode;
  message: string;
  approvalId?: string;
  approvalExpiresAt?: string;
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
}

interface RemoteInvocationGrantRecord {
  grantId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  riskLevel: RemoteRiskLevel;
  inputHash: string;
  expiresAt: Date;
}

type ResolvedRemoteConnection =
  | {
      ok: true;
      session: ExtensionSession;
      connection: RegisteredConnection;
    }
  | RemoteGatewayFailure;

export interface RemoteGatewayOptions {
  router?: RemoteSessionRouter;
  approvals?: ApprovalStore;
  audit?: RemoteAuditLog;
  now?: () => Date;
  makeId?: () => string;
  hashInput?: (value: unknown) => string;
  approvalTtlMs?: number;
  invocationGrantTtlMs?: number;
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
  const timeoutMs = request.deadlineMs ?? 30_000;
  return await new Promise<ToolResponseMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new RemoteDispatchTimeoutError(timeoutMs)), timeoutMs);
    void Promise.resolve()
      .then(() => dispatch(request))
      .then(
        (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

function isUnsupportedRemoteMethod(code: string | undefined): boolean {
  return code === 'METHOD_NOT_ALLOWED' || code === 'METHOD_NOT_FOUND';
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

export class RemoteGateway {
  readonly router: RemoteSessionRouter;
  readonly approvals: ApprovalStore;
  readonly audit: RemoteAuditLog;
  private readonly connections = new Map<string, RegisteredConnection>();
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly hashInput: (value: unknown) => string;
  private readonly approvalTtlMs: number;
  private readonly invocationGrantTtlMs: number;
  private readonly invocationGrants = new Map<string, RemoteInvocationGrantRecord>();
  private readonly dispatchQueue = new SessionDispatchQueue();
  private wsAttached = false;

  constructor(options: RemoteGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? (() => randomUUID());
    this.hashInput = options.hashInput ?? defaultHashInput;
    this.approvalTtlMs = options.approvalTtlMs ?? 60_000;
    this.invocationGrantTtlMs = options.invocationGrantTtlMs ?? 300_000;
    this.router = options.router ?? new RemoteSessionRouter(this.now, this.makeId);
    this.approvals = options.approvals ?? new ApprovalStore();
    this.audit = options.audit ?? new RemoteAuditLog();
  }

  private resolveConnection(input: {
    identity: RemoteIdentity;
    sessionId?: string;
    riskLevel: RemoteRiskLevel;
  }): ResolvedRemoteConnection {
    const route = this.router.resolve({
      userId: input.identity.userId,
      riskLevel: input.riskLevel,
      sessionId: input.sessionId,
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
      }`;
      this.approvals.request({
        approvalId,
        userId: input.identity.userId,
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
    pairingCode?: string;
  }): ExtensionSession {
    const session = this.router.registerSession(input);
    this.connections.set(session.sessionId, {
      sessionId: session.sessionId,
      dispatch: input.dispatch,
      requestApproval: input.requestApproval,
      closeConnection: input.closeConnection,
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

  disconnect(sessionId: string): void {
    const session = this.router.getSession(sessionId);
    this.router.disconnect(sessionId);
    this.connections.delete(sessionId);
    this.approvals.deleteForSession(sessionId);
    for (const [grantId, grant] of this.invocationGrants) {
      if (grant.sessionId === sessionId) this.invocationGrants.delete(grantId);
    }
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

  async authorizeToolInvocation(input: {
    identity?: RemoteIdentity;
    sessionId?: string;
    toolName: string;
    riskLevel: Exclude<RemoteRiskLevel, 'read'>;
    input?: unknown;
    approvalId?: string;
  }): Promise<RemoteGatewayAuthorizationResult> {
    const scope = checkRemoteScope(input.identity, input.riskLevel, this.now());
    if (!scope.ok) {
      return gatewayError(scope.code === 'SCOPE_MISSING' ? 403 : 401, scope.code, scope.message);
    }
    const identity = input.identity;
    if (!identity) return gatewayError(401, 'IDENTITY_MISSING', 'Remote identity is required.');

    const route = this.resolveConnection({
      identity,
      riskLevel: input.riskLevel,
      sessionId: input.sessionId,
    });
    if (!route.ok) return route;

    const now = this.now();
    const inputHash = this.hashInput(input.input);
    if (!input.approvalId) {
      return await this.requestRemoteApproval({
        identity,
        session: route.session,
        connection: route.connection,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        inputHash,
        now,
        actionLabel: 'MCP tool',
        retryMessage:
          'Approval was requested in EasyEDA. Retry the same MCP tool call with remoteApprovalId after the user decides.',
      });
    }

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

    const grantId = `grant_${this.makeId()}`;
    this.invocationGrants.set(grantId, {
      grantId,
      userId: identity.userId,
      sessionId: route.session.sessionId,
      toolName: input.toolName,
      riskLevel: input.riskLevel,
      inputHash,
      expiresAt: new Date(now.getTime() + this.invocationGrantTtlMs),
    });
    return { ok: true, sessionId: route.session.sessionId, grantId };
  }

  revokeInvocationGrant(grantId: string): boolean {
    return this.invocationGrants.delete(grantId);
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
    const scope = checkRemoteScope(input.identity, input.riskLevel, this.now());
    if (!scope.ok) {
      this.audit.record({
        event: 'remote.identity.rejected',
        mode: 'hosted',
        userId: input.identity?.userId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        status: 'rejected',
        errorCode: scope.code,
      });
      return gatewayError(scope.code === 'SCOPE_MISSING' ? 403 : 401, scope.code, scope.message);
    }

    const identity = input.identity;
    if (!identity) {
      return gatewayError(401, 'IDENTITY_MISSING', 'Remote identity is required.');
    }

    const route = this.resolveConnection({
      identity,
      riskLevel: input.riskLevel,
      sessionId: input.sessionId,
    });
    if (!route.ok) return route;
    const connection = route.connection;

    const now = this.now();
    const inputHash = this.hashInput(input.input);
    if (requiresApproval(input.riskLevel)) {
      if (input.grantId) {
        const grant = this.invocationGrants.get(input.grantId);
        const validGrant =
          grant &&
          grant.expiresAt.getTime() > now.getTime() &&
          grant.userId === identity.userId &&
          grant.sessionId === route.session.sessionId &&
          grant.riskLevel === input.riskLevel;
        if (!validGrant) {
          if (grant && grant.expiresAt.getTime() <= now.getTime()) {
            this.invocationGrants.delete(input.grantId);
          }
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
          riskLevel: input.riskLevel,
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
      riskLevel: input.riskLevel,
      requiresApproval: requiresApproval(input.riskLevel),
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
      riskLevel: input.riskLevel,
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
        const extensionCode = response.error?.code;
        if (isUnsupportedRemoteMethod(extensionCode)) {
          return gatewayError(
            422,
            'REMOTE_TOOL_UNSUPPORTED',
            `${extensionCode}: ${response.error?.message ?? 'Remote extension does not support this method.'}`,
          );
        }
        return gatewayError(
          502,
          'REMOTE_EXTENSION_ERROR',
          response.error?.message ?? 'Remote extension returned an error.',
        );
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

  attachWebSocketServer(server: HttpServer): void {
    if (this.wsAttached) return;
    this.wsAttached = true;
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const path = parseUpgradePath(request);
      if (path !== '/remote/relay' && path !== '/session') return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws) => this.handleRelaySocket(ws));
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

    const dispatch: RemoteToolDispatcher = async (request) => {
      if (ws.readyState !== ws.OPEN) {
        throw new RemoteSessionUnavailableError(request.sessionId);
      }
      ws.send(JSON.stringify(request));
      return await new Promise<ToolResponseMessage>((resolve, reject) => {
        const timeoutMs = request.deadlineMs ?? 30_000;
        const timeout = setTimeout(() => {
          pending.delete(request.messageId);
          reject(new RemoteDispatchTimeoutError(timeoutMs));
        }, timeoutMs);
        pending.set(request.messageId, {
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
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
        disconnectCurrentSession();
        const session = this.registerExtension({
          connectionId,
          mode: message.data.mode,
          extensionVersion: message.data.extensionVersion,
          activeProject: message.data.activeProject,
          dispatch,
          requestApproval: async (request) => {
            if (ws.readyState !== ws.OPEN) throw new Error('Remote relay socket is closed.');
            ws.send(JSON.stringify(request));
          },
          closeConnection: () => {
            if (ws.readyState === ws.OPEN) ws.close(1011, 'remote_dispatch_timeout');
          },
          pairingCode: typeof record.pairingCode === 'string' ? record.pairingCode : undefined,
        });
        sessionId = session.sessionId;
        send({
          type: 'session_registered',
          paired: Boolean(session.userId),
          expiresAt: session.expiresAt.toISOString(),
        });
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
        this.router.heartbeat(sessionId);
        send({ type: 'heartbeat' });
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

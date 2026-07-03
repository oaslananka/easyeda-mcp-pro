import type { RemoteDeploymentMode, RemoteRiskLevel } from './protocol.js';

export type RemoteAuditEventName =
  | 'remote.session.registered'
  | 'remote.session.paired'
  | 'remote.session.disconnected'
  | 'remote.tool.requested'
  | 'remote.tool.dispatched'
  | 'remote.tool.completed'
  | 'remote.tool.failed'
  | 'remote.approval.requested'
  | 'remote.approval.resolved'
  | 'remote.identity.rejected';

export interface RemoteAuditEvent {
  event: RemoteAuditEventName;
  observedAt: string;
  mode: RemoteDeploymentMode;
  userId?: string;
  sessionId?: string;
  connectionId?: string;
  toolName?: string;
  riskLevel?: RemoteRiskLevel;
  inputHash?: string;
  status?: 'ok' | 'error' | 'rejected' | 'timeout';
  durationMs?: number;
  errorCode?: string;
}

const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /(token|secret|password|credential|apiKey|api_key|pairingCode)/i;

export function redactRemotePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactRemotePayload(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactRemotePayload(child);
  }
  return out;
}

export class RemoteAuditLog {
  private events: RemoteAuditEvent[] = [];

  constructor(private readonly maxEvents = 200) {}

  record(event: Omit<RemoteAuditEvent, 'observedAt'> & { observedAt?: string }): RemoteAuditEvent {
    const stored: RemoteAuditEvent = {
      ...event,
      observedAt: event.observedAt ?? new Date().toISOString(),
    };
    this.events.push(stored);
    if (this.events.length > this.maxEvents) this.events = this.events.slice(-this.maxEvents);
    return stored;
  }

  recent(limit = 25): RemoteAuditEvent[] {
    return this.events.slice(-limit);
  }

  clear(): void {
    this.events = [];
  }
}

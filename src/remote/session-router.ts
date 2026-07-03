import { randomUUID } from 'node:crypto';
import type { ActiveProject, RemoteDeploymentMode, RemoteRiskLevel } from './protocol.js';

export interface ExtensionSession {
  sessionId: string;
  connectionId: string;
  mode: Exclude<RemoteDeploymentMode, 'local'>;
  extensionVersion: string;
  userId?: string;
  activeProject?: ActiveProject;
  connected: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

interface PairingCode {
  code: string;
  userId: string;
  sessionId?: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date;
}

export type SessionRouteResult =
  | { ok: true; session: ExtensionSession }
  | {
      ok: false;
      code:
        | 'SESSION_UNPAIRED'
        | 'SESSION_DISCONNECTED'
        | 'SESSION_EXPIRED'
        | 'SESSION_AMBIGUOUS'
        | 'PROJECT_INACTIVE';
      message: string;
    };

export class RemoteSessionRouter {
  private readonly sessions = new Map<string, ExtensionSession>();
  private readonly pairings = new Map<string, PairingCode>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = () => randomUUID(),
  ) {}

  registerSession(input: {
    connectionId: string;
    mode: Exclude<RemoteDeploymentMode, 'local'>;
    extensionVersion: string;
    activeProject?: ActiveProject;
    ttlMs?: number;
  }): ExtensionSession {
    const now = this.now();
    const session: ExtensionSession = {
      sessionId: `sess_${this.makeId()}`,
      connectionId: input.connectionId,
      mode: input.mode,
      extensionVersion: input.extensionVersion,
      activeProject: input.activeProject,
      connected: true,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 2 * 60 * 60 * 1000)),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  createPairingCode(input: { userId: string; sessionId?: string; ttlMs?: number }): string {
    const now = this.now();
    const code = `EDA-${this.makeId().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    this.pairings.set(code, {
      code,
      userId: input.userId,
      sessionId: input.sessionId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 10 * 60 * 1000)),
    });
    return code;
  }

  completePairing(input: { code: string; userId: string; sessionId: string }): boolean {
    const pairing = this.pairings.get(input.code);
    const session = this.sessions.get(input.sessionId);
    const now = this.now();
    if (!pairing || !session) return false;
    if (pairing.usedAt) return false;
    if (pairing.userId !== input.userId) return false;
    if (pairing.sessionId && pairing.sessionId !== input.sessionId) return false;
    if (pairing.expiresAt.getTime() <= now.getTime()) return false;
    if (!session.connected || session.expiresAt.getTime() <= now.getTime()) return false;
    pairing.usedAt = now;
    session.userId = input.userId;
    session.lastSeenAt = now;
    return true;
  }

  heartbeat(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.connected) return false;
    session.lastSeenAt = this.now();
    return true;
  }

  updateActiveProject(sessionId: string, activeProject?: ActiveProject): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.activeProject = activeProject;
    session.lastSeenAt = this.now();
    return true;
  }

  disconnect(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.connected = false;
    session.lastSeenAt = this.now();
    return true;
  }

  resolve(input: {
    userId: string;
    riskLevel: RemoteRiskLevel;
    sessionId?: string;
  }): SessionRouteResult {
    const now = this.now();
    const candidates = [...this.sessions.values()].filter(
      (session) =>
        session.userId === input.userId &&
        (!input.sessionId || session.sessionId === input.sessionId),
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'SESSION_UNPAIRED',
        message: 'No paired EasyEDA extension session.',
      };
    }
    const active = candidates.filter((session) => session.connected);
    if (active.length === 0) {
      return {
        ok: false,
        code: 'SESSION_DISCONNECTED',
        message: 'Paired EasyEDA extension is disconnected.',
      };
    }
    const unexpired = active.filter((session) => session.expiresAt.getTime() > now.getTime());
    if (unexpired.length === 0) {
      return {
        ok: false,
        code: 'SESSION_EXPIRED',
        message: 'Paired EasyEDA extension session expired.',
      };
    }
    if (!input.sessionId && unexpired.length > 1) {
      return {
        ok: false,
        code: 'SESSION_AMBIGUOUS',
        message: 'Multiple active EasyEDA sessions require explicit selection.',
      };
    }
    const session = unexpired[0];
    if (!session) {
      return {
        ok: false,
        code: 'SESSION_UNPAIRED',
        message: 'No paired EasyEDA extension session.',
      };
    }
    if (input.riskLevel !== 'read' && !session.activeProject) {
      return {
        ok: false,
        code: 'PROJECT_INACTIVE',
        message: 'No active EasyEDA project is visible.',
      };
    }
    return { ok: true, session };
  }

  getSession(sessionId: string): ExtensionSession | undefined {
    return this.sessions.get(sessionId);
  }
}

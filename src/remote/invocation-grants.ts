import type { RemoteRiskLevel } from './protocol.js';

export interface RemoteInvocationGrantInput {
  userId: string;
  sessionId: string;
  toolName: string;
  riskLevel: RemoteRiskLevel;
  inputHash: string;
}

export interface RemoteInvocationGrantValidation {
  grantId: string;
  userId: string;
  sessionId: string;
  riskLevel: RemoteRiskLevel;
}

interface RemoteInvocationGrantRecord extends RemoteInvocationGrantInput {
  grantId: string;
  expiresAt: Date;
}

export class RemoteInvocationGrantStore {
  private readonly grants = new Map<string, RemoteInvocationGrantRecord>();

  constructor(
    private readonly makeId: () => string,
    private readonly ttlMs: number,
  ) {}

  issue(input: RemoteInvocationGrantInput, now: Date): string {
    const grantId = `grant_${this.makeId()}`;
    this.grants.set(grantId, {
      ...input,
      grantId,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    });
    return grantId;
  }

  validate(input: RemoteInvocationGrantValidation, now: Date): boolean {
    const grant = this.grants.get(input.grantId);
    if (!grant) return false;
    if (grant.expiresAt.getTime() <= now.getTime()) {
      this.grants.delete(input.grantId);
      return false;
    }
    return (
      grant.userId === input.userId &&
      grant.sessionId === input.sessionId &&
      grant.riskLevel === input.riskLevel
    );
  }

  revoke(grantId: string): boolean {
    return this.grants.delete(grantId);
  }

  deleteForSession(sessionId: string): number {
    let deleted = 0;
    for (const [grantId, grant] of this.grants) {
      if (grant.sessionId !== sessionId) continue;
      this.grants.delete(grantId);
      deleted += 1;
    }
    return deleted;
  }
}

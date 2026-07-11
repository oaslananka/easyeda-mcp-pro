import type { ActiveProject, RemoteRiskLevel } from './protocol.js';

export interface ApprovalRequestInput {
  approvalId: string;
  userId: string;
  sessionId: string;
  toolName: string;
  riskLevel: RemoteRiskLevel;
  inputHash: string;
  actionSummary: string;
  activeProject?: ActiveProject;
  expiresAt: Date;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRecord extends ApprovalRequestInput {
  decision?: ApprovalDecision;
  decidedAt?: Date;
}

export function requiresApproval(riskLevel: RemoteRiskLevel): boolean {
  return riskLevel !== 'read';
}

export function isDestructiveRisk(riskLevel: RemoteRiskLevel): boolean {
  return riskLevel === 'destructive';
}

export class ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRecord>();

  request(input: ApprovalRequestInput): ApprovalRecord {
    const record: ApprovalRecord = { ...input };
    this.approvals.set(input.approvalId, record);
    return record;
  }

  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    now = new Date(),
  ): ApprovalRecord | undefined {
    const record = this.approvals.get(approvalId);
    if (!record || record.decision !== undefined) return undefined;
    record.decision = now.getTime() >= record.expiresAt.getTime() ? 'timeout' : decision;
    record.decidedAt = now;
    return record;
  }

  consumeApproved(input: {
    approvalId: string;
    userId: string;
    sessionId: string;
    toolName: string;
    inputHash: string;
    now?: Date;
  }): boolean {
    const record = this.approvals.get(input.approvalId);
    if (!record) return false;
    const now = input.now ?? new Date();
    const matches =
      record.userId === input.userId &&
      record.sessionId === input.sessionId &&
      record.toolName === input.toolName &&
      record.inputHash === input.inputHash &&
      record.decision === 'approved' &&
      record.expiresAt.getTime() > now.getTime();
    if (matches) this.approvals.delete(input.approvalId);
    return matches;
  }

  get(approvalId: string): ApprovalRecord | undefined {
    return this.approvals.get(approvalId);
  }

  findPending(input: {
    userId: string;
    sessionId: string;
    toolName: string;
    inputHash: string;
    now?: Date;
  }): ApprovalRecord | undefined {
    const now = input.now ?? new Date();
    for (const [approvalId, record] of this.approvals) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.approvals.delete(approvalId);
        continue;
      }
      if (
        record.userId === input.userId &&
        record.sessionId === input.sessionId &&
        record.toolName === input.toolName &&
        record.inputHash === input.inputHash &&
        record.decision === undefined
      ) {
        return record;
      }
    }
    return undefined;
  }

  delete(approvalId: string): boolean {
    return this.approvals.delete(approvalId);
  }

  deleteForSession(sessionId: string): number {
    let deleted = 0;
    for (const [approvalId, record] of this.approvals) {
      if (record.sessionId === sessionId && this.approvals.delete(approvalId)) deleted += 1;
    }
    return deleted;
  }
}

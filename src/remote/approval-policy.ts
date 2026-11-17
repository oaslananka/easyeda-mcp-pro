import type { ActiveProject, RemoteRiskLevel } from './protocol.js';

export interface ApprovalRequestInput {
  approvalId: string;
  userId: string;
  /** OAuth app identity when authenticated; blocks cross-client approval consumption. */
  clientId?: string;
  /** A per-action approval cannot silently become project-wide authorization. */
  allowsProjectSession?: boolean;
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

/** Compare the original native approval target with the current document. */
function sameNativeApprovalTarget(record: ApprovalRecord, current?: ActiveProject): boolean {
  if (!record.activeProject?.projectId) return true;
  return (
    record.activeProject.projectId === current?.projectId &&
    record.activeProject.documentId === current?.documentId
  );
}

/** Reuse the same binding for both pending searches and consumption. */
function sameApprovalContext(
  record: ApprovalRecord,
  input: {
    userId: string;
    clientId?: string;
    sessionId: string;
    toolName: string;
    inputHash: string;
    activeProject?: ActiveProject;
  },
): boolean {
  return (
    record.userId === input.userId &&
    record.clientId === input.clientId &&
    record.sessionId === input.sessionId &&
    record.toolName === input.toolName &&
    record.inputHash === input.inputHash &&
    sameNativeApprovalTarget(record, input.activeProject)
  );
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
    clientId?: string;
    activeProject?: ActiveProject;
    sessionId: string;
    toolName: string;
    inputHash: string;
    now?: Date;
  }): boolean {
    const record = this.approvals.get(input.approvalId);
    if (!record) return false;
    const now = input.now ?? new Date();
    const matches =
      sameApprovalContext(record, input) &&
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
    clientId?: string;
    activeProject?: ActiveProject;
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
      if (sameApprovalContext(record, input) && record.decision === undefined) {
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

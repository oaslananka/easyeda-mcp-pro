import { describe, expect, it } from 'vitest';
import { ApprovalStore, requiresApproval } from '../../../src/remote/approval-policy.js';
import { RemoteAuditLog, redactRemotePayload } from '../../../src/remote/observability.js';
import { checkRemoteScope, requiredScopeForRisk } from '../../../src/remote/scope.js';

describe('remote approval policy', () => {
  it('requires approval for non-read actions', () => {
    expect(requiresApproval('read')).toBe(false);
    expect(requiresApproval('write')).toBe(true);
    expect(requiresApproval('export')).toBe(true);
    expect(requiresApproval('destructive')).toBe(true);
  });

  it('binds approval to user, session, tool, and input hash', () => {
    const store = new ApprovalStore();
    store.request({
      approvalId: 'approval_1',
      userId: 'user_1',
      sessionId: 'sess_1',
      toolName: 'schematic.addWire',
      riskLevel: 'write',
      inputHash: 'hash_1',
      actionSummary: 'Add a wire',
      expiresAt: new Date('2026-07-03T00:01:00.000Z'),
    });
    store.resolve('approval_1', 'approved', new Date('2026-07-03T00:00:10.000Z'));

    expect(
      store.consumeApproved({
        approvalId: 'approval_1',
        userId: 'user_1',
        sessionId: 'sess_1',
        toolName: 'schematic.addWire',
        inputHash: 'hash_2',
        now: new Date('2026-07-03T00:00:11.000Z'),
      }),
    ).toBe(false);
    expect(
      store.consumeApproved({
        approvalId: 'approval_1',
        userId: 'user_1',
        sessionId: 'sess_1',
        toolName: 'schematic.addWire',
        inputHash: 'hash_1',
        now: new Date('2026-07-03T00:00:11.000Z'),
      }),
    ).toBe(true);
  });

  it('accepts only the first decision and treats the exact expiry instant as timeout', () => {
    const store = new ApprovalStore();
    store.request({
      approvalId: 'approval_first_decision',
      userId: 'user_1',
      sessionId: 'sess_1',
      toolName: 'easyeda_schematic_add_text',
      riskLevel: 'write',
      inputHash: 'hash_1',
      actionSummary: 'Add text',
      expiresAt: new Date('2026-07-03T00:01:00.000Z'),
    });

    expect(
      store.resolve('approval_first_decision', 'approved', new Date('2026-07-03T00:01:00.000Z')),
    ).toMatchObject({ decision: 'timeout' });
    expect(
      store.resolve('approval_first_decision', 'approved', new Date('2026-07-03T00:01:01.000Z')),
    ).toBeUndefined();
    expect(store.get('approval_first_decision')).toMatchObject({ decision: 'timeout' });
  });

  it('reuses only an exact unexpired pending approval and removes expired records', () => {
    const store = new ApprovalStore();
    store.request({
      approvalId: 'pending_exact',
      userId: 'user_1',
      sessionId: 'sess_1',
      toolName: 'easyeda_schematic_add_text',
      riskLevel: 'write',
      inputHash: 'hash_exact',
      actionSummary: 'Add text',
      expiresAt: new Date('2026-07-03T00:02:00.000Z'),
    });
    store.request({
      approvalId: 'pending_expired',
      userId: 'user_1',
      sessionId: 'sess_1',
      toolName: 'easyeda_schematic_add_text',
      riskLevel: 'write',
      inputHash: 'hash_expired',
      actionSummary: 'Add old text',
      expiresAt: new Date('2026-07-03T00:00:30.000Z'),
    });

    expect(
      store.findPending({
        userId: 'user_1',
        sessionId: 'sess_1',
        toolName: 'easyeda_schematic_add_text',
        inputHash: 'hash_exact',
        now: new Date('2026-07-03T00:01:00.000Z'),
      }),
    ).toMatchObject({ approvalId: 'pending_exact' });
    expect(
      store.findPending({
        userId: 'user_1',
        sessionId: 'sess_1',
        toolName: 'easyeda_schematic_add_text',
        inputHash: 'hash_expired',
        now: new Date('2026-07-03T00:01:00.000Z'),
      }),
    ).toBeUndefined();
    expect(store.get('pending_expired')).toBeUndefined();
  });

  it('deletes all approval records for a disconnected session only', () => {
    const store = new ApprovalStore();
    for (const [approvalId, sessionId] of [
      ['approval_a', 'sess_1'],
      ['approval_b', 'sess_1'],
      ['approval_c', 'sess_2'],
    ] as const) {
      store.request({
        approvalId,
        userId: 'user_1',
        sessionId,
        toolName: 'easyeda_schematic_add_text',
        riskLevel: 'write',
        inputHash: approvalId,
        actionSummary: 'Add text',
        expiresAt: new Date('2026-07-03T00:02:00.000Z'),
      });
    }

    expect(store.deleteForSession('sess_1')).toBe(2);
    expect(store.get('approval_a')).toBeUndefined();
    expect(store.get('approval_b')).toBeUndefined();
    expect(store.get('approval_c')).toBeDefined();
  });
});

describe('remote scope checks', () => {
  it('maps risk levels to scopes', () => {
    expect(requiredScopeForRisk('read')).toBe('easyeda.read');
    expect(requiredScopeForRisk('write')).toBe('easyeda.write');
    expect(requiredScopeForRisk('export')).toBe('easyeda.export');
    expect(requiredScopeForRisk('destructive')).toBe('easyeda.project_admin');
  });

  it('rejects missing and insufficient scopes', () => {
    expect(checkRemoteScope(undefined, 'read')).toMatchObject({
      ok: false,
      code: 'IDENTITY_MISSING',
    });
    expect(checkRemoteScope({ userId: 'u1', scopes: ['easyeda.read'] }, 'write')).toMatchObject({
      ok: false,
      code: 'SCOPE_MISSING',
    });
    expect(
      checkRemoteScope({ userId: 'u1', scopes: ['easyeda.project_admin'] }, 'destructive'),
    ).toEqual({ ok: true });
  });
});

describe('remote observability', () => {
  it('redacts secret-like payload keys', () => {
    expect(redactRemotePayload({ token: 'abc', nested: { apiKey: 'def', visible: 'ok' } })).toEqual(
      { token: '[redacted]', nested: { apiKey: '[redacted]', visible: 'ok' } },
    );
  });

  it('stores bounded audit events', () => {
    const log = new RemoteAuditLog(1);
    log.record({ event: 'remote.session.registered', mode: 'hosted', sessionId: 'sess_1' });
    log.record({
      event: 'remote.tool.completed',
      mode: 'hosted',
      sessionId: 'sess_1',
      status: 'ok',
    });

    expect(log.recent()).toHaveLength(1);
    expect(log.recent()[0]?.event).toBe('remote.tool.completed');
  });
});

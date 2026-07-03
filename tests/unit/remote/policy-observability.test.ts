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

import { describe, expect, it } from 'vitest';
import { ApprovalStore, requiresApproval } from '../../../src/remote/approval-policy.js';
import { REMOTE_RELAY_PROTOCOL_VERSION, ToolRequestMessageSchema, ToolResponseMessageSchema } from '../../../src/remote/protocol.js';
import { RemoteSessionRouter } from '../../../src/remote/session-router.js';

function makeHarness(start = new Date('2026-07-03T00:00:00.000Z')) {
  let now = start;
  let counter = 0;
  const router = new RemoteSessionRouter(
    () => now,
    () => `id-${++counter}`,
  );
  const approvals = new ApprovalStore();

  return {
    router,
    approvals,
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    register(userId: string, connectionId: string) {
      const session = router.registerSession({
        connectionId,
        mode: 'hosted',
        extensionVersion: '0.18.0',
        activeProject: { projectName: 'Demo', documentType: 'schematic' },
      });
      const code = router.createPairingCode({ userId, sessionId: session.sessionId });
      expect(router.completePairing({ code, userId, sessionId: session.sessionId })).toBe(true);
      return session;
    },
  };
}

describe('fake extension remote integration flow', () => {
  it('registers, pairs, heartbeats, and routes a read request', () => {
    const h = makeHarness();
    const session = h.register('user-a', 'conn-a');

    expect(h.router.heartbeat(session.sessionId)).toBe(true);
    const route = h.router.resolve({ userId: 'user-a', riskLevel: 'read' });
    expect(route.ok).toBe(true);

    const request = ToolRequestMessageSchema.parse({
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      type: 'tool_request',
      messageId: 'msg-1',
      sessionId: session.sessionId,
      timestamp: h.now().toISOString(),
      toolName: 'easyeda_board_read',
      riskLevel: 'read',
      requiresApproval: false,
      inputHash: 'hash-read',
    });
    const response = ToolResponseMessageSchema.parse({
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      type: 'tool_response',
      messageId: 'msg-2',
      sessionId: session.sessionId,
      requestMessageId: request.messageId,
      timestamp: h.now().toISOString(),
      ok: true,
      result: { routed: true },
      durationMs: 3,
    });

    expect(response.ok).toBe(true);
  });

  it('rejects cross-user routing and ambiguous sessions', () => {
    const h = makeHarness();
    const userASession1 = h.register('user-a', 'conn-a1');
    const userASession2 = h.register('user-a', 'conn-a2');
    const userBSession = h.register('user-b', 'conn-b');

    expect(
      h.router.resolve({ userId: 'user-a', riskLevel: 'read', sessionId: userBSession.sessionId }),
    ).toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });
    expect(h.router.resolve({ userId: 'user-a', riskLevel: 'read' })).toMatchObject({
      ok: false,
      code: 'SESSION_AMBIGUOUS',
    });
    expect(
      h.router.resolve({ userId: 'user-a', riskLevel: 'read', sessionId: userASession1.sessionId }),
    ).toMatchObject({ ok: true, session: { sessionId: userASession1.sessionId } });
    expect(
      h.router.resolve({ userId: 'user-a', riskLevel: 'read', sessionId: userASession2.sessionId }),
    ).toMatchObject({ ok: true, session: { sessionId: userASession2.sessionId } });
  });

  it('requires and consumes approval for write dispatch', () => {
    const h = makeHarness();
    const session = h.register('user-a', 'conn-a');

    expect(requiresApproval('write')).toBe(true);
    h.approvals.request({
      approvalId: 'appr-1',
      userId: 'user-a',
      sessionId: session.sessionId,
      toolName: 'easyeda_pcb_place_component',
      riskLevel: 'write',
      inputHash: 'hash-write',
      actionSummary: 'Place one component',
      activeProject: session.activeProject,
      expiresAt: new Date(h.now().getTime() + 30_000),
    });
    expect(h.approvals.resolve('appr-1', 'approved', h.now())?.decision).toBe('approved');
    expect(
      h.approvals.consumeApproved({
        approvalId: 'appr-1',
        userId: 'user-a',
        sessionId: session.sessionId,
        toolName: 'easyeda_pcb_place_component',
        inputHash: 'hash-write',
        now: h.now(),
      }),
    ).toBe(true);
    expect(
      h.approvals.consumeApproved({
        approvalId: 'appr-1',
        userId: 'user-a',
        sessionId: session.sessionId,
        toolName: 'easyeda_pcb_place_component',
        inputHash: 'hash-write',
        now: h.now(),
      }),
    ).toBe(false);
  });

  it('fails closed for rejected, timed out, and mismatched approvals', () => {
    const h = makeHarness();
    const session = h.register('user-a', 'conn-a');

    h.approvals.request({
      approvalId: 'appr-reject',
      userId: 'user-a',
      sessionId: session.sessionId,
      toolName: 'easyeda_export_gerbers',
      riskLevel: 'export',
      inputHash: 'hash-export',
      actionSummary: 'Export Gerbers',
      activeProject: session.activeProject,
      expiresAt: new Date(h.now().getTime() + 30_000),
    });
    h.approvals.resolve('appr-reject', 'rejected', h.now());
    expect(
      h.approvals.consumeApproved({
        approvalId: 'appr-reject',
        userId: 'user-a',
        sessionId: session.sessionId,
        toolName: 'easyeda_export_gerbers',
        inputHash: 'hash-export',
        now: h.now(),
      }),
    ).toBe(false);

    h.approvals.request({
      approvalId: 'appr-hash',
      userId: 'user-a',
      sessionId: session.sessionId,
      toolName: 'easyeda_export_gerbers',
      riskLevel: 'export',
      inputHash: 'hash-good',
      actionSummary: 'Export Gerbers',
      activeProject: session.activeProject,
      expiresAt: new Date(h.now().getTime() + 30_000),
    });
    h.approvals.resolve('appr-hash', 'approved', h.now());
    expect(
      h.approvals.consumeApproved({
        approvalId: 'appr-hash',
        userId: 'user-a',
        sessionId: session.sessionId,
        toolName: 'easyeda_export_gerbers',
        inputHash: 'hash-changed',
        now: h.now(),
      }),
    ).toBe(false);

    h.approvals.request({
      approvalId: 'appr-timeout',
      userId: 'user-a',
      sessionId: session.sessionId,
      toolName: 'easyeda_export_gerbers',
      riskLevel: 'export',
      inputHash: 'hash-timeout',
      actionSummary: 'Export Gerbers',
      activeProject: session.activeProject,
      expiresAt: new Date(h.now().getTime() + 5),
    });
    h.advance(6);
    expect(h.approvals.resolve('appr-timeout', 'approved', h.now())?.decision).toBe('timeout');
  });

  it('fails closed after the fake extension disconnects', () => {
    const h = makeHarness();
    const session = h.register('user-a', 'conn-a');

    expect(h.router.disconnect(session.sessionId)).toBe(true);
    expect(
      h.router.resolve({ userId: 'user-a', riskLevel: 'write', sessionId: session.sessionId }),
    ).toMatchObject({ ok: false, code: 'SESSION_DISCONNECTED' });
  });
});

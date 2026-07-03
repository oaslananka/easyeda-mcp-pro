import { describe, expect, it } from 'vitest';
import { RemoteSessionRouter } from '../../../src/remote/session-router.js';

function makeRouter(start = new Date('2026-07-03T00:00:00.000Z')) {
  let now = start;
  let counter = 0;
  return {
    router: new RemoteSessionRouter(
      () => now,
      () => `id-${++counter}`,
    ),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('RemoteSessionRouter', () => {
  it('pairs a user to an extension session once', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });

    expect(router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId })).toBe(
      true,
    );
    expect(router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId })).toBe(
      false,
    );
  });

  it('rejects cross-user pairing attempts', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });

    expect(router.completePairing({ code, userId: 'user_2', sessionId: session.sessionId })).toBe(
      false,
    );
  });

  it('resolves a paired read session without active project', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });
    router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId });

    const result = router.resolve({ userId: 'user_1', riskLevel: 'read' });
    expect(result.ok).toBe(true);
  });

  it('requires active project for write routing', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });
    router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId });

    const result = router.resolve({ userId: 'user_1', riskLevel: 'write' });
    expect(result).toMatchObject({ ok: false, code: 'PROJECT_INACTIVE' });
  });

  it('fails closed after disconnect', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
      activeProject: { projectName: 'Demo', documentType: 'pcb' },
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });
    router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId });
    router.disconnect(session.sessionId);

    const result = router.resolve({ userId: 'user_1', riskLevel: 'write' });
    expect(result).toMatchObject({ ok: false, code: 'SESSION_DISCONNECTED' });
  });

  it('rejects expired pairing codes', () => {
    const { router, advance } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({
      userId: 'user_1',
      sessionId: session.sessionId,
      ttlMs: 10,
    });
    advance(11);

    expect(router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId })).toBe(
      false,
    );
  });

  it('rejects pairing with an unknown code or session', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });

    expect(
      router.completePairing({ code: 'EDA-BOGUS', userId: 'user_1', sessionId: session.sessionId }),
    ).toBe(false);
    expect(router.completePairing({ code, userId: 'user_1', sessionId: 'sess_bogus' })).toBe(false);
  });

  it('rejects pairing when the code was scoped to a different session', () => {
    const { router } = makeRouter();
    const session1 = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const session2 = router.registerSession({
      connectionId: 'conn_2',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session1.sessionId });

    expect(router.completePairing({ code, userId: 'user_1', sessionId: session2.sessionId })).toBe(
      false,
    );
  });

  it('allows a pairing code with no session scope to bind to any session', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code = router.createPairingCode({ userId: 'user_1' });

    expect(router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId })).toBe(
      true,
    );
  });

  it('rejects pairing to a disconnected or expired session', () => {
    const { router, advance } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
      ttlMs: 10,
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });
    advance(11);

    expect(router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId })).toBe(
      false,
    );
  });

  it('tracks heartbeats and returns false for unknown or disconnected sessions', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });

    expect(router.heartbeat(session.sessionId)).toBe(true);
    expect(router.heartbeat('sess_bogus')).toBe(false);

    router.disconnect(session.sessionId);
    expect(router.heartbeat(session.sessionId)).toBe(false);
  });

  it('updates the active project and returns false for unknown sessions', () => {
    const { router } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });

    expect(
      router.updateActiveProject(session.sessionId, {
        projectName: 'New',
        documentType: 'pcb',
      }),
    ).toBe(true);
    expect(router.getSession(session.sessionId)?.activeProject).toMatchObject({
      projectName: 'New',
    });
    expect(router.updateActiveProject('sess_bogus')).toBe(false);
  });

  it('disconnect returns false for an unknown session', () => {
    const { router } = makeRouter();
    expect(router.disconnect('sess_bogus')).toBe(false);
  });

  it('resolve returns SESSION_UNPAIRED when there is no session for the user', () => {
    const { router } = makeRouter();
    const result = router.resolve({ userId: 'user_1', riskLevel: 'read' });
    expect(result).toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });
  });

  it('resolve returns SESSION_EXPIRED when the only session has expired', () => {
    const { router, advance } = makeRouter();
    const session = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
      ttlMs: 10,
    });
    const code = router.createPairingCode({ userId: 'user_1', sessionId: session.sessionId });
    router.completePairing({ code, userId: 'user_1', sessionId: session.sessionId });
    advance(11);

    const result = router.resolve({ userId: 'user_1', riskLevel: 'read' });
    expect(result).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
  });

  it('resolve returns SESSION_AMBIGUOUS with multiple active sessions and no sessionId hint', () => {
    const { router } = makeRouter();
    const session1 = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const session2 = router.registerSession({
      connectionId: 'conn_2',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code1 = router.createPairingCode({ userId: 'user_1', sessionId: session1.sessionId });
    const code2 = router.createPairingCode({ userId: 'user_1', sessionId: session2.sessionId });
    router.completePairing({ code: code1, userId: 'user_1', sessionId: session1.sessionId });
    router.completePairing({ code: code2, userId: 'user_1', sessionId: session2.sessionId });

    const result = router.resolve({ userId: 'user_1', riskLevel: 'read' });
    expect(result).toMatchObject({ ok: false, code: 'SESSION_AMBIGUOUS' });
  });

  it('resolve disambiguates with an explicit sessionId among multiple active sessions', () => {
    const { router } = makeRouter();
    const session1 = router.registerSession({
      connectionId: 'conn_1',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const session2 = router.registerSession({
      connectionId: 'conn_2',
      mode: 'hosted',
      extensionVersion: '0.17.1',
    });
    const code1 = router.createPairingCode({ userId: 'user_1', sessionId: session1.sessionId });
    const code2 = router.createPairingCode({ userId: 'user_1', sessionId: session2.sessionId });
    router.completePairing({ code: code1, userId: 'user_1', sessionId: session1.sessionId });
    router.completePairing({ code: code2, userId: 'user_1', sessionId: session2.sessionId });

    const result = router.resolve({
      userId: 'user_1',
      riskLevel: 'read',
      sessionId: session2.sessionId,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.session.sessionId).toBe(session2.sessionId);
    }
  });

  it('getSession returns undefined for an unknown session id', () => {
    const { router } = makeRouter();
    expect(router.getSession('sess_bogus')).toBeUndefined();
  });
});

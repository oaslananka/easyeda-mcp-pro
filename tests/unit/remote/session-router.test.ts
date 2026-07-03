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
});

import { describe, expect, it } from 'vitest';
import {
  RemoteInvocationGrantStore,
  type RemoteInvocationGrantInput,
} from '../../../src/remote/invocation-grants.js';

const NOW = new Date('2026-07-28T00:00:00.000Z');

function issue(
  store: RemoteInvocationGrantStore,
  overrides: Partial<RemoteInvocationGrantInput> = {},
) {
  return store.issue(
    {
      userId: 'user-1',
      sessionId: 'session-1',
      toolName: 'schematic_batch',
      riskLevel: 'write',
      inputHash: 'hash-1',
      ...overrides,
    },
    NOW,
  );
}

describe('RemoteInvocationGrantStore', () => {
  it('issues a private grant bound to user, session, and risk level', () => {
    const store = new RemoteInvocationGrantStore(() => 'fixed', 300_000);
    const grantId = issue(store);

    expect(grantId).toBe('grant_fixed');
    expect(
      store.validate(
        { grantId, userId: 'user-1', sessionId: 'session-1', riskLevel: 'write' },
        NOW,
      ),
    ).toBe(true);
    expect(
      store.validate({ grantId, userId: 'other', sessionId: 'session-1', riskLevel: 'write' }, NOW),
    ).toBe(false);
    expect(
      store.validate({ grantId, userId: 'user-1', sessionId: 'other', riskLevel: 'write' }, NOW),
    ).toBe(false);
    expect(
      store.validate(
        { grantId, userId: 'user-1', sessionId: 'session-1', riskLevel: 'destructive' },
        NOW,
      ),
    ).toBe(false);
  });

  it('expires grants fail closed and removes the expired record', () => {
    const store = new RemoteInvocationGrantStore(() => 'expiring', 1_000);
    const grantId = issue(store);
    const expiredAt = new Date(NOW.getTime() + 1_000);

    expect(
      store.validate(
        { grantId, userId: 'user-1', sessionId: 'session-1', riskLevel: 'write' },
        expiredAt,
      ),
    ).toBe(false);
    expect(store.revoke(grantId)).toBe(false);
  });

  it('revokes a grant once and removes every grant for a disconnected session', () => {
    let sequence = 0;
    const store = new RemoteInvocationGrantStore(() => String(++sequence), 300_000);
    const first = issue(store);
    const second = issue(store, { sessionId: 'session-2' });
    const third = issue(store, { sessionId: 'session-1', riskLevel: 'destructive' });

    expect(store.revoke(first)).toBe(true);
    expect(store.revoke(first)).toBe(false);
    expect(store.deleteForSession('session-1')).toBe(1);
    expect(
      store.validate(
        { grantId: third, userId: 'user-1', sessionId: 'session-1', riskLevel: 'destructive' },
        NOW,
      ),
    ).toBe(false);
    expect(
      store.validate(
        { grantId: second, userId: 'user-1', sessionId: 'session-2', riskLevel: 'write' },
        NOW,
      ),
    ).toBe(true);
  });
});

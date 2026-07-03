import { describe, expect, it } from 'vitest';
import { RemoteSessionRouter } from '../../../src/remote/session-router.js';

describe('router state', () => {
  it('returns false for missing sessions', () => {
    const router = new RemoteSessionRouter(
      () => new Date('2026-07-03T00:00:00.000Z'),
      () => 'id-1',
    );

    expect(router.heartbeat('missing')).toBe(false);
    expect(router.updateActiveProject('missing')).toBe(false);
    expect(router.disconnect('missing')).toBe(false);
    expect(router.getSession('missing')).toBeUndefined();
  });
});

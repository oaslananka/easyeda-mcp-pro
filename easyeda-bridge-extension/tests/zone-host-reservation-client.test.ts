import { describe, expect, it, vi } from 'vitest';
import {
  createHostZoneReservationClient,
  HOST_NATIVE_ZONE_RESERVATION_METHOD,
} from '../src/zone-host-reservation-client.js';
import type { RuntimeTimers } from '../src/runtime-timers.js';

function createHarness() {
  const callbacks = new Map<string, () => void>();
  let nextId = 0;
  let connected = true;
  const timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'> = {
    setTimeout(callback) {
      const id = String(++nextId);
      callbacks.set(id, callback);
      return { source: 'easyeda', kind: 'timeout', id };
    },
    clearTimeout(handle) {
      if (handle?.source === 'easyeda') callbacks.delete(handle.id);
    },
  };
  const requests: Array<{ id: string; type: string; method: string }> = [];
  const send = vi.fn((request: (typeof requests)[number]) => requests.push(request));
  const client = createHostZoneReservationClient(
    { send, isLocalConnected: () => connected, timers },
    25,
  );
  const reply = (result: unknown, id = requests[0]?.id): boolean =>
    client.handleResponse({ id, type: 'response', ok: true, result });
  const grant = () => ({
    granted: true,
    independentRecoveryRequired: true,
    authorizesMutation: false,
  });
  return {
    client,
    requests,
    callbacks,
    send,
    reply,
    grant,
    disconnect: () => {
      connected = false;
      client.reset();
    },
    reconnect: () => {
      connected = true;
    },
    timeout: () => {
      const callback = [...callbacks.values()][0];
      callback?.();
    },
    setConnected: (value: boolean) => (connected = value),
  };
}

describe('private EasyEDA extension host reservation transport', () => {
  it('never sends a reservation when local Bridge is disconnected', async () => {
    const harness = createHarness();
    harness.setConnected(false);
    const action = vi.fn(async () => true);
    await expect(harness.client.exclusive(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('requires an exact matching host grant before executing protected action', async () => {
    const h = createHarness();
    const action = vi.fn(async () => true);
    const attempt = h.client.exclusive(action);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toEqual({
      id: expect.stringMatching(/^host_zone_[0-9]+$/),
      type: 'request',
      method: HOST_NATIVE_ZONE_RESERVATION_METHOD,
    });
    expect(action).not.toHaveBeenCalled();
    expect(h.client.handleResponse({ id: 'unrelated', type: 'response' })).toBe(false);
    expect(h.reply(h.grant(), 'unrelated')).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(h.reply(h.grant())).toBe(true);
    await expect(attempt).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(h.callbacks.size).toBe(0);
    await expect(h.client.exclusive(action)).resolves.toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  it.each([
    ['missing host authorization invariant', { granted: true, independentRecoveryRequired: true }],
    ['only partial grant', { granted: true }],
    [
      'explicit denial',
      { granted: false, independentRecoveryRequired: true, authorizesMutation: false },
    ],
    [
      'client-claimed write authorization',
      { granted: true, independentRecoveryRequired: true, authorizesMutation: true },
    ],
    ['malformed result', 'true'],
  ])('fails closed for %s', async (_label, result) => {
    const h = createHarness();
    const action = vi.fn(async () => true);
    const attempt = h.client.exclusive(action);
    expect(h.reply(result)).toBe(true);
    await expect(attempt).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
  });

  it('denies host error responses, including a returned permission error', async () => {
    const h = createHarness();
    const action = vi.fn(async () => true);
    const attempt = h.client.exclusive(action);
    h.client.handleResponse({
      id: h.requests[0]?.id,
      type: 'response',
      ok: false,
      error: { code: 'BRIDGE_NOT_READY' },
    });
    await expect(attempt).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('treats a lost response as unknown; never retries after the timeout', async () => {
    const h = createHarness();
    const action = vi.fn(async () => true);
    const attempt = h.client.exclusive(action);
    h.timeout();
    await expect(attempt).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(h.reply(h.grant())).toBe(false);
    await expect(h.client.exclusive(action)).resolves.toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  it('invalidates a grant when the socket is replaced or disconnects', async () => {
    const h = createHarness();
    const action = vi.fn(async () => true);
    const attempt = h.client.exclusive(action);
    h.disconnect();
    h.reconnect();
    expect(h.reply(h.grant())).toBe(false);
    await expect(attempt).resolves.toBe(false);
    await expect(h.client.exclusive(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
  });

  it('never assumes a protected callback returning false or throwing is success', async () => {
    for (const action of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw Error('native write unknown');
      }),
    ]) {
      const h = createHarness();
      const attempt = h.client.exclusive(action);
      h.reply(h.grant());
      await expect(attempt).resolves.toBe(false);
      expect(action).toHaveBeenCalledOnce();
      await expect(h.client.exclusive(action)).resolves.toBe(false);
    }
  });

  it('fails closed when a granted protected callback finishes after disconnect', async () => {
    const h = createHarness();
    let finish!: (value: boolean) => void;
    const action = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const attempt = h.client.exclusive(action);
    expect(h.reply(h.grant())).toBe(true);
    await Promise.resolve();
    expect(action).toHaveBeenCalledOnce();
    h.disconnect();
    finish(true);
    await expect(attempt).resolves.toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  it('fails closed if request sending fails before a response', async () => {
    const h = createHarness();
    h.send.mockImplementationOnce(() => {
      throw Error('socket unavailable');
    });
    const action = vi.fn(async () => true);
    await expect(h.client.exclusive(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
    await expect(h.client.exclusive(action)).resolves.toBe(false);
  });
});

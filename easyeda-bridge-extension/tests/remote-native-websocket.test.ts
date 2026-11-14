import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeRemoteWebSocket } from '../src/remote-native-websocket.js';
import { createRuntimeTimers } from '../src/runtime-timers.js';

describe('EasyEDA native WSS adapter', () => {
  const timers = createRuntimeTimers(() => undefined, globalThis as any, 'remote-native-test');

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses documented register/send/close API and delays synchronous native open callback', async () => {
    let onMessage: ((event: unknown) => void) | undefined;
    const api = {
      register: vi.fn(
        (_id: string, _url: string, receive: (value: unknown) => void, open: () => void) => {
          onMessage = receive;
          open(); // Some implementations invoke connectedCallFn synchronously.
        },
      ),
      send: vi.fn(),
      close: vi.fn(),
    };
    const socket = createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers);
    const opened = vi.fn();
    const receive = vi.fn();
    const closed = vi.fn();
    socket.onopen = opened;
    socket.onmessage = receive;
    socket.onclose = closed;

    expect(socket.readyState).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(api.register).toHaveBeenCalledWith(
      expect.stringMatching(/^easyeda-mcp-pro-remote-/),
      'wss://relay.example/remote/relay',
      expect.any(Function),
      expect.any(Function),
    );

    socket.send('{"type":"heartbeat"}');
    expect(api.send).toHaveBeenCalledWith(api.register.mock.calls[0][0], '{"type":"heartbeat"}');
    onMessage?.({ data: '{"type":"session_registered"}' });
    expect(receive).toHaveBeenCalledWith({ data: '{"type":"session_registered"}' });
    socket.close();
    expect(api.close).toHaveBeenCalledWith(api.register.mock.calls[0][0]);
    expect(socket.readyState).toBe(3);
    expect(closed).toHaveBeenCalledTimes(1);
    socket.close();
    onMessage?.({ data: 'late frame' });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes without sending when the native WebSocket never opens', async () => {
    let lateOpen: (() => void) | undefined;
    const api = {
      register: vi.fn(
        (_id: string, _url: string, _receive: (value: unknown) => void, open: () => void) => {
          lateOpen = open;
        },
      ),
      send: vi.fn(),
      close: vi.fn(),
    };
    const socket = createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers);
    const closed = vi.fn();
    const error = vi.fn();
    const opened = vi.fn();
    socket.onclose = closed;
    socket.onerror = error;
    socket.onopen = opened;
    await vi.advanceTimersByTimeAsync(12_001);
    expect(socket.readyState).toBe(3);
    expect(error).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
    lateOpen?.();
    await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('keeps native IDs separate across reconnects and never shares handlers', async () => {
    const api = {
      register: vi.fn(
        (_id: string, _url: string, _receive: (value: unknown) => void, open: () => void) => open(),
      ),
      send: vi.fn(),
      close: vi.fn(),
    };
    const first = createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers);
    await Promise.resolve();
    first.close();
    const second = createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers);
    await Promise.resolve();
    expect(api.register.mock.calls[0][0]).not.toBe(api.register.mock.calls[1][0]);
    second.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a native socket when send fails without replaying the payload', async () => {
    const api = {
      register: vi.fn(
        (_id: string, _url: string, _receive: (value: unknown) => void, open: () => void) => open(),
      ),
      send: vi.fn(() => {
        throw new Error('native send failed');
      }),
      close: vi.fn(),
    };
    const socket = createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers);
    const error = vi.fn();
    const closed = vi.fn();
    socket.onerror = error;
    socket.onclose = closed;
    await Promise.resolve();
    socket.send('single-use-code-is-not-logged');
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
  });

  it('reports denied External Interactions as a permanent setup error', () => {
    const api = {
      register: vi.fn(() => {
        throw new Error('External Interactions is disabled');
      }),
      send: vi.fn(),
      close: vi.fn(),
    };
    expect(() =>
      createNativeRemoteWebSocket('wss://relay.example/remote/relay', api, timers),
    ).toThrow(/Enable External Interactions/);
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

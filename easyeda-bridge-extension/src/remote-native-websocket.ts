import type { RuntimeTimerHandle, RuntimeTimers } from './runtime-timers.js';

export interface NativeWebSocketApi {
  register?: (
    id: string,
    serviceUri: string,
    onMessage: (event: unknown) => void,
    onOpen: () => void,
  ) => void;
  send?: (id: string, data: string) => void;
  close?: (id: string) => void;
}

const OPEN_TIMEOUT_MS = 12_000;
let nextRemoteSocket = 0;

/**
 * Adapt EasyEDA Pro's supported SYS_WebSocket API to the small WebSocket
 * surface RemoteRelayClient consumes. Native register has no close callback:
 * liveness is separately checked by the relay's heartbeat watchdog.
 */
export function createNativeRemoteWebSocket(
  url: string,
  native: NativeWebSocketApi,
  timers: RuntimeTimers,
): WebSocket {
  if (
    typeof native.register !== 'function' ||
    typeof native.send !== 'function' ||
    typeof native.close !== 'function'
  ) {
    throw new Error('EasyEDA native WebSocket API is incomplete.');
  }

  const register = native.register;
  const send = native.send;
  const close = native.close;

  // Per-attempt IDs prevent a failed connection from inheriting the previous
  // serviceUri or message handler (SYS_WebSocket.register caches active IDs).
  const id = `easyeda-mcp-pro-remote-${Date.now().toString(36)}-${++nextRemoteSocket}`;
  let state = 0; // CONNECTING
  let openTimer: RuntimeTimerHandle | null = null;

  const clearOpenTimer = (): void => {
    if (!openTimer) return;
    timers.clearTimeout(openTimer);
    openTimer = null;
  };

  const socket = {
    get readyState() {
      return state;
    },
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((error: unknown) => void) | null,
    onclose: null as (() => void) | null,
    send(data: string) {
      if (state !== 1) throw new Error('Remote Relay socket is not open.');
      try {
        send.call(native, id, data);
      } catch {
        socket.onerror?.(new Error('EasyEDA native WebSocket send failed.'));
        socket.close();
      }
    },
    close() {
      if (state === 3) return;
      state = 3;
      clearOpenTimer();
      try {
        close.call(native, id);
      } catch {
        // Closed in our runtime regardless; never reuse the native ID.
      }
      socket.onclose?.();
    },
  };

  openTimer = timers.setTimeout(() => {
    if (state !== 0) return;
    socket.onerror?.(new Error('EasyEDA native WebSocket open timed out.'));
    socket.close();
  }, OPEN_TIMEOUT_MS);

  try {
    register.call(
      native,
      id,
      url,
      (event) => {
        if (state !== 1) return;
        const data =
          typeof event === 'string'
            ? event
            : typeof event === 'object' && event !== null && 'data' in event
              ? (event as { data?: unknown }).data
              : undefined;
        if (typeof data === 'string') socket.onmessage?.({ data });
      },
      () => {
        if (state !== 0) return;
        state = 1;
        clearOpenTimer();
        // Native callback may fire synchronously during register(). Delay the
        // notification until RemoteRelayClient has installed its listeners.
        void Promise.resolve().then(() => {
          if (state === 1) socket.onopen?.();
        });
      },
    );
  } catch {
    socket.close();
    const error = new Error(
      'EasyEDA native WebSocket is unavailable. Enable External Interactions for MCP Pro Bridge in Extension Manager.',
    ) as Error & { code: string };
    error.code = 'REMOTE_SOCKET_UNAVAILABLE';
    throw error;
  }

  return socket as unknown as WebSocket;
}

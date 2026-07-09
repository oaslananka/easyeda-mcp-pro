import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteRelayClient } from '../src/remote-client.js';

const OPEN = 1;
const CLOSED = 3;

type Listener = (() => void) | ((event: { data: unknown }) => void);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  readonly sent: string[] = [];
  readyState = 0;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fail(): void {
    this.onerror?.();
  }

  close(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function makeClient() {
  const log = vi.fn();
  const showToast = vi.fn();
  const executeToolRequest = vi.fn(async () => ({ ok: true }));
  const client = new RemoteRelayClient({
    extensionVersion: '0.24.2',
    log,
    showToast,
    readActiveProject: () => ({ projectName: 'Fixture', documentType: 'schematic' }),
    executeToolRequest,
  });
  return { client, log, showToast, executeToolRequest };
}

function relayMessage(type: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: '2026-07-remote-relay-v1',
    messageId: `msg_${type}`,
    timestamp: new Date().toISOString(),
    type,
    ...extra,
  };
}

describe('RemoteRelayClient resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('schedules and performs reconnect after a transient close', async () => {
    const { client } = makeClient();

    client.connect({ mode: 'self_hosted', relayUrl: 'wss://relay.example/session' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].open();

    FakeWebSocket.instances[0].close();

    expect(client.getStatus()).toMatchObject({
      state: 'connecting',
      reconnectAttempts: 1,
      nextReconnectDelayMs: 1000,
      lastError: 'Remote Relay disconnected',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe('wss://relay.example/session');
  });

  it('does not reconnect after explicit user disconnect', async () => {
    const { client } = makeClient();

    client.connect({ mode: 'hosted', relayUrl: 'wss://relay.example/session' });
    FakeWebSocket.instances[0].open();
    client.disconnect('user_disabled');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toMatchObject({ state: 'disconnected', sessionId: undefined });
  });

  it('updates heartbeat liveness and echoes heartbeat messages', () => {
    const { client } = makeClient();

    client.connect({ mode: 'hosted', relayUrl: 'wss://relay.example/session' });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive(relayMessage('heartbeat'));

    expect(client.getStatus().lastHeartbeatAt).toBeDefined();
    const sentTypes = socket.sent.map((data) => JSON.parse(data).type);
    expect(sentTypes).toContain('register_session');
    expect(sentTypes).toContain('heartbeat');
  });

  it('closes stale heartbeat sockets so the normal close path reconnects', async () => {
    const { client, log } = makeClient();

    client.connect({ mode: 'hosted', relayUrl: 'wss://relay.example/session' });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(socket.readyState).toBe(CLOSED);
    expect(client.getStatus()).toMatchObject({
      state: 'connecting',
      reconnectAttempts: 1,
      nextReconnectDelayMs: 1000,
    });
    expect(log).toHaveBeenCalledWith('Remote Relay heartbeat stale; closing socket to reconnect');
  });

  it('records the paired session id from the relay registration response', () => {
    const { client } = makeClient();

    client.connect({
      mode: 'hosted',
      relayUrl: 'wss://relay.example/session',
      pairingCode: '123456',
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive(relayMessage('session_registered', { paired: true, sessionId: 'sess_1' }));

    expect(client.getStatus()).toMatchObject({
      state: 'paired',
      sessionId: 'sess_1',
      pairingCode: '123456',
    });
  });
});

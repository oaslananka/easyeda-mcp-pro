import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_PORT,
  HEARTBEAT_TIMEOUT_MS,
  PORT_SCAN_COUNT,
  RECONNECT_BASE_MS,
  REGISTER_OPEN_CALLBACK_TIMEOUT_MS,
} from '../src/connection-policy.js';

const GLOBAL_KEYS = [
  '__easyedaMcpProBridgeRuntime_v8__',
  'connect',
  'disconnect',
  'showStatus',
  'connectRemoteRelay',
  'disconnectRemoteRelay',
  'showRemoteRelayStatus',
  'enableAutoConnect',
  'disableAutoConnect',
  'toggleAutoConnect',
  'activate',
  'deactivate',
  'sys_Message',
  'sys_Storage',
  'sys_WebSocket',
  'sys_Dialog',
  'eda',
  'WebSocket',
] as const;

type ExtensionModule = typeof import('../src/index.js');
type LocalBehavior = 'pending' | 'error' | 'success';

class HarnessSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: HarnessSocket[] = [];
  static localBehavior: LocalBehavior = 'pending';
  static localHello: Record<string, unknown> = {
    type: 'hello',
    contractVersion: 1,
    supportedProtocolVersions: ['1.0.0'],
  };

  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    HarnessSocket.instances.push(this);
    if (!url.startsWith('ws://127.0.0.1:')) return;
    queueMicrotask(() => {
      if (HarnessSocket.localBehavior === 'error') {
        this.onerror?.(new Error('connection refused'));
      } else if (HarnessSocket.localBehavior === 'success') {
        this.open();
      }
    });
  }

  open(): void {
    if (this.readyState === HarnessSocket.OPEN) return;
    this.readyState = HarnessSocket.OPEN;
    this.onopen?.();
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(payload: string): void {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    this.sent.push(parsed);
    if (this.url.startsWith('ws://127.0.0.1:') && parsed.type === 'handshake') {
      queueMicrotask(() => this.receive(HarnessSocket.localHello));
    }
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === HarnessSocket.CLOSED) return;
    this.readyState = HarnessSocket.CLOSED;
    this.onclose?.();
  }
}

let loaded: ExtensionModule | undefined;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function loadExtension(
  options: {
    autoConnect?: boolean;
    withWebSocket?: boolean;
    webSocketApi?: Record<string, unknown>;
    dialog?: {
      showConfirmationMessage: (
        content: string,
        title?: string,
        approveTitle?: string,
        rejectTitle?: string,
        callback?: (approved: boolean) => void,
      ) => void;
    };
  } = {},
): Promise<{
  extension: ExtensionModule;
  toasts: string[];
  storage: { autoConnect: boolean };
}> {
  const toasts: string[] = [];
  const storage = { autoConnect: options.autoConnect ?? false };
  vi.stubGlobal('sys_Message', {
    showToastMessage: (message: string) => toasts.push(message),
  });
  vi.stubGlobal('sys_Storage', {
    getExtensionUserConfig: () => storage.autoConnect,
    setExtensionUserConfig: async (_key: string, value: boolean) => {
      storage.autoConnect = value;
      return true;
    },
  });
  if (options.withWebSocket) vi.stubGlobal('WebSocket', HarnessSocket);
  if (options.webSocketApi) vi.stubGlobal('sys_WebSocket', options.webSocketApi);
  if (options.dialog) vi.stubGlobal('sys_Dialog', options.dialog);
  vi.resetModules();
  loaded = await import('../src/index.js');
  await flushMicrotasks();
  return { extension: loaded, toasts, storage };
}

function latestRemoteSocket(): HarnessSocket {
  const socket = HarnessSocket.instances.findLast((item) => item.url.startsWith('wss://'));
  if (!socket) throw new Error('remote socket was not created');
  return socket;
}

function approvalRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: '2026-07-remote-relay-v1',
    messageId: 'msg_approval',
    timestamp: new Date().toISOString(),
    type: 'approval_request',
    approvalId: 'approval_1',
    toolName: 'schematic.addText',
    riskLevel: 'write',
    actionSummary: 'Add a schematic note',
    inputHash: '1234567890abcdef',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
    ...extra,
  };
}

describe('extension loader lifecycle source', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    HarnessSocket.instances = [];
    HarnessSocket.localBehavior = 'pending';
    HarnessSocket.localHello = {
      type: 'hello',
      contractVersion: 1,
      supportedProtocolVersions: ['1.0.0'],
    };
    for (const key of GLOBAL_KEYS) Reflect.deleteProperty(globalThis, key);
  });

  afterEach(() => {
    loaded?.deactivate();
    loaded = undefined;
    for (const key of GLOBAL_KEYS) Reflect.deleteProperty(globalThis, key);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('honors disabled auto-connect activation without allocating timers', async () => {
    const { extension, toasts } = await loadExtension({ autoConnect: false });

    await extension.activate('onStartupFinished');

    expect(toasts).toContain('MCP Bridge: Auto-Connect OFF — click Connect to connect');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('persists auto-connect transitions and cancels scheduled recovery when disabled', async () => {
    const { extension, toasts, storage } = await loadExtension({ autoConnect: false });

    await extension.enableAutoConnect();

    expect(storage.autoConnect).toBe(true);
    expect(toasts.at(-1)).toBe('Auto-Connect: ON — will reconnect automatically');
    expect(vi.getTimerCount()).toBe(1);

    await extension.disableAutoConnect();

    expect(storage.autoConnect).toBe(false);
    expect(toasts.at(-1)).toBe('Auto-Connect: OFF — use Connect button to connect');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back from a silent register handle to the EasyEDA create API', async () => {
    HarnessSocket.localBehavior = 'success';
    const registeredIds: string[] = [];
    const closedIds: string[] = [];
    let createCalls = 0;
    const { extension, toasts } = await loadExtension({
      webSocketApi: {
        register: (id: string) => registeredIds.push(id),
        send: () => undefined,
        close: (id: string) => closedIds.push(id),
        create: (url: string) => {
          createCalls += 1;
          return new HarnessSocket(url);
        },
      },
    });

    const connecting = extension.connect();
    await vi.advanceTimersByTimeAsync(REGISTER_OPEN_CALLBACK_TIMEOUT_MS);
    await flushMicrotasks();
    await connecting;

    expect(registeredIds).toHaveLength(1);
    expect(closedIds).toEqual(registeredIds);
    expect(createCalls).toBe(1);
    expect(toasts).toContain('MCP Bridge connected to local server');
  });

  it('scans every local port once, then recovers on the scheduled retry', async () => {
    HarnessSocket.localBehavior = 'error';
    const { extension, toasts } = await loadExtension({ withWebSocket: true });

    await extension.connect();

    const firstScan = HarnessSocket.instances.filter((item) => item.url.startsWith('ws://'));
    expect(firstScan).toHaveLength(PORT_SCAN_COUNT);
    expect(firstScan.map((item) => item.url)).toEqual(
      Array.from(
        { length: PORT_SCAN_COUNT },
        (_, offset) => `ws://127.0.0.1:${BRIDGE_PORT + offset}`,
      ),
    );
    expect(toasts.at(-1)).toContain('MCP Bridge offline: no local server found');

    HarnessSocket.localBehavior = 'success';
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await flushMicrotasks();

    extension.showStatus();
    expect(toasts.at(-1)).toContain('MCP Bridge connected to local server');
    expect(HarnessSocket.instances).toHaveLength(PORT_SCAN_COUNT + 1);
  });

  it('suppresses duplicate auto-connect calls while one handshake is pending', async () => {
    HarnessSocket.localBehavior = 'pending';
    const { extension } = await loadExtension({ withWebSocket: true });

    const first = extension.connect('auto');
    const second = extension.connect('auto');

    expect(HarnessSocket.instances).toHaveLength(1);
    HarnessSocket.instances[0].open();
    await flushMicrotasks();
    await Promise.all([first, second]);

    expect(HarnessSocket.instances).toHaveLength(1);
    expect(HarnessSocket.instances[0].sent).toContainEqual(
      expect.objectContaining({ type: 'handshake' }),
    );
  });

  it('closes a heartbeat-stale socket and releases all reconnect resources on deactivate', async () => {
    HarnessSocket.localBehavior = 'success';
    const { extension } = await loadExtension({ autoConnect: true, withWebSocket: true });

    await extension.connect();
    const socket = HarnessSocket.instances[0];
    expect(socket.readyState).toBe(HarnessSocket.OPEN);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 15_000);

    expect(socket.closeCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    extension.deactivate();

    expect(vi.getTimerCount()).toBe(0);
    expect(Reflect.has(globalThis, '__easyedaMcpProBridgeRuntime_v8__')).toBe(false);
    loaded = undefined;
  });

  it('logs protocol and contract mismatch diagnostics without losing the connection', async () => {
    HarnessSocket.localBehavior = 'success';
    HarnessSocket.localHello = {
      type: 'hello',
      contractVersion: 99,
      supportedProtocolVersions: ['9.9.9'],
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { extension, toasts } = await loadExtension({ withWebSocket: true });

    await extension.connect();

    const logText = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logText).toContain('Bridge hello contract version mismatch');
    expect(logText).toContain('\"expected\":1,\"actual\":99');
    expect(logText).toContain('Bridge hello does not include this extension protocol version');
    expect(logText).toContain('\"protocolVersion\":\"1.0.0\"');
    expect(toasts).toContain('MCP Bridge connected to local server');
  });

  it('returns approval timeout when the EasyEDA dialog remains unanswered', async () => {
    const { extension } = await loadExtension({
      withWebSocket: true,
      dialog: { showConfirmationMessage: () => undefined },
    });
    extension.connectRemoteRelay('self_hosted', 'wss://relay.example/session', '123456');
    const socket = latestRemoteSocket();
    socket.open();
    socket.receive(approvalRequest());

    await vi.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'approval_result',
        approvalId: 'approval_1',
        result: 'timeout',
      }),
    );
  });

  it('returns explicit rejection and never treats it as approval', async () => {
    const { extension } = await loadExtension({
      withWebSocket: true,
      dialog: {
        showConfirmationMessage: (_content, _title, _approve, _reject, callback) =>
          callback?.(false),
      },
    });
    extension.connectRemoteRelay('hosted', 'wss://relay.example/session');
    const socket = latestRemoteSocket();
    socket.open();
    socket.receive(approvalRequest());
    await flushMicrotasks();

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'approval_result',
        approvalId: 'approval_1',
        result: 'rejected',
      }),
    );
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ result: 'approved' }));
  });

  it('deactivate closes both local and Remote Relay sockets and clears every timer', async () => {
    HarnessSocket.localBehavior = 'success';
    const { extension } = await loadExtension({ autoConnect: true, withWebSocket: true });
    await extension.connect();
    const localSocket = HarnessSocket.instances[0];

    extension.connectRemoteRelay('self_hosted', 'wss://relay.example/session', '123456');
    const remoteSocket = latestRemoteSocket();
    remoteSocket.open();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    extension.deactivate();

    expect(localSocket.closeCalls).toBeGreaterThan(0);
    expect(remoteSocket.closeCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    loaded = undefined;
  });
});

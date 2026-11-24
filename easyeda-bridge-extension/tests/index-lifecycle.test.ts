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
  'connectCustomRemote',
  'connectHostedCloud',
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
    trustedSettings?: Map<string, unknown>;
    webSocketApi?: Record<string, unknown>;
    prompt?: (text: string, initial?: string) => string | null;
    dialog?: {
      showInputDialog?: (
        before?: string,
        after?: string,
        title?: string,
        type?: string,
        value?: string | number,
        options?: Record<string, unknown>,
        callback?: (value: unknown) => void,
      ) => void;
      showConfirmationMessage?: (
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
  trustedSettings: Map<string, unknown>;
}> {
  const toasts: string[] = [];
  const storage = { autoConnect: options.autoConnect ?? false };
  vi.stubGlobal('sys_Message', {
    showToastMessage: (message: string) => toasts.push(message),
  });
  const trustedSettings = options.trustedSettings ?? new Map<string, unknown>();
  vi.stubGlobal('sys_Storage', {
    getExtensionUserConfig: (key: string) =>
      key === 'autoConnect' ? storage.autoConnect : trustedSettings.get(key),
    setExtensionUserConfig: async (key: string, value: unknown) => {
      if (key === 'autoConnect') storage.autoConnect = value === true;
      else trustedSettings.set(key, value);
      return true;
    },
    deleteExtensionUserConfig: async (key: string) => {
      trustedSettings.delete(key);
      return true;
    },
  });
  if (options.withWebSocket) vi.stubGlobal('WebSocket', HarnessSocket);
  if (options.prompt) vi.stubGlobal('prompt', options.prompt);
  if (options.webSocketApi) vi.stubGlobal('sys_WebSocket', options.webSocketApi);
  if (options.dialog) vi.stubGlobal('sys_Dialog', options.dialog);
  vi.resetModules();
  loaded = await import('../src/index.js');
  await flushMicrotasks();
  return { extension: loaded, toasts, storage, trustedSettings };
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

  it('reports an actionable permission hint when EasyEDA denies socket registration', async () => {
    const { extension, toasts } = await loadExtension({
      webSocketApi: {
        register: () => {
          throw new Error('External interactions permission denied');
        },
        send: () => undefined,
      },
    });
    await extension.connect();
    expect(toasts).toContain(
      'External Interactions permission: enable MCP Pro Bridge in Extension Manager.',
    );
  });

  it('reports safe local and Remote Relay connection fallbacks without opening remote sockets', async () => {
    const { extension, toasts } = await loadExtension();
    await extension.connectCustomRemote();
    expect(toasts).toContain('EasyEDA input dialog is unavailable. Local MCP remains available.');

    extension.connectRemoteRelay('hosted');
    expect(toasts.join(' | ')).toContain(
      'Remote Relay requires EasyEDA WebSocket and External Interactions permission; Local is still available.',
    );

    extension.disconnectRemoteRelay();
    expect(toasts.at(-1)).toBe('Remote Relay off. Use Connect for the local bridge.');
    expect(HarnessSocket.instances).toHaveLength(0);
  });

  it('explains that manual local disconnection requires a new Connect action', async () => {
    HarnessSocket.localBehavior = 'success';
    const { extension, toasts } = await loadExtension({ withWebSocket: true });
    await extension.connect();
    extension.disconnect();
    expect(toasts.at(-1)).toBe('Bridge disconnected. Click Connect to resume.');
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
    expect(toasts.at(-1)).toMatch(/build [A-Za-z0-9-]+/);
    expect(HarnessSocket.instances).toHaveLength(PORT_SCAN_COUNT + 1);
  });

  it('reports the editor version from the documented native environment API', async () => {
    HarnessSocket.localBehavior = 'success';
    const getEditorCurrentVersion = vi.fn(() => '3.2.209');
    const getVersion = vi.fn(() => 'unsupported-old-method');
    vi.stubGlobal('eda', { sys_Environment: { getEditorCurrentVersion, getVersion } });
    const { extension } = await loadExtension({ withWebSocket: true });

    await extension.connect();

    const handshake = HarnessSocket.instances[0].sent.find(
      (message) => message.type === 'handshake',
    );
    expect(handshake).toMatchObject({ easyedaVersion: '3.2.209' });
    expect(getEditorCurrentVersion).toHaveBeenCalledOnce();
    expect(getVersion).not.toHaveBeenCalled();
  });

  it('omits unavailable editor version rather than inventing a runtime version', async () => {
    HarnessSocket.localBehavior = 'success';
    vi.stubGlobal('eda', {
      sys_Environment: {
        getEditorCurrentVersion: () => {
          throw new Error('unavailable');
        },
      },
    });
    const { extension } = await loadExtension({ withWebSocket: true });

    await extension.connect();

    const handshake = HarnessSocket.instances[0].sent.find(
      (message) => message.type === 'handshake',
    );
    expect(handshake?.easyedaVersion).toBeUndefined();
  });

  it.each([undefined, null, '   ', 123, Promise.resolve('3.2.209')])(
    'does not stringify an unsupported native editor-version return value (%s)',
    async (returnValue) => {
      HarnessSocket.localBehavior = 'success';
      vi.stubGlobal('eda', {
        sys_Environment: { getEditorCurrentVersion: () => returnValue },
      });
      const { extension } = await loadExtension({ withWebSocket: true });
      await extension.connect();
      const handshake = HarnessSocket.instances[0].sent.find(
        (message) => message.type === 'handshake',
      );
      expect(handshake?.easyedaVersion).toBeUndefined();
    },
  );

  it('keeps the documented sys_Environment receiver when reading editor version', async () => {
    HarnessSocket.localBehavior = 'success';
    const environment = {
      version: '3.2.209',
      getEditorCurrentVersion() {
        if (this !== environment) throw new Error('lost native environment receiver');
        return this.version;
      },
    };
    vi.stubGlobal('eda', { sys_Environment: environment });
    const { extension } = await loadExtension({ withWebSocket: true });
    await extension.connect();
    const handshake = HarnessSocket.instances[0].sent.find(
      (message) => message.type === 'handshake',
    );
    expect(handshake?.easyedaVersion).toBe('3.2.209');
  });

  it.each(['manual', 'auto'] as const)(
    'identifies %s connection intent in the local handshake',
    async (intent) => {
      HarnessSocket.localBehavior = 'success';
      const { extension } = await loadExtension({ withWebSocket: true });
      await extension.connect(intent);
      expect(HarnessSocket.instances[0].sent).toContainEqual(
        expect.objectContaining({ type: 'handshake', connectionIntent: intent }),
      );
    },
  );

  it('stops automatic scanning when another editor owns the local bridge, then allows explicit Connect', async () => {
    HarnessSocket.localBehavior = 'pending';
    const { extension, toasts } = await loadExtension({ autoConnect: true, withWebSocket: true });
    HarnessSocket.localHello = { type: 'local_connection_busy' };
    const pending = extension.connect('auto');
    HarnessSocket.instances[0].open();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS + 1000);
    expect(HarnessSocket.instances).toHaveLength(1);
    expect(toasts.at(-1)).toContain('Connect to switch');
    await pending;
    HarnessSocket.localHello = {
      type: 'hello',
      contractVersion: 1,
      supportedProtocolVersions: ['1.0.0'],
    };
    HarnessSocket.localBehavior = 'success';
    await extension.connect();
    expect(HarnessSocket.instances[1].sent).toContainEqual(
      expect.objectContaining({ type: 'handshake', connectionIntent: 'manual' }),
    );
  });

  it('clears displaced local ownership immediately instead of reconnecting automatically', async () => {
    HarnessSocket.localBehavior = 'success';
    const { extension, toasts } = await loadExtension({ autoConnect: true, withWebSocket: true });
    await extension.connect();
    HarnessSocket.instances[0].receive({ type: 'local_connection_busy' });
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS + 1000);
    expect(HarnessSocket.instances).toHaveLength(1);
    expect(HarnessSocket.instances[0].readyState).toBe(HarnessSocket.CLOSED);
    expect(toasts.at(-1)).toContain('Connect to switch');
    await extension.connect();
    expect(HarnessSocket.instances).toHaveLength(2);
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
    expect(logText).toContain('"expected":1,"actual":99');
    expect(logText).toContain('Bridge hello does not include this extension protocol version');
    expect(logText).toContain('"protocolVersion":"1.0.0"');
    expect(toasts).toContain('MCP Bridge connected to local server');
  });

  it('offers opt-in Custom Remote and returns to Local without competing sockets', async () => {
    HarnessSocket.localBehavior = 'success';
    const prompts = ['wss://pcb.example.com/remote/relay', 'eda-abcdef12'];
    const { extension, toasts, storage } = await loadExtension({
      autoConnect: true,
      withWebSocket: true,
      prompt: () => prompts.shift() ?? null,
    });
    await extension.activate('onStartupFinished');
    await flushMicrotasks();
    const local = HarnessSocket.instances.find((socket) => socket.url.startsWith('ws://'));
    expect(local).toBeDefined();
    expect(local?.readyState).toBe(HarnessSocket.OPEN);

    await extension.connectCustomRemote();
    expect(local?.closeCalls).toBeGreaterThan(0);
    const remote = latestRemoteSocket();
    remote.open();
    await flushMicrotasks(); // Native focused-document identity resolves before registration.
    expect(remote.sent).toContainEqual(
      expect.objectContaining({
        type: 'register_session',
        mode: 'self_hosted',
        pairingCode: 'EDA-ABCDEF12',
      }),
    );
    extension.showStatus();
    expect(toasts.at(-1)).toContain('Custom Cloud: connected');
    expect(storage.autoConnect).toBe(true); // Local preference remains intact for later sessions.

    await extension.activate('onStartupFinished');
    await flushMicrotasks();
    expect(HarnessSocket.instances.filter((socket) => socket.url.startsWith('ws://'))).toHaveLength(
      1,
    );

    await extension.connect(); // The original Connect menu remains the Local entry point.
    expect(remote.closeCalls).toBeGreaterThan(0);
    expect(HarnessSocket.instances.filter((socket) => socket.url.startsWith('ws://'))).toHaveLength(
      2,
    );
    extension.showStatus();
    expect(toasts.at(-1)).toContain('connected to local server');
  });

  it('does not incorrectly claim an open PCB is missing before remote pairing', async () => {
    const { extension, toasts } = await loadExtension({
      withWebSocket: true,
      prompt: () => 'EDA-ABCDEF12',
    });

    extension.showRemoteRelayStatus();
    expect(toasts.at(-1)).toContain('project: not yet reported');

    await extension.connectHostedCloud();
    extension.showRemoteRelayStatus();
    expect(toasts.at(-1)).toContain('project: not yet reported');
    expect(toasts.at(-1)).not.toContain('no active project detected');
  });

  it('connects to the official hosted relay with a one-time code, keeping Local as the default', async () => {
    HarnessSocket.localBehavior = 'success';
    const prompts = ['bad-code', 'eda-abcdef12'];
    const { extension, toasts, storage } = await loadExtension({
      autoConnect: true,
      withWebSocket: true,
      prompt: () => prompts.shift() ?? null,
    });
    await extension.activate('onStartupFinished');
    await flushMicrotasks();
    const local = HarnessSocket.instances.find((socket) => socket.url.startsWith('ws://'));
    expect(local?.readyState).toBe(HarnessSocket.OPEN);

    await extension.connectHostedCloud();
    expect(local?.closeCalls).toBe(0);
    expect(
      HarnessSocket.instances.filter((socket) => socket.url.startsWith('wss://')),
    ).toHaveLength(0);
    expect(toasts.join(' | ')).toContain('valid EDA-');

    await extension.connectHostedCloud();
    const remote = latestRemoteSocket();
    expect(remote.url).toBe('wss://easyeda-mcp-pro.oaslananka.dev/remote/relay');
    expect(local?.closeCalls).toBeGreaterThan(0);
    remote.open();
    await flushMicrotasks();
    expect(remote.sent).toContainEqual(
      expect.objectContaining({
        type: 'register_session',
        mode: 'hosted',
        pairingCode: 'EDA-ABCDEF12',
      }),
    );
    expect(storage.autoConnect).toBe(true);
    await extension.connect();
    expect(remote.closeCalls).toBeGreaterThan(0);
  });

  it('keeps one remote socket for Cloud connect, status and disconnect after an extension hot import', async () => {
    const { toasts } = await loadExtension({
      withWebSocket: true,
      prompt: () => 'EDA-ABCDEF12',
    });
    const firstRuntime = (globalThis as any).__easyedaMcpProBridgeRuntime_v8__;
    vi.resetModules();
    const reloaded = await import('../src/index.js');
    expect((globalThis as any).__easyedaMcpProBridgeRuntime_v8__).toBe(firstRuntime);

    await reloaded.connectHostedCloud();
    const remote = latestRemoteSocket();
    remote.open();
    await flushMicrotasks();
    reloaded.showRemoteRelayStatus();
    expect(toasts.at(-1)).toContain('EasyEDA MCP Pro Cloud: connected');
    expect(toasts.at(-1)).not.toContain('disabled/disconnected');

    reloaded.disconnectRemoteRelay();
    expect(remote.closeCalls).toBeGreaterThan(0);
  });

  it('cancels a pending Cloud pairing when Disconnect is used after a hot import', async () => {
    const callbacks: Array<(answer: unknown) => void> = [];
    await loadExtension({
      withWebSocket: true,
      dialog: {
        showInputDialog: (_before, _after, _title, _type, _value, _options, callback) => {
          if (callback) callbacks.push(callback);
        },
      },
    });
    vi.resetModules();
    const reloaded = await import('../src/index.js');

    const pending = reloaded.connectHostedCloud();
    expect(callbacks).toHaveLength(1);
    reloaded.disconnectRemoteRelay();
    callbacks[0]?.('EDA-ABCDEF12');
    await pending;
    expect(
      HarnessSocket.instances.filter((socket) => socket.url.startsWith('wss://')),
    ).toHaveLength(0);
  });

  it('pairs through EasyEDA native input and SYS_WebSocket without browser prompt/WebSocket', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let socketId = '';
    let receiveNative: ((event: unknown) => void) | undefined;
    const native = {
      register: vi.fn(
        (id: string, _url: string, receive: (event: unknown) => void, onOpen: () => void) => {
          socketId = id;
          receiveNative = receive;
          queueMicrotask(onOpen);
        },
      ),
      send: vi.fn((_id: string, data: string) => sent.push(JSON.parse(data))),
      close: vi.fn(),
    };
    const input = vi.fn(
      (
        _before?: string,
        _after?: string,
        _title?: string,
        _type?: string,
        _value?: string | number,
        _options?: Record<string, unknown>,
        callback?: (value: unknown) => void,
      ) => callback?.('eda-abcdef12'),
    );
    const { extension, toasts } = await loadExtension({
      webSocketApi: native,
      dialog: { showInputDialog: input },
    });
    expect(Reflect.has(globalThis, 'WebSocket')).toBe(false);
    expect(Reflect.has(globalThis, 'prompt')).toBe(false);
    await extension.connectHostedCloud();
    await flushMicrotasks();

    expect(input).toHaveBeenCalledTimes(1);
    expect(input.mock.calls[0]?.[0]).toContain('easyeda-mcp-pro.oaslananka.dev/cloud');
    expect(input.mock.calls[0]?.[0]).toContain('EDA-XXXXXXXX');
    expect(native.register).toHaveBeenCalledWith(
      expect.stringContaining('easyeda-mcp-pro-remote-'),
      'wss://easyeda-mcp-pro.oaslananka.dev/remote/relay',
      expect.any(Function),
      expect.any(Function),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'register_session',
        mode: 'hosted',
        pairingCode: 'EDA-ABCDEF12',
      }),
    );
    expect(native.send).toHaveBeenCalledWith(socketId, expect.any(String));
    receiveNative?.({
      data: JSON.stringify({
        protocolVersion: '2026-07-remote-relay-v1',
        type: 'session_registered',
        messageId: 'ack_1',
        sessionId: 'sess_native',
        timestamp: new Date().toISOString(),
        paired: true,
      }),
    });
    extension.showRemoteRelayStatus();
    expect(toasts.at(-1)).toContain('EasyEDA MCP Pro Cloud: paired');
    extension.disconnectRemoteRelay();
    expect(native.close).toHaveBeenCalledWith(socketId);
  });

  it('does not connect when the native dialog is cancelled or its answer arrives after Local wins', async () => {
    const native = { register: vi.fn(), send: vi.fn(), close: vi.fn() };
    const callbacks: Array<(value: unknown) => void> = [];
    const input = vi.fn(
      (
        _before?: string,
        _after?: string,
        _title?: string,
        _type?: string,
        _value?: string | number,
        _options?: Record<string, unknown>,
        callback?: (value: unknown) => void,
      ) => {
        if (callback) callbacks.push(callback);
      },
    );
    const { extension } = await loadExtension({
      webSocketApi: native,
      dialog: { showInputDialog: input },
    });
    const cancelled = extension.connectHostedCloud();
    callbacks[0]?.(undefined);
    await cancelled;
    expect(native.register).not.toHaveBeenCalled();
    const pending = extension.connectHostedCloud();
    extension.disconnectRemoteRelay();
    callbacks[1]?.('EDA-ABCDEF12');
    await pending;
    expect(native.register).not.toHaveBeenCalled();
  });

  it('reports denied native External Interactions once instead of retrying an unusable socket', async () => {
    const native = {
      register: vi.fn(() => {
        throw new Error('external permission denied');
      }),
      send: vi.fn(),
      close: vi.fn(),
    };
    const { extension, toasts } = await loadExtension({
      webSocketApi: native,
      dialog: {
        showInputDialog: (_before, _after, _title, _type, _value, _options, callback) =>
          callback?.('EDA-ABCDEF12'),
      },
    });
    await extension.connectHostedCloud();
    await flushMicrotasks();
    expect(native.register).toHaveBeenCalledTimes(1);
    expect(toasts.join(' | ')).toMatch(/Enable External Interactions/);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(native.register).toHaveBeenCalledTimes(1);
    extension.showStatus();
    expect(toasts.at(-1)).not.toContain('Remote Relay:');
  });

  it('keeps Local connected when Custom Remote dialog is cancelled or unsafe', async () => {
    HarnessSocket.localBehavior = 'success';
    const prompts = ['ws://insecure.example/relay', 'wss://pcb.example/relay', 'bad-code'];
    const { extension, toasts } = await loadExtension({
      withWebSocket: true,
      prompt: () => prompts.shift() ?? null,
    });
    await extension.connect();
    await extension.connectCustomRemote();
    await extension.connectCustomRemote();
    await extension.connectCustomRemote();
    expect(
      HarnessSocket.instances.filter((socket) => socket.url.startsWith('wss://')),
    ).toHaveLength(0);
    expect(HarnessSocket.instances[0].closeCalls).toBe(0);
    expect(toasts.join(' | ')).toMatch(/secure wss|valid EDA-/i);
  });

  it('explains approval expiry and ignores late clicks on an unanswered native dialog', async () => {
    let promptContent = '';
    let lateCallback: ((approved: boolean) => void) | undefined;
    const { extension, toasts } = await loadExtension({
      withWebSocket: true,
      dialog: {
        showConfirmationMessage: (content, _title, _approve, _reject, callback) => {
          promptContent = content;
          lateCallback = callback;
        },
      },
    });
    extension.connectRemoteRelay('self_hosted', 'wss://relay.example/session', '123456');
    const socket = latestRemoteSocket();
    socket.open();
    socket.receive(approvalRequest());

    expect(promptContent).toMatch(/Valid for \d+s\. Reject after expiry\./);
    expect(promptContent).toContain('Reject');

    await vi.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();

    expect(toasts.some((message) => message.includes('Expired: reject, retry.'))).toBe(true);
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'approval_result',
        approvalId: 'approval_1',
        result: 'timeout',
      }),
    );
    lateCallback?.(true);
    await flushMicrotasks();
    expect(socket.sent.filter((message) => message.type === 'approval_result')).toHaveLength(1);
  });

  it('refuses approval clicked after its deadline even if the timer callback has not run', async () => {
    let lateCallback: ((approved: boolean) => void) | undefined;
    const { extension } = await loadExtension({
      withWebSocket: true,
      dialog: {
        showConfirmationMessage: (_content, _title, _approve, _reject, callback) => {
          lateCallback = callback;
        },
      },
    });
    extension.connectRemoteRelay('self_hosted', 'wss://relay.example/session', '123456');
    const socket = latestRemoteSocket();
    socket.open();
    socket.receive(approvalRequest());

    // Advance wall-clock time without running the pending timeout callback.
    vi.setSystemTime(Date.now() + 1_001);
    lateCallback?.(true);
    await flushMicrotasks();

    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: 'approval_result', result: 'timeout' }),
    );
    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: 'approval_result', result: 'approved' }),
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
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    extension.deactivate();

    expect(localSocket.closeCalls).toBeGreaterThan(0);
    expect(remoteSocket.closeCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    loaded = undefined;
  });
});

describe('opt-in Hosted Cloud device trust across real extension lifecycle boundaries', () => {
  const TRUST_KEY = 'easyedaMcpProHostedDeviceTrustV1';
  const firstCredential = 'ers_' + 'a'.repeat(64);
  const rotatedCredential = 'ers_' + 'b'.repeat(64);

  beforeEach(() => {
    vi.useFakeTimers();
    HarnessSocket.instances = [];
    HarnessSocket.localBehavior = 'pending';
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

  it('requires explicit native consent, then auto-resumes a trusted owner without reusing the pairing code', async () => {
    const trustedSettings = new Map<string, unknown>();
    const input = vi.fn(
      (_before, _after, _title, _type, _value, _options, callback?: (value: unknown) => void) =>
        callback?.('EDA-ABCDEF12'),
    );
    const confirm = vi.fn(
      (_content, _title, _approve, _cancel, callback?: (accepted: boolean) => void) =>
        callback?.(true),
    );
    const first = await loadExtension({
      withWebSocket: true,
      trustedSettings,
      dialog: { showInputDialog: input, showConfirmationMessage: confirm },
    });
    await first.extension.activate('onStartupFinished');
    expect(
      HarnessSocket.instances.filter((socket) => socket.url.startsWith('wss://')),
    ).toHaveLength(0);
    await first.extension.connectHostedCloud();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('not an OS keychain'),
      expect.stringContaining('Remember Cloud'),
      'Remember 23h',
      'This session only',
      expect.any(Function),
    );
    const initial = latestRemoteSocket();
    initial.open();
    await flushMicrotasks();
    expect(initial.sent).toContainEqual(
      expect.objectContaining({ type: 'register_session', pairingCode: 'EDA-ABCDEF12' }),
    );
    initial.receive({
      protocolVersion: '2026-07-remote-relay-v1',
      messageId: 'first_paired',
      type: 'session_registered',
      timestamp: new Date().toISOString(),
      paired: true,
      sessionId: 'sess_owner_1',
      resumeCredential: firstCredential,
    });
    await flushMicrotasks();
    expect(trustedSettings.get(TRUST_KEY)).toMatchObject({ credential: firstCredential });

    // Simulated full process exit: the runtime is discarded but EasyEDA
    // extension user settings survive in its separate native profile.
    first.extension.deactivate();
    HarnessSocket.instances = [];
    const second = await loadExtension({ withWebSocket: true, trustedSettings });
    await second.extension.activate('onStartupFinished');
    const resumed = latestRemoteSocket();
    resumed.open();
    await flushMicrotasks();
    expect(resumed.sent).toContainEqual(
      expect.objectContaining({
        type: 'register_session',
        mode: 'hosted',
        resumeCredential: firstCredential,
      }),
    );
    expect(resumed.sent.find((m) => m.type === 'register_session')).not.toHaveProperty(
      'pairingCode',
    );
    resumed.receive({
      protocolVersion: '2026-07-remote-relay-v1',
      messageId: 'owner_resumed',
      type: 'session_registered',
      timestamp: new Date().toISOString(),
      paired: true,
      sessionId: 'sess_owner_2',
      resumeCredential: rotatedCredential,
    });
    await flushMicrotasks();
    expect(trustedSettings.get(TRUST_KEY)).toMatchObject({ credential: rotatedCredential });
    second.extension.disconnectRemoteRelay();
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(false);
    expect(JSON.stringify(second.toasts)).not.toContain(rotatedCredential);
  });

  it.each(['connect', 'disconnect', 'disconnectRemoteRelay'] as const)(
    'forgets remembered Cloud trust on explicit %s after failed Cloud startup',
    async (command) => {
      const trustedSettings = new Map<string, unknown>([
        [TRUST_KEY, { version: 1, credential: firstCredential, expiresAt: Date.now() + 60_000 }],
      ]);
      const { extension } = await loadExtension({ trustedSettings });
      await extension.activate('onStartupFinished');
      expect(trustedSettings.has(TRUST_KEY)).toBe(true);

      // Native/browser transport is unavailable; the startup fallback is Local.
      // An explicit Local choice must still remove the remembered Cloud trust.
      await extension[command]();
      await flushMicrotasks();
      expect(trustedSettings.has(TRUST_KEY)).toBe(false);

      extension.deactivate();
      HarnessSocket.instances = [];
      const restarted = await loadExtension({ withWebSocket: true, trustedSettings });
      await restarted.extension.activate('onStartupFinished');
      expect(HarnessSocket.instances.filter((s) => s.url.startsWith('wss://'))).toHaveLength(0);
    },
  );

  it('retains remembered trust during automatic Local fallback until an explicit Local choice', async () => {
    const trustedSettings = new Map<string, unknown>([
      [TRUST_KEY, { version: 1, credential: firstCredential, expiresAt: Date.now() + 60_000 }],
    ]);
    const { extension } = await loadExtension({ trustedSettings, autoConnect: true });
    await extension.activate('onStartupFinished');
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(true);

    await extension.connect('auto');
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(true);
    await extension.connect();
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(false);
  });

  it('clears persisted trust on explicit Local selection after native Cloud registration is denied', async () => {
    const trustedSettings = new Map<string, unknown>([
      [TRUST_KEY, { version: 1, credential: firstCredential, expiresAt: Date.now() + 60_000 }],
    ]);
    const { extension } = await loadExtension({
      trustedSettings,
      webSocketApi: {
        register: () => {
          throw new Error('External interactions permission denied');
        },
        send: () => undefined,
        close: () => undefined,
      },
    });
    await extension.activate('onStartupFinished');
    expect(trustedSettings.has(TRUST_KEY)).toBe(true);

    await extension.connect();
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(false);
  });

  it('defaults to session-only when a native remember choice is refused', async () => {
    const trustedSettings = new Map<string, unknown>();
    const extension = await loadExtension({
      withWebSocket: true,
      trustedSettings,
      dialog: {
        showInputDialog: (_before, _after, _title, _type, _value, _options, cb) =>
          cb?.('EDA-ABCDEF12'),
        showConfirmationMessage: (_text, _title, _yes, _no, cb) => cb?.(false),
      },
    });
    await extension.extension.connectHostedCloud();
    const socket = latestRemoteSocket();
    socket.open();
    await flushMicrotasks();
    socket.receive({
      protocolVersion: '2026-07-remote-relay-v1',
      messageId: 'session_only',
      type: 'session_registered',
      timestamp: new Date().toISOString(),
      paired: true,
      resumeCredential: firstCredential,
    });
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(false);
    extension.extension.deactivate();
    HarnessSocket.instances = [];
    const restarted = await loadExtension({ withWebSocket: true, trustedSettings });
    await restarted.extension.activate('onStartupFinished');
    expect(HarnessSocket.instances.filter((s) => s.url.startsWith('wss://'))).toHaveLength(0);
  });

  it('erases expired or revoked trusted sessions rather than silently claiming pairing', async () => {
    const trustedSettings = new Map<string, unknown>([
      [TRUST_KEY, { version: 1, credential: firstCredential, expiresAt: Date.now() + 60_000 }],
    ]);
    const { extension, toasts } = await loadExtension({ withWebSocket: true, trustedSettings });
    await extension.activate('onStartupFinished');
    const socket = latestRemoteSocket();
    socket.open();
    await flushMicrotasks();
    socket.receive({
      protocolVersion: '2026-07-remote-relay-v1',
      messageId: 'session_unpaired',
      type: 'session_registered',
      timestamp: new Date().toISOString(),
      paired: false,
    });
    await flushMicrotasks();
    expect(trustedSettings.has(TRUST_KEY)).toBe(false);
    expect(toasts.join(' | ')).toContain('new pairing code');
  });
});

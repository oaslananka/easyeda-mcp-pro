// The loader: socket lifecycle, handshake, heartbeat and menu glue for the
// MCP bridge extension. Every actual EasyEDA API interaction lives in the
// dispatcher module (dispatcher.ts), which is baked in here as the fallback
// and can be hot-swapped over the bridge in dev mode without re-importing
// the .eext.
import {
  BRIDGE_PORT,
  getLocalBridgeConnectionAttempts,
  hasHeartbeatTimedOut,
  HEARTBEAT_INTERVAL_MS,
  isServerActivityMessage,
  reconnectDelayMs,
  shouldReconnectAfterSocketFailure,
} from './connection-policy.js';
import {
  RemoteRelayClient,
  type RemoteApprovalDecision,
  type RemoteApprovalPrompt,
  type RemoteRelayMode,
} from './remote-client.js';
import { createDispatcher } from './dispatcher.js';
import type { Dispatcher, DispatcherToolkit } from './toolkit.js';
import {
  createRuntimeTimers,
  type EasyedaTimerApi,
  type RuntimeTimerHandle,
} from './runtime-timers.js';
import { isRecord, log, readPath, type JsonValue } from './utils.js';

declare const eda: EasyedaGlobal | undefined;
declare const EDA: unknown | undefined;
declare const api: unknown | undefined;
declare const ESYS_ToastMessageType: { INFO?: unknown } | undefined;
declare const SYS_WebSocket: EasyedaWebSocketApi | undefined;
declare const SYS_Message: EasyedaMessageApi | undefined;

// Injected at build time via environment variable or build script
declare const BRIDGE_SESSION_TOKEN: string | undefined;
// Compile-time hot-swap gate: true only in dev builds (scripts/build.mjs with
// MCP_DEV_HOTSWAP=true). In marketplace builds the whole hot-swap path is dead
// code, so a published .eext can never eval a pushed bundle.
declare const __MCP_DEV_HOTSWAP__: boolean | undefined;

// Single source for the extension version; sync-versions.mjs patches the
// literal below (first `extensionVersion: '...'` match in this file).
const EXTENSION_INFO = {
  extensionVersion: '0.34.0', // x-release-please-version
};

// Safe accessors for optional EasyEDA Pro runtime globals.
// Never reference optional globals directly; they may not exist in the eval context.

function getWsApi(): EasyedaWebSocketApi | undefined {
  return typeof SYS_WebSocket !== 'undefined'
    ? SYS_WebSocket
    : readPath<EasyedaWebSocketApi>(getGlobal(), 'sys_WebSocket');
}

function getSysMessage(): EasyedaMessageApi | undefined {
  return typeof SYS_Message !== 'undefined'
    ? SYS_Message
    : readPath<EasyedaMessageApi>(getGlobal(), 'sys_Message');
}

function getInfoToastType(): string {
  const info =
    typeof ESYS_ToastMessageType !== 'undefined' ? ESYS_ToastMessageType.INFO : undefined;
  return typeof info === 'string' ? info : 'info';
}

type ConnectMode = 'manual' | 'auto';
type ConnectionState = 'disconnected' | 'connecting' | 'connected';
type InboundMessageType = 'hello' | 'heartbeat' | 'request' | 'ignored';

interface EasyedaGlobal {
  [key: string]: unknown;
  activate?: () => Promise<void>;
  deactivate?: () => void;
  connect?: (mode?: ConnectMode) => Promise<void>;
  disconnect?: () => void;
  showStatus?: () => void;
  enableAutoConnect?: () => Promise<void>;
  disableAutoConnect?: () => Promise<void>;
  connectRemoteRelay?: (
    mode?: Exclude<RemoteRelayMode, 'disabled'>,
    relayUrl?: string,
    pairingCode?: string,
  ) => void;
  disconnectRemoteRelay?: () => void;
  showRemoteRelayStatus?: () => void;
}

interface EasyedaWebSocketApi {
  register?: (
    id: string,
    url: string,
    onMessage: (event: unknown) => void,
    onOpen?: () => void,
  ) => void;
  send?: (id: string, data: string) => void;
  close?: (id: string) => void;
  create?: (url: string) => EasyedaSocket;
}

interface EasyedaMessageApi {
  showToastMessage?: (message: string, messageType?: string) => void;
}

interface EasyedaDialogApi {
  showConfirmationMessage?: (
    content: string,
    title?: string,
    mainButtonTitle?: string,
    buttonTitle?: string,
    callbackFn?: (mainButtonClicked: boolean) => void,
  ) => void;
}

interface EasyedaToastApi {
  showMessage?: (message: string, messageType?: string) => void;
}

interface EasyedaSocket {
  onopen?: () => void;
  onmessage?: (event: { data?: unknown } | unknown) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  send?: (data: string) => void;
  close?: () => void;
}

interface BridgeRequest {
  id: string;
  type: 'request';
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

interface BridgeResponse {
  id: string;
  type: 'response';
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    suggestion: string;
    data?: unknown;
  };
  durationMs: number;
}

interface SocketHandle {
  type: 'easyeda-register' | 'easyeda-create' | 'browser';
  id?: string;
  raw?: EasyedaSocket | WebSocket;
}

const BRIDGE_PROTOCOL = 'easyeda-mcp-pro.bridge';
const BRIDGE_VERSION = '1.0.0';
const BRIDGE_CONTRACT_VERSION = 1;
const LOOPBACK_HOST = ['127', '0', '0', '1'].join('.');
const SOCKET_ID = 'easyeda-mcp-pro-bridge';

let socketHandle: SocketHandle | null = null;
let connectedPort: number | null = null;
let preferredPort = BRIDGE_PORT;
let connectionState: ConnectionState = 'disconnected';
let activeConnectPromise: Promise<void> | null = null;
let reconnectAttempts = 0;
let connectRunId = 0;
let manualDisconnectRequested = false;
let reconnectTimer: RuntimeTimerHandle | null = null;
let heartbeatTimer: RuntimeTimerHandle | null = null;
let lastServerActivityMs = 0;
let externalInteractionWarningShown = false;
// Updated from the server's `hello` message; matches BRIDGE_MAX_PAYLOAD_SIZE default
// until the handshake completes.
let bridgeMaxPayloadSize = 1_048_576;
// From the server's hello: whether it reassembles chunked frames (A5) and the
// aggregate cap for one chunked payload. When unset, fall back to single-frame
// sends limited by bridgeMaxPayloadSize, exactly as before.
let serverSupportsChunking = false;
let maxAggregatePayloadSize = 1_048_576;
// From the server's hello: whether it accepts hot-swap pushes (dev mode only).
let serverHotSwapEnabled = false;

function getGlobal(): EasyedaGlobal | null {
  if (typeof eda !== 'undefined' && eda) return eda;
  return globalThis as unknown as EasyedaGlobal;
}

const runtimeTimers = createRuntimeTimers(
  () => readPath<EasyedaTimerApi>(getGlobal(), 'sys_Timer'),
  globalThis as any,
  SOCKET_ID,
);

function showToast(message: string): void {
  const safeMessage = String(message);
  const messageType = getInfoToastType();

  const sysMessage = getSysMessage();
  if (sysMessage?.showToastMessage) {
    try {
      sysMessage.showToastMessage(safeMessage, messageType);
      return;
    } catch (error) {
      log('sysMessage.showToastMessage failed', { message: safeMessage, error: String(error) });
    }
  }

  const toastMessage = readPath<EasyedaToastApi>(getGlobal(), 'sys_ToastMessage');
  if (toastMessage?.showMessage) {
    try {
      toastMessage.showMessage(safeMessage, messageType);
      return;
    } catch (error) {
      log('toastMessage.showMessage failed', { message: safeMessage, error: String(error) });
    }
  }

  log(safeMessage);
}

function showExternalInteractionHintOnce(error?: unknown): void {
  const message =
    'MCP Bridge needs EasyEDA External Interactions permission. Enable it in Extension Manager for MCP Pro Bridge.';
  log(message, error);
  if (externalInteractionWarningShown) return;
  externalInteractionWarningShown = true;
  showToast(message);
}

// ── Dispatcher wiring ────────────────────────────────────────────────────────
// The toolkit hands the dispatcher everything it needs from the loader. All
// runtime globals go through it so the identical dispatcher code works baked
// (extension script scope) and hot-swapped (AsyncFunction eval scope).

const dispatcherToolkit: DispatcherToolkit = {
  getEda: () => {
    if (typeof eda !== 'undefined' && eda) return eda;
    return (globalThis as { eda?: unknown }).eda;
  },
  getEDA: () => {
    if (typeof EDA !== 'undefined' && EDA) return EDA;
    return (globalThis as { EDA?: unknown }).EDA;
  },
  getApi: () => {
    if (typeof api !== 'undefined' && api) return api;
    return (globalThis as { api?: unknown }).api;
  },
  getGlobal: () => getGlobal(),
  log,
  showToast,
  // With chunked sends (A5) a single logical payload may span many frames, so
  // the dispatcher's binary self-limit is the aggregate cap, not the frame cap.
  getBridgeMaxPayloadSize: () =>
    serverSupportsChunking ? maxAggregatePayloadSize : bridgeMaxPayloadSize,
  getBridgeVersion: () => BRIDGE_VERSION,
};

const bakedDispatcher: Dispatcher = createDispatcher(dispatcherToolkit);
let activeDispatcher: Dispatcher = bakedDispatcher;

function dispatchViaActive(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return activeDispatcher.dispatch(method, params);
}

// ── Hot-swap machinery (dev builds only) ─────────────────────────────────────
// The MCP server (with BRIDGE_HOT_SWAP_ENABLED=true) pushes a freshly built
// dispatcher bundle as system.hotSwap.begin/chunk/commit; commit verifies the
// sha256, evals the bundle via AsyncFunction (same mechanism as api.execute),
// and atomically swaps the active dispatcher. These methods are handled here
// in the loader — BEFORE the dispatcher — so a broken pushed dispatcher can
// always be replaced or reverted.

const HOTSWAP_COMPILED = typeof __MCP_DEV_HOTSWAP__ !== 'undefined' && __MCP_DEV_HOTSWAP__ === true;

interface HotSwapBuffer {
  chunks: Array<string | undefined>;
  totalChunks: number;
  byteLength: number;
  sha256: string;
  buildId: string;
  received: number;
  bytes: number;
}

let hotSwapBuffer: HotSwapBuffer | null = null;
// Same algorithm as the server's computeMethodRegistryHash: sha256 of the
// sorted method list joined by ',', hex, first 16 chars. Sent in the
// handshake so a stale dispatcher fails loudly server-side.
let activeMethodListHash = '';

async function sha256Hex(text: string): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) {
    throw newLoaderError(
      'EASYEDA_API_ERROR',
      'crypto.subtle is not available in this runtime',
      'Hot swap and method-list hashing require a secure context.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newLoaderError(code: string, message: string, suggestion: string): Error {
  const error = new Error(message);
  Object.assign(error, { code, suggestion });
  return error;
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function refreshMethodListHash(): Promise<void> {
  try {
    // Locale-independent ordering: must produce byte-identical input to the
    // server's computeMethodRegistryHash (do NOT use localeCompare here).
    const sorted = [...activeDispatcher.methodList].sort(compareCodeUnits);
    activeMethodListHash = (await sha256Hex(sorted.join(','))).slice(0, 16);
  } catch (error) {
    log('failed to compute method list hash', String(error));
    activeMethodListHash = '';
  }
}

function loaderStatus(): Record<string, unknown> {
  return {
    loaderVersion: EXTENSION_INFO.extensionVersion,
    bridgeVersion: BRIDGE_VERSION,
    activeDispatcher: activeDispatcher === bakedDispatcher ? 'baked' : 'pushed',
    buildId: activeDispatcher.buildId,
    bakedBuildId: bakedDispatcher.buildId,
    methodCount: activeDispatcher.methodList.length,
    methodListHash: activeMethodListHash,
    hotSwapCompiled: HOTSWAP_COMPILED,
    hotSwapEnabled: HOTSWAP_COMPILED && serverHotSwapEnabled,
  };
}

function assertHotSwapAllowed(): void {
  if (!HOTSWAP_COMPILED) {
    throw newLoaderError(
      'DEV_MODE_REQUIRED',
      'This extension build does not include hot-swap support.',
      'Import a dev build of the extension (scripts/build.mjs with MCP_DEV_HOTSWAP=true).',
    );
  }
  if (!serverHotSwapEnabled) {
    throw newLoaderError(
      'DEV_MODE_REQUIRED',
      'The connected MCP server has not enabled hot swap.',
      'Start the server with BRIDGE_HOT_SWAP_ENABLED=true (non-production only).',
    );
  }
}

async function commitHotSwap(): Promise<unknown> {
  const buffer = hotSwapBuffer;
  hotSwapBuffer = null;
  if (!buffer) {
    throw newLoaderError(
      'INVALID_PARAMS',
      'No hot-swap transfer in progress',
      'Send system.hotSwap.begin and all chunks before commit.',
    );
  }
  if (buffer.received !== buffer.totalChunks) {
    throw newLoaderError(
      'INVALID_PARAMS',
      `Hot-swap transfer incomplete: ${buffer.received}/${buffer.totalChunks} chunks received`,
      'Resend the bundle from system.hotSwap.begin.',
    );
  }
  const source = buffer.chunks.join('');
  const actualByteLength = new TextEncoder().encode(source).byteLength;
  if (actualByteLength !== buffer.byteLength) {
    throw newLoaderError(
      'INVALID_PARAMS',
      `Hot-swap bundle size mismatch: expected ${buffer.byteLength} bytes, got ${actualByteLength}`,
      'Resend the bundle from system.hotSwap.begin.',
    );
  }
  const actualSha = await sha256Hex(source);
  if (actualSha !== buffer.sha256) {
    throw newLoaderError(
      'UNAUTHORIZED',
      'Hot-swap bundle sha256 verification failed',
      'Resend the bundle from system.hotSwap.begin.',
    );
  }

  const globalScope = globalThis as { __mcpDispatcherFactory?: unknown };
  delete globalScope.__mcpDispatcherFactory;
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as FunctionConstructor;
  try {
    const run = new AsyncFunction(source) as () => Promise<void>;
    await run();
  } catch (error) {
    delete globalScope.__mcpDispatcherFactory;
    throw newLoaderError(
      'EASYEDA_API_ERROR',
      `Hot-swap bundle failed to evaluate: ${String(error)}`,
      'The previous dispatcher remains active. Fix the bundle and push again.',
    );
  }
  const factory = globalScope.__mcpDispatcherFactory;
  delete globalScope.__mcpDispatcherFactory;
  if (typeof factory !== 'function') {
    throw newLoaderError(
      'EASYEDA_API_ERROR',
      'Hot-swap bundle did not register __mcpDispatcherFactory',
      'Build the bundle from dispatcher-entry.ts (pnpm build in the extension package).',
    );
  }

  const candidate = (factory as (toolkit: DispatcherToolkit) => Dispatcher)(dispatcherToolkit);
  if (
    !candidate ||
    typeof candidate.dispatch !== 'function' ||
    !Array.isArray(candidate.methodList) ||
    typeof candidate.buildId !== 'string'
  ) {
    throw newLoaderError(
      'EASYEDA_API_ERROR',
      'Hot-swap factory returned an invalid dispatcher',
      'The previous dispatcher remains active. Fix the bundle and push again.',
    );
  }

  activeDispatcher = candidate;
  await refreshMethodListHash();
  log(`hot-swapped dispatcher to build ${candidate.buildId}`);
  showToast(`MCP Bridge: dispatcher hot-swapped (${candidate.buildId})`);
  return {
    swapped: true,
    buildId: candidate.buildId,
    methodCount: candidate.methodList.length,
    methodListHash: activeMethodListHash,
  };
}

/**
 * Loader-level methods, handled before the dispatcher so they keep working
 * even when a pushed dispatcher is broken. Returns handled:false for every
 * regular bridge method.
 */
async function handleLoaderMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<{ handled: boolean; result?: unknown }> {
  switch (method) {
    case 'system.loaderStatus':
      return { handled: true, result: loaderStatus() };
    case 'system.hotSwap.begin': {
      assertHotSwapAllowed();
      const totalChunks = Number(params.totalChunks);
      const byteLength = Number(params.byteLength);
      const sha256 = String(params.sha256 ?? '');
      const buildId = String(params.buildId ?? '');
      if (
        !Number.isInteger(totalChunks) ||
        totalChunks < 1 ||
        totalChunks > 4096 ||
        !Number.isInteger(byteLength) ||
        byteLength < 1 ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        !buildId
      ) {
        throw newLoaderError(
          'INVALID_PARAMS',
          'system.hotSwap.begin requires totalChunks, byteLength, sha256 and buildId',
          'Use the server-side pushDispatcher helper.',
        );
      }
      hotSwapBuffer = {
        chunks: new Array<string | undefined>(totalChunks),
        totalChunks,
        byteLength,
        sha256,
        buildId,
        received: 0,
        bytes: 0,
      };
      return { handled: true, result: { ready: true, buildId } };
    }
    case 'system.hotSwap.chunk': {
      assertHotSwapAllowed();
      const buffer = hotSwapBuffer;
      const seq = Number(params.seq);
      const data = typeof params.data === 'string' ? params.data : undefined;
      if (!buffer) {
        throw newLoaderError(
          'INVALID_PARAMS',
          'No hot-swap transfer in progress',
          'Send system.hotSwap.begin first.',
        );
      }
      if (!Number.isInteger(seq) || seq < 0 || seq >= buffer.totalChunks || data === undefined) {
        throw newLoaderError(
          'INVALID_PARAMS',
          'system.hotSwap.chunk requires a valid seq and data',
          'Use the server-side pushDispatcher helper.',
        );
      }
      if (buffer.chunks[seq] === undefined) {
        buffer.received += 1;
        buffer.bytes += data.length;
      } else {
        buffer.bytes += data.length - (buffer.chunks[seq]?.length ?? 0);
      }
      // Defensive cap: never buffer more than 4x the announced size.
      if (buffer.bytes > buffer.byteLength * 4) {
        hotSwapBuffer = null;
        throw newLoaderError(
          'INVALID_PARAMS',
          'Hot-swap transfer exceeded the announced byteLength budget',
          'Resend the bundle from system.hotSwap.begin.',
        );
      }
      buffer.chunks[seq] = data;
      return {
        handled: true,
        result: { received: buffer.received, totalChunks: buffer.totalChunks },
      };
    }
    case 'system.hotSwap.commit': {
      assertHotSwapAllowed();
      return { handled: true, result: await commitHotSwap() };
    }
    case 'system.hotSwap.revert': {
      assertHotSwapAllowed();
      hotSwapBuffer = null;
      const wasPushed = activeDispatcher !== bakedDispatcher;
      activeDispatcher = bakedDispatcher;
      await refreshMethodListHash();
      if (wasPushed) {
        log('reverted to baked dispatcher');
        showToast('MCP Bridge: reverted to baked dispatcher');
      }
      return {
        handled: true,
        result: { reverted: wasPushed, buildId: activeDispatcher.buildId },
      };
    }
    default:
      return { handled: false };
  }
}

// ── Remote relay ─────────────────────────────────────────────────────────────

let remoteRelayClient: RemoteRelayClient | null = null;

function requestRemoteApproval(prompt: RemoteApprovalPrompt): Promise<RemoteApprovalDecision> {
  const dialog = readPath<EasyedaDialogApi>(getGlobal(), 'sys_Dialog');
  const expiresAtMs = Date.parse(prompt.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return Promise.resolve('timeout');
  }
  const showConfirmationMessage = dialog?.showConfirmationMessage?.bind(dialog);
  if (!showConfirmationMessage) {
    log('Remote approval dialog unavailable', { toolName: prompt.toolName });
    showToast('Remote approval dialog is unavailable; request rejected.');
    return Promise.resolve('rejected');
  }

  return new Promise<RemoteApprovalDecision>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (decision: RemoteApprovalDecision): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(decision);
    };
    timer = setTimeout(() => finish('timeout'), Math.max(0, expiresAtMs - Date.now()));

    const project = prompt.activeProject?.projectName ?? 'current EasyEDA project';
    const summary = [
      prompt.actionSummary,
      `Method: ${prompt.toolName}`,
      `Risk: ${prompt.riskLevel}`,
      `Project: ${project}`,
      `Input hash: ${prompt.inputHash.slice(0, 12)}`,
    ].join('\n');
    try {
      showConfirmationMessage(
        summary,
        'Remote MCP Approval',
        'Approve',
        'Reject',
        (mainButtonClicked) => finish(mainButtonClicked ? 'approved' : 'rejected'),
      );
    } catch (error) {
      log('Remote approval dialog failed', error);
      finish('rejected');
    }
  });
}

function getRemoteRelayClient(): RemoteRelayClient {
  remoteRelayClient ??= new RemoteRelayClient({
    extensionVersion: EXTENSION_INFO.extensionVersion,
    log,
    showToast,
    readActiveProject: readRemoteActiveProject,
    executeToolRequest: (toolName, input) =>
      dispatchViaActive(toolName, isRecord(input) ? input : {}),
    requestApproval: requestRemoteApproval,
    timers: runtimeTimers,
    createWebSocket: (url) => {
      const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (typeof WebSocketCtor !== 'function') {
        throw new Error('WebSocket is unavailable in the EasyEDA extension runtime.');
      }
      return new WebSocketCtor(url);
    },
  });
  return remoteRelayClient;
}

function readRemoteActiveProject():
  | { projectName?: string; documentType: 'schematic' | 'pcb' | 'unknown'; url?: string }
  | undefined {
  const href = typeof location !== 'undefined' ? location.href : undefined;
  const title = typeof document !== 'undefined' ? document.title : undefined;
  const projectName = title && title.trim() ? title.trim() : undefined;
  if (!href && !projectName) return undefined;
  const lower = `${href ?? ''} ${projectName ?? ''}`.toLowerCase();
  const documentType = lower.includes('pcb')
    ? 'pcb'
    : lower.includes('sch')
      ? 'schematic'
      : 'unknown';
  return { projectName, documentType, url: href };
}

function connectRemoteRelayInternal(
  mode: Exclude<RemoteRelayMode, 'disabled'> = 'hosted',
  relayUrl?: string,
  pairingCode?: string,
): void {
  getRemoteRelayClient().connect({ mode, relayUrl, pairingCode });
}

function disconnectRemoteRelayInternal(): void {
  getRemoteRelayClient().disconnect('user_disabled');
  showToast('Remote Relay disabled');
}

function showRemoteRelayStatusInternal(): void {
  const status = getRemoteRelayClient().getStatus();
  const project = status.activeProject?.projectName ?? 'no active project detected';
  const retry =
    status.nextReconnectDelayMs !== undefined
      ? ` | retry: ${Math.ceil(status.nextReconnectDelayMs / 1000)}s`
      : '';
  const attempts =
    status.reconnectAttempts && status.reconnectAttempts > 0
      ? ` | attempts: ${status.reconnectAttempts}`
      : '';
  const error = status.lastError ? ` | last error: ${status.lastError}` : '';
  showToast(
    `Remote Relay: ${status.mode}/${status.state} | project: ${project}${attempts}${retry}${error}`,
  );
}

// ── Socket lifecycle ─────────────────────────────────────────────────────────

function createSocket(
  id: string,
  url: string,
  onOpen: () => void,
  onMessage: (data: string) => void,
  onClose: () => void,
  onError: (error: unknown) => void,
): SocketHandle | null {
  const sysWs = getWsApi();

  // Try easyeda-register first (may throw if external interaction is denied).
  // Only the API's real connected callback may mark the socket open. Calling
  // onOpen speculatively while WebSocket.readyState is CONNECTING makes send()
  // throw and closes an otherwise healthy loopback connection.
  if (sysWs?.register && sysWs.send) {
    let openFired = false;
    const fireOpen = (): void => {
      if (openFired) return;
      openFired = true;
      onOpen();
    };

    try {
      sysWs.register(
        id,
        url,
        (event) => onMessage(String(isRecord(event) && 'data' in event ? event.data : event)),
        fireOpen,
      );
      return { type: 'easyeda-register', id };
    } catch (err) {
      showExternalInteractionHintOnce(err);
      log('register() threw, falling through', err);
    }
  }

  // Fallback: easyeda-create (different API path, may have different permissions)
  if (sysWs?.create) {
    try {
      const socket = sysWs.create(url);
      socket.onopen = onOpen;
      socket.onmessage = (event) => onMessage(String(isRecord(event) ? event.data : event));
      socket.onclose = onClose;
      socket.onerror = onError;
      return { type: 'easyeda-create', raw: socket };
    } catch (err) {
      log('create() threw, falling through', err);
    }
  }

  // Last resort: raw browser WebSocket (works outside extension sandbox)
  if (typeof WebSocket !== 'undefined') {
    try {
      const socket = new WebSocket(url);
      socket.onopen = onOpen;
      socket.onmessage = (event) => onMessage(String(event.data));
      socket.onclose = onClose;
      socket.onerror = onError;
      return { type: 'browser', raw: socket };
    } catch (err) {
      log('WebSocket() threw', err);
    }
  }

  return null;
}

let chunkIdCounter = 0;

function send(data: JsonValue): void {
  const payload = JSON.stringify(data);

  // A5: split payloads that would exceed the server's per-frame cap into
  // chunk envelopes the server reassembles. An oversized single frame closes
  // the whole connection (code 4009); chunking turns that into a normal send.
  // Only used when the server's hello advertised chunk support.
  if (serverSupportsChunking && payload.length > Math.floor(bridgeMaxPayloadSize / 2)) {
    // JSON-escaping a payload slice can inflate it (quotes/backslashes), so
    // budget a quarter of the frame cap per chunk to stay comfortably under.
    const chunkSize = Math.max(16_384, Math.floor(bridgeMaxPayloadSize / 4));
    const total = Math.ceil(payload.length / chunkSize);
    const id = `chk_${Date.now()}_${++chunkIdCounter}`;
    for (let seq = 0; seq < total; seq += 1) {
      sendRaw(
        JSON.stringify({
          type: 'chunk',
          id,
          seq,
          total,
          data: payload.slice(seq * chunkSize, (seq + 1) * chunkSize),
        }),
      );
    }
    return;
  }

  sendRaw(payload);
}

function sendRaw(payload: string): void {
  const sysWs = getWsApi();

  if (socketHandle?.type === 'easyeda-register' && sysWs?.send) {
    try {
      sysWs.send(socketHandle.id ?? SOCKET_ID, payload);
      return;
    } catch (err) {
      log('sysWs.send threw exception', err);
      recoverConnection('Bridge send failed; reconnecting');
    }
    return;
  }

  try {
    socketHandle?.raw?.send?.(payload);
  } catch (err) {
    log('socket raw send threw exception', err);
    recoverConnection('Bridge socket send failed; reconnecting');
  }
}

function closeHandle(handle: SocketHandle | null): void {
  if (!handle) return;

  const sysWs = getWsApi();
  if (handle.type === 'easyeda-register' && sysWs?.close) {
    try {
      sysWs.close(handle.id ?? SOCKET_ID);
      return;
    } catch (err) {
      log('sysWs.close threw exception', err);
    }
    return;
  }

  try {
    handle.raw?.close?.();
  } catch (err) {
    log('handle raw close threw exception', err);
  }
}

function closeSocket(): void {
  closeHandle(socketHandle);
  socketHandle = null;
  connectedPort = null;
  connectionState = 'disconnected';
  lastServerActivityMs = 0;
}

function recoverConnection(reason: string): void {
  const wasConnected = connectionState === 'connected' && connectedPort !== null;
  const wasConnecting = connectionState === 'connecting';
  if (!wasConnected && !wasConnecting && !socketHandle) return;

  log(reason);
  stopHeartbeat();
  closeHandle(socketHandle);
  socketHandle = null;
  connectedPort = null;
  lastServerActivityMs = 0;

  if (wasConnecting) {
    // A failed handshake is one failed port attempt, not a disconnected session.
    // Keep the scan state intact so connectToPort can time out and continue.
    connectionState = 'connecting';
    return;
  }

  connectionState = 'disconnected';
  if (
    shouldReconnectAfterSocketFailure({
      wasConnected,
      manualDisconnectRequested,
      autoConnectEnabled,
    })
  ) {
    scheduleReconnect();
  }
}

function sendHandshake(): void {
  const sessionToken =
    typeof BRIDGE_SESSION_TOKEN !== 'undefined' ? BRIDGE_SESSION_TOKEN : undefined;
  const handshake: Record<string, unknown> = {
    type: 'handshake',
    protocol: BRIDGE_PROTOCOL,
    protocolVersion: BRIDGE_VERSION,
    contractVersion: BRIDGE_CONTRACT_VERSION,
    clientName: 'easyeda-mcp-pro',
    extensionVersion: EXTENSION_INFO.extensionVersion,
    easyedaVersion: getEasyedaVersion(),
    devMode: false,
    loaderVersion: EXTENSION_INFO.extensionVersion,
  };
  // Lets the server fail loudly when this extension serves stale dispatch
  // logic. Computed asynchronously at startup/swap; omitted if not ready yet.
  if (activeMethodListHash) {
    handshake.methodListHash = activeMethodListHash;
  }
  if (sessionToken) {
    handshake.sessionToken = sessionToken;
  }
  send(handshake as JsonValue);
}

function getEasyedaVersion(): string | undefined {
  const maybeVersion = readPath<unknown>(getGlobal(), 'sys_Environment.getVersion');
  if (typeof maybeVersion === 'function') {
    try {
      return String(maybeVersion());
    } catch (error) {
      log('failed to read EasyEDA version', String(error));
      return undefined;
    }
  }
  return undefined;
}

function startHeartbeat(): void {
  stopHeartbeat();
  lastServerActivityMs = Date.now();
  heartbeatTimer = runtimeTimers.setInterval(() => {
    if (connectedPort === null) return;
    const nowMs = Date.now();
    if (hasHeartbeatTimedOut(lastServerActivityMs, nowMs)) {
      recoverConnection(`Bridge heartbeat timeout; silent for ${nowMs - lastServerActivityMs}ms`);
      return;
    }
    send({ type: 'heartbeat', timestamp: nowMs, source: 'extension' });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    runtimeTimers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  lastServerActivityMs = 0;
}

function bridgeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

async function handleRequest(message: BridgeRequest): Promise<void> {
  const startedAt = Date.now();
  try {
    // Loader-level methods (hot swap, loader status) are handled before the
    // dispatcher so a broken pushed dispatcher can always be replaced.
    const loaderResult = await handleLoaderMethod(message.method, message.params ?? {});
    const result = loaderResult.handled
      ? loaderResult.result
      : await activeDispatcher.dispatch(message.method, message.params);
    send({
      id: message.id,
      type: 'response',
      ok: true,
      result: result as JsonValue,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const record = isRecord(error) ? error : {};
    const response: BridgeResponse = {
      id: message.id,
      type: 'response',
      ok: false,
      error: {
        code: String(record.code ?? 'EASYEDA_API_ERROR'),
        message: bridgeErrorMessage(error),
        suggestion: String(record.suggestion ?? 'Check EasyEDA Pro and extension logs.'),
        data: record.data,
      },
      durationMs: Date.now() - startedAt,
    };
    send(response as unknown as JsonValue);
  }
}

function applyHelloPayload(record: Record<string, unknown>): void {
  if (record.contractVersion !== BRIDGE_CONTRACT_VERSION) {
    log('Bridge hello contract version mismatch', {
      expected: BRIDGE_CONTRACT_VERSION,
      actual: record.contractVersion,
    });
  }
  const supportedVersions = Array.isArray(record.supportedProtocolVersions)
    ? record.supportedProtocolVersions
    : [];
  if (!supportedVersions.includes(BRIDGE_VERSION)) {
    log('Bridge hello does not include this extension protocol version', {
      protocolVersion: BRIDGE_VERSION,
      supportedProtocolVersions: supportedVersions,
    });
  }
  if (typeof record.maxPayloadSize === 'number' && record.maxPayloadSize > 0) {
    bridgeMaxPayloadSize = record.maxPayloadSize;
  }
  serverSupportsChunking = record.supportsChunking === true;
  maxAggregatePayloadSize = bridgeMaxPayloadSize;
  if (typeof record.maxAggregatePayloadSize === 'number' && record.maxAggregatePayloadSize > 0) {
    maxAggregatePayloadSize = record.maxAggregatePayloadSize;
  }
  serverHotSwapEnabled = record.hotSwapEnabled === true;
  log('Bridge handshake accepted');
}

function handleHeartbeatMessage(source: 'server' | 'extension' | undefined): void {
  if (source === 'extension') return;
  send({ type: 'heartbeat', timestamp: Date.now(), source: 'extension' });
}

function handleMessage(raw: string): InboundMessageType {
  const message = JSON.parse(raw) as { type?: string; source?: 'server' | 'extension' };
  if (isServerActivityMessage(message.type, message.source)) {
    lastServerActivityMs = Date.now();
  }
  switch (message.type) {
    case 'hello':
      applyHelloPayload(message as Record<string, unknown>);
      return 'hello';
    case 'heartbeat':
      handleHeartbeatMessage(message.source);
      return 'heartbeat';
    case 'request':
      void handleRequest(message as BridgeRequest);
      return 'request';
    default:
      return 'ignored';
  }
}

async function connectToPort(
  port: number,
  runId: number,
  showSuccessToast: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const url = `ws://${LOOPBACK_HOST}:${port}`;
  const socketId = `${SOCKET_ID}-${runId}-${port}`;
  return new Promise((resolve) => {
    let settled = false;
    let handle: SocketHandle | null = null;

    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      runtimeTimers.clearTimeout(timeout);
      resolve(connected);
    };

    const timeout = runtimeTimers.setTimeout(() => {
      if (socketHandle === handle) {
        socketHandle = null;
      }
      closeHandle(handle);
      finish(false);
    }, timeoutMs);

    try {
      handle = createSocket(
        socketId,
        url,
        () => {
          if (settled || runId !== connectRunId) {
            closeHandle(handle);
            return;
          }
          socketHandle = handle ?? { type: 'easyeda-register', id: socketId };
          sendHandshake();
        },
        (data) => {
          try {
            const messageType = handleMessage(data);
            if (messageType === 'hello' && runId === connectRunId && !settled) {
              socketHandle = handle ?? { type: 'easyeda-register', id: socketId };
              connectedPort = port;
              connectionState = 'connected';
              reconnectAttempts = 0;
              manualDisconnectRequested = false;
              startHeartbeat();
              if (showSuccessToast) {
                showToast(`MCP Bridge connected to local server`);
              }
              finish(true);
            }
          } catch (error) {
            log('Bridge message error', error);
          }
        },
        () => {
          const wasActiveConnection = socketHandle === handle && connectionState === 'connected';
          if (socketHandle === handle) {
            stopHeartbeat();
            socketHandle = null;
            connectedPort = null;
            connectionState = 'disconnected';
          }
          if (!settled) {
            finish(false);
          }
          if (wasActiveConnection && !manualDisconnectRequested && runId === connectRunId) {
            scheduleReconnect();
          }
        },
        (error) => {
          log(`Connection failed on port ${port}`, error);
          if (socketHandle === handle) {
            socketHandle = null;
          }
          closeHandle(handle);
          finish(false);
        },
      );
    } catch (error) {
      log('createSocket threw', error);
      closeHandle(handle);
      finish(false);
      return;
    }

    if (!handle) {
      finish(false);
    }
  });
}

async function connectInternal(mode: ConnectMode = 'manual'): Promise<void> {
  const manual = mode === 'manual';

  if (connectionState === 'connected' && connectedPort !== null) {
    if (manual) {
      showToast(`MCP Bridge already connected to local server`);
    }
    return;
  }

  if (connectionState === 'connecting' && activeConnectPromise) {
    if (!manual) return activeConnectPromise;

    // A manual Connect request should not remain trapped behind an auto-connect
    // scan that may currently be waiting on another port. Cancel the old run and
    // immediately restart from the preferred/base port.
    connectRunId += 1;
    activeConnectPromise = null;
    closeSocket();
  }

  if (reconnectTimer) {
    runtimeTimers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  manualDisconnectRequested = false;
  connectionState = 'connecting';
  const runId = ++connectRunId;

  if (manual) {
    showToast(`MCP Bridge connecting to local server`);
  }

  activeConnectPromise = (async () => {
    try {
      for (const attempt of getLocalBridgeConnectionAttempts(preferredPort)) {
        if (runId !== connectRunId || manualDisconnectRequested) return;
        // Always show success toast so the user knows auto-connect worked.
        const connected = await connectToPort(attempt.port, runId, true, attempt.timeoutMs);
        if (connected) {
          preferredPort = attempt.port;
          return;
        }
      }
    } catch (error) {
      log('connect() threw unexpectedly', error);
    } finally {
      if (runId === connectRunId && connectionState === 'connecting') {
        connectionState = 'disconnected';
        socketHandle = null;
        connectedPort = null;
        const message = `MCP Bridge offline: no local server found`;
        if (manual) {
          showToast(message);
        } else {
          log(message);
        }
        if (!manualDisconnectRequested) {
          scheduleReconnect();
        }
      }

      if (runId === connectRunId) {
        activeConnectPromise = null;
      }
    }
  })();

  return activeConnectPromise;
}

function disconnectInternal(notifyUser: boolean): void {
  if (notifyUser) void updateMenuTitle();
  const wasDisconnected = connectionState === 'disconnected' && !socketHandle;
  const wasConnecting = connectionState === 'connecting';

  manualDisconnectRequested = true;
  connectRunId += 1;
  activeConnectPromise = null;
  reconnectAttempts = 0;
  if (reconnectTimer) {
    runtimeTimers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  closeSocket();

  if (!notifyUser) return;
  if (wasDisconnected) {
    showToast('MCP Bridge already disconnected');
  } else if (wasConnecting) {
    showToast('MCP Bridge connection cancelled');
  } else {
    showToast('MCP Bridge disconnected. Auto reconnect is paused until Connect.');
  }
}

function disconnectCommandInternal(): void {
  disconnectInternal(true);
}

function showStatusInternal(): void {
  autoConnectEnabled = loadAutoConnectSetting();
  const autoLabel = autoConnectEnabled ? 'Auto-Connect: ON' : 'Auto-Connect: OFF';

  if (connectionState === 'connected' && connectedPort !== null) {
    showToast(`MCP Bridge connected to local server | ${autoLabel}`);
    return;
  }

  if (connectionState === 'connecting') {
    showToast(`MCP Bridge connecting to local server | ${autoLabel}`);
    return;
  }

  if (autoConnectEnabled && !manualDisconnectRequested) {
    showToast(
      `MCP Bridge: waiting for server | ${autoLabel} — retrying (attempt ${reconnectAttempts + 1})`,
    );
    scheduleReconnect();
    return;
  }

  showToast(`MCP Bridge disconnected | ${autoLabel} — click Connect to connect`);
}

function scheduleReconnect(): void {
  if (manualDisconnectRequested || reconnectTimer) return;
  reconnectAttempts += 1;
  const delay = reconnectDelayMs(reconnectAttempts);
  reconnectTimer = runtimeTimers.setTimeout(() => {
    reconnectTimer = null;
    if (connectionState === 'disconnected') {
      void connectInternal('auto');
    }
  }, delay);
}

let autoConnectEnabled = true;

function getStorage(): any {
  const globalObj = getGlobal();
  return readPath<any>(globalObj, 'sys_Storage');
}

function loadAutoConnectSetting(): boolean {
  try {
    const storage = getStorage();
    if (storage && typeof storage.getExtensionUserConfig === 'function') {
      const val = storage.getExtensionUserConfig('autoConnect');
      if (val !== undefined) return !!val;
    }
  } catch (e) {
    log('sys_Storage.getExtensionUserConfig unavailable', e);
  }
  return true;
}

async function saveAutoConnectSetting(value: boolean): Promise<void> {
  try {
    const storage = getStorage();
    if (storage && typeof storage.setExtensionUserConfig === 'function') {
      const saved = await storage.setExtensionUserConfig('autoConnect', value);
      if (saved === false) {
        log('sys_Storage.setExtensionUserConfig returned false');
      }
    }
  } catch (e) {
    log('sys_Storage.setExtensionUserConfig unavailable', e);
  }
}

async function updateMenuTitle(): Promise<void> {
  // EasyEDA Pro re-reads extension.json on every menu open; replaceHeaderMenus()
  // cannot persist between opens. State is communicated via toast only.
  log(`menu state: Auto-Connect=${autoConnectEnabled}`);
}

async function setAutoConnectInternal(enabled: boolean): Promise<void> {
  // EasyEDA may evaluate or invoke a menu callback more than once. Setting an
  // explicit target state is idempotent; a duplicate Enable call remains ON.
  autoConnectEnabled = enabled;
  await saveAutoConnectSetting(enabled);
  await updateMenuTitle();
  if (enabled) {
    manualDisconnectRequested = false;
    reconnectAttempts = 0;
    if (connectionState === 'disconnected') {
      await connectInternal('auto');
    }
  } else {
    manualDisconnectRequested = true;
    if (reconnectTimer) {
      runtimeTimers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }
  showToast(
    enabled
      ? 'Auto-Connect: ON — will reconnect automatically'
      : 'Auto-Connect: OFF — use Connect button to connect',
  );
}

async function enableAutoConnectInternal(): Promise<void> {
  await setAutoConnectInternal(true);
}

async function disableAutoConnectInternal(): Promise<void> {
  await setAutoConnectInternal(false);
}

async function toggleAutoConnectInternal(): Promise<void> {
  await setAutoConnectInternal(!loadAutoConnectSetting());
}

let activationStarted = false;

async function handleActivate(): Promise<void> {
  autoConnectEnabled = loadAutoConnectSetting();
  if (activationStarted) {
    if (autoConnectEnabled && connectionState === 'disconnected' && !activeConnectPromise) {
      void connectInternal('auto');
    }
    return;
  }

  activationStarted = true;
  if (autoConnectEnabled) {
    showToast(`MCP Bridge: Auto-Connect ON — scanning local server`);
    void connectInternal('auto');
  } else {
    showToast('MCP Bridge: Auto-Connect OFF — click Connect to connect');
  }
}

async function activateInternal(_status?: 'onStartupFinished', _arg?: string): Promise<void> {
  await handleActivate();
}

function deactivateInternal(): void {
  activationStarted = false;
  disconnectInternal(false);
  const globalScope = globalThis as any;
  const existing = globalScope[PERSISTENT_RUNTIME_KEY] as PersistentRuntime | undefined;
  if (existing?.deactivate === deactivateInternal) {
    delete globalScope[PERSISTENT_RUNTIME_KEY];
  }
}

interface PersistentRuntime {
  activate: typeof activateInternal;
  deactivate: typeof deactivateInternal;
  connect: typeof connectInternal;
  disconnect: typeof disconnectCommandInternal;
  showStatus: typeof showStatusInternal;
  enableAutoConnect: typeof enableAutoConnectInternal;
  disableAutoConnect: typeof disableAutoConnectInternal;
  toggleAutoConnect: typeof toggleAutoConnectInternal;
  connectRemoteRelay: typeof connectRemoteRelayInternal;
  disconnectRemoteRelay: typeof disconnectRemoteRelayInternal;
  showRemoteRelayStatus: typeof showRemoteRelayStatusInternal;
}

const PERSISTENT_RUNTIME_KEY = '__easyedaMcpProBridgeRuntime_v8__';

function getPersistentRuntime(): PersistentRuntime {
  const globalScope = globalThis as any;
  const existing = globalScope[PERSISTENT_RUNTIME_KEY] as PersistentRuntime | undefined;
  if (existing) return existing;

  const runtime: PersistentRuntime = {
    activate: activateInternal,
    deactivate: deactivateInternal,
    connect: connectInternal,
    disconnect: disconnectCommandInternal,
    showStatus: showStatusInternal,
    enableAutoConnect: enableAutoConnectInternal,
    disableAutoConnect: disableAutoConnectInternal,
    toggleAutoConnect: toggleAutoConnectInternal,
    connectRemoteRelay: connectRemoteRelayInternal,
    disconnectRemoteRelay: disconnectRemoteRelayInternal,
    showRemoteRelayStatus: showRemoteRelayStatusInternal,
  };
  globalScope[PERSISTENT_RUNTIME_KEY] = runtime;
  return runtime;
}

const persistentRuntime = getPersistentRuntime();

export async function activate(status?: 'onStartupFinished', arg?: string): Promise<void> {
  await persistentRuntime.activate(status, arg);
}

export function deactivate(): void {
  persistentRuntime.deactivate();
}

export async function connect(mode: ConnectMode = 'manual'): Promise<void> {
  await persistentRuntime.connect(mode);
}

export function disconnect(): void {
  persistentRuntime.disconnect();
}

export function showStatus(): void {
  persistentRuntime.showStatus();
}

export async function enableAutoConnect(): Promise<void> {
  await persistentRuntime.enableAutoConnect();
}

export async function disableAutoConnect(): Promise<void> {
  await persistentRuntime.disableAutoConnect();
}

export async function toggleAutoConnect(): Promise<void> {
  await persistentRuntime.toggleAutoConnect();
}

export function connectRemoteRelay(
  mode: Exclude<RemoteRelayMode, 'disabled'> = 'hosted',
  relayUrl?: string,
  pairingCode?: string,
): void {
  persistentRuntime.connectRemoteRelay(mode, relayUrl, pairingCode);
}

export function disconnectRemoteRelay(): void {
  persistentRuntime.disconnectRemoteRelay();
}

export function showRemoteRelayStatus(): void {
  persistentRuntime.showRemoteRelayStatus();
}

function expose(): void {
  const api = getGlobal();
  if (api) {
    api.connect = connect;
    api.disconnect = disconnect;
    api.showStatus = showStatus;
    api.connectRemoteRelay = connectRemoteRelay;
    api.disconnectRemoteRelay = disconnectRemoteRelay;
    api.showRemoteRelayStatus = showRemoteRelayStatus;
    api.enableAutoConnect = enableAutoConnect;
    api.disableAutoConnect = disableAutoConnect;
    (api as any).toggleAutoConnect = toggleAutoConnect;
    api.activate = activate;
    api.deactivate = deactivate;
  }

  const globalScope = globalThis as any;
  globalScope.connect = connect;
  globalScope.disconnect = disconnect;
  globalScope.showStatus = showStatus;
  globalScope.connectRemoteRelay = connectRemoteRelay;
  globalScope.disconnectRemoteRelay = disconnectRemoteRelay;
  globalScope.showRemoteRelayStatus = showRemoteRelayStatus;
  globalScope.enableAutoConnect = enableAutoConnect;
  globalScope.disableAutoConnect = disableAutoConnect;
  globalScope.toggleAutoConnect = toggleAutoConnect;
  globalScope.activate = activate;
  globalScope.deactivate = deactivate;
}

expose();
log('Extension script loaded');
// Compute the method-list hash early so the first handshake can include it.
void refreshMethodListHash();

// EasyEDA appends activate('onStartupFinished') after evaluating this bundle.
// The exported activate function above starts the connection only after the
// extension runtime (including sys_Timer and sys_WebSocket) is ready.

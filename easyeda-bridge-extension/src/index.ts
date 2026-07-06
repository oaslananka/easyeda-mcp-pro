import { RemoteRelayClient, type RemoteRelayMode } from './remote-client.js';
import { normalizeBinaryResult, type BinaryResultPayload } from './binary-result.js';

declare const eda: EasyedaGlobal | undefined;
declare const EDA: unknown | undefined;
declare const api: unknown | undefined;
declare const ESYS_ToastMessageType: { INFO?: unknown } | undefined;
declare const SYS_WebSocket: EasyedaWebSocketApi | undefined;
declare const SYS_Message: EasyedaMessageApi | undefined;

// Injected at build time via environment variable or build script
declare const BRIDGE_SESSION_TOKEN: string | undefined;

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

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

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
const BRIDGE_PORT = 49620;
const PORT_SCAN_COUNT = 10;
const LOOPBACK_HOST = ['127', '0', '0', '1'].join('.');
const CONNECT_TIMEOUT_MS = 8000;
const EASYEDA_REGISTER_OPEN_FALLBACK_MS = 600;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STORAGE_KEY = 'easyeda-mcp-pro:autoConnect';
const HEARTBEAT_MS = 15000;
const SOCKET_ID = 'easyeda-mcp-pro-bridge';
// Fraction of the server's advertised BRIDGE_MAX_PAYLOAD_SIZE we allow a single
// binary (Blob/File) result to use, leaving headroom for base64 (~1.33x raw
// bytes) plus JSON envelope overhead. Exceeding the server's actual limit closes
// the whole WS connection, not just the offending call — so we self-limit first.
const PAYLOAD_SAFETY_MARGIN = 0.6;
const API_CLASS_PREFIXES = ['DMT_', 'SCH_', 'PCB_', 'LIB_'] as const;
const DENIED_API_METHODS = new Set([
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
]);

let socketHandle: SocketHandle | null = null;
let connectedPort: number | null = null;
let connectionState: ConnectionState = 'disconnected';
let activeConnectPromise: Promise<void> | null = null;
let reconnectAttempts = 0;
let connectRunId = 0;
let manualDisconnectRequested = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let externalInteractionWarningShown = false;
// Updated from the server's `hello` message; matches BRIDGE_MAX_PAYLOAD_SIZE default
// until the handshake completes.
let bridgeMaxPayloadSize = 1_048_576;

let remoteRelayClient: RemoteRelayClient | null = null;

function getRemoteRelayClient(): RemoteRelayClient {
  remoteRelayClient ??= new RemoteRelayClient({
    extensionVersion: '0.21.0', // x-release-please-version
    log,
    showToast,
    readActiveProject: readRemoteActiveProject,
    executeToolRequest: (toolName, input) => dispatch(toolName, isRecord(input) ? input : {}),
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

function connectRemoteRelay(
  mode: Exclude<RemoteRelayMode, 'disabled'> = 'hosted',
  relayUrl?: string,
  pairingCode?: string,
): void {
  getRemoteRelayClient().connect({ mode, relayUrl, pairingCode });
}

function disconnectRemoteRelay(): void {
  getRemoteRelayClient().disconnect('user_disabled');
  showToast('Remote Relay disabled');
}

function showRemoteRelayStatus(): void {
  const status = getRemoteRelayClient().getStatus();
  const project = status.activeProject?.projectName ?? 'no active project detected';
  showToast(`Remote Relay: ${status.mode}/${status.state} | project: ${project}`);
}

function getGlobal(): EasyedaGlobal | null {
  if (typeof eda !== 'undefined' && eda) return eda;
  return globalThis as unknown as EasyedaGlobal;
}

function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
  console.log(`[easyeda-mcp-pro ${new Date().toISOString()}] ${message}${suffix}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logRecoverableError('failed to stringify log payload', error);
    return String(value);
  }
}

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

function readPath<T>(source: unknown, path: string): T | undefined {
  const parts = path.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (!isRecord(cursor) || !(part in cursor)) return undefined;
    try {
      cursor = cursor[part];
    } catch (error) {
      logRecoverableError(`failed to read path segment ${part}`, error);
      return undefined;
    }
  }
  return cursor as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function logRecoverableError(context: string, error: unknown): void {
  // Pass `context` as a plain argument (never interpolated into the first/format
  // argument) so a value derived from external data can't be read as a printf-style
  // format specifier by `console.warn`'s format-string handling.
  console.warn('[easyeda-mcp-pro]', context, error);
}

async function callFirst(paths: string[], ...args: unknown[]): Promise<unknown> {
  const candidates: unknown[] = [];
  if (typeof eda !== 'undefined' && eda) candidates.push(eda);
  if (typeof EDA !== 'undefined' && EDA) candidates.push(EDA);
  if (typeof api !== 'undefined' && api) candidates.push(api);
  candidates.push(globalThis);

  const allPaths = withClassNameVariants(paths);

  for (const candidate of candidates) {
    for (const path of allPaths) {
      const fn = readPath<unknown>(candidate, path);
      if (typeof fn === 'function') {
        return await fn.apply(readPathParent(candidate, path), args);
      }
    }
  }

  throw newBridgeError(
    'METHOD_NOT_FOUND',
    `No EasyEDA API implementation found for ${paths.join(' or ')}`,
    'Verify the bridge extension supports the installed EasyEDA Pro version.',
  );
}

function readPathParent(source: unknown, path: string): unknown {
  const parentPath = path.split('.').slice(0, -1).join('.');
  return parentPath ? readPath(source, parentPath) : source;
}

function readFirstPath<T>(paths: string[]): T | undefined {
  for (const candidate of getApiCandidates()) {
    for (const path of withClassNameVariants(paths)) {
      const value = readPath<T>(candidate.root, path);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of a primitive id from a value returned by an EasyEDA
 * Pro create* API. The runtime may return a plain object with primitiveId/uuid,
 * or a primitive wrapper exposing getState_PrimitiveId()/getState().PrimitiveId.
 */
function extractPrimitiveId(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const obj = result as Record<string, unknown>;
  const direct = obj.primitiveId ?? obj.uuid;
  if (direct) return String(direct);
  try {
    const getter = obj.getState_PrimitiveId;
    if (typeof getter === 'function') {
      const id = (getter as () => unknown).call(obj);
      if (id) return String(id);
    }
  } catch {
    /* ignore */
  }
  try {
    const getState = obj.getState;
    if (typeof getState === 'function') {
      const state = (getState as () => unknown).call(obj) as Record<string, unknown> | undefined;
      if (state?.PrimitiveId) return String(state.PrimitiveId);
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Reads `obj.getState_<Key>()` defensively, returning undefined if the getter
 * is missing or throws. Used to snapshot a primitive's current property values
 * before a partial `.modify()` call, since the native EasyEDA API resets any
 * field omitted from the property object rather than leaving it untouched.
 */
function safeGetState(obj: unknown, key: string): unknown {
  const getter = (obj as Record<string, unknown> | null | undefined)?.[`getState_${key}`];
  if (typeof getter !== 'function') return undefined;
  try {
    return (getter as () => unknown).call(obj);
  } catch {
    return undefined;
  }
}

/** Normalizes SCH_PrimitiveWire's `line` shape (flat number[] or [x,y][]) into points. */
function normalizeWireLine(line: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(line) || line.length === 0) return [];
  if (Array.isArray(line[0])) {
    return (line as number[][])
      .filter((pair) => Array.isArray(pair) && pair.length >= 2)
      .map(([x, y]) => ({ x, y }));
  }
  const flat = line as number[];
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pts.push({ x: flat[i], y: flat[i + 1] });
  }
  return pts;
}

/**
 * Checks whether any of `points` exactly coincides with a coordinate already
 * used by an existing wire on a *different* net. EasyEDA Pro auto-merges
 * wires that share a coordinate (not just endpoints), which silently unions
 * their connectivity — a real hazard when routing two unrelated nets through
 * overlapping "highway" columns/rows. Returns the first collision found, or
 * null if the runtime doesn't expose wire introspection or none is found.
 */
async function findForeignNetCollision(
  points: Array<{ x: number; y: number }>,
  netName: string,
): Promise<{ x: number; y: number; foreignNet: string } | null> {
  if (!netName || points.length === 0) return null;
  const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
  if (!schWireClass || typeof schWireClass.getAll !== 'function') return null;

  let wires: unknown[] = [];
  try {
    wires = (await schWireClass.getAll()) || [];
  } catch (e) {
    logRecoverableError('failed to read existing wires for net-collision check', e);
    return null;
  }

  for (const wire of wires) {
    const wireNet = String(safeGetState(wire, 'Net') ?? '');
    if (!wireNet || wireNet === netName) continue;
    const wirePts = normalizeWireLine(safeGetState(wire, 'Line'));
    for (const p of points) {
      for (const wp of wirePts) {
        if (wp.x === p.x && wp.y === p.y) {
          return { x: p.x, y: p.y, foreignNet: wireNet };
        }
      }
    }
  }
  return null;
}

function isBinaryResultPayload(value: unknown): value is BinaryResultPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { base64?: unknown }).base64 === 'string' &&
    typeof (value as { byteLength?: unknown }).byteLength === 'number'
  );
}

/**
 * Wraps `normalizeBinaryResult`, additionally rejecting a payload that would
 * exceed the server's advertised BRIDGE_MAX_PAYLOAD_SIZE (see
 * `bridgeMaxPayloadSize`) before it is ever handed to `send()`. Sending an
 * oversized WS frame closes the whole connection (code 4009) rather than just
 * failing this one call, so we throw a normal, small, structured error
 * instead — handleRequest() turns it into an ok:false response.
 */
async function normalizeBinaryResultSafely(
  value: unknown,
  fallbackFileName: string,
): Promise<unknown> {
  const normalized = await normalizeBinaryResult(value, fallbackFileName);
  if (isBinaryResultPayload(normalized)) {
    const budget = Math.floor(bridgeMaxPayloadSize * PAYLOAD_SAFETY_MARGIN);
    if (normalized.byteLength > budget) {
      throw newBridgeError(
        'PAYLOAD_TOO_LARGE',
        `"${normalized.fileName}" is ${normalized.byteLength} bytes, which exceeds the safe transport budget (${budget} bytes, derived from the server's BRIDGE_MAX_PAYLOAD_SIZE=${bridgeMaxPayloadSize}).`,
        'Increase BRIDGE_MAX_PAYLOAD_SIZE in the MCP server environment, or (for canvas captures) zoom to a smaller region.',
      );
    }
  }
  return normalized;
}

function getApiCandidates(): Array<{ name: string; root: unknown }> {
  const candidates: Array<{ name: string; root: unknown }> = [];
  if (typeof eda !== 'undefined' && eda) candidates.push({ name: 'eda', root: eda });
  if (typeof EDA !== 'undefined' && EDA) candidates.push({ name: 'EDA', root: EDA });
  if (typeof api !== 'undefined' && api) candidates.push({ name: 'api', root: api });
  candidates.push({ name: 'globalThis', root: globalThis });
  return candidates;
}

function withClassNameVariants(paths: string[]): string[] {
  const variants: string[] = [];
  for (const path of paths) {
    variants.push(path);
    const parts = path.split('.');
    const className = parts[0];
    if (!className) continue;

    const rest = parts.slice(1).join('.');
    const suffix = rest ? `.${rest}` : '';
    const lowerPrefixMatch = className.match(/^([a-z]+)_(.+)$/);
    const upperPrefixMatch = className.match(/^([A-Z]+)_(.+)$/);

    if (lowerPrefixMatch?.[1] && lowerPrefixMatch[2]) {
      variants.push(`${lowerPrefixMatch[1].toUpperCase()}_${lowerPrefixMatch[2]}${suffix}`);
    }

    if (upperPrefixMatch?.[1] && upperPrefixMatch[2]) {
      variants.push(`${upperPrefixMatch[1].toLowerCase()}_${upperPrefixMatch[2]}${suffix}`);
    }
  }

  return [...new Set(variants)];
}

function normalizeApiClassName(className: string): string {
  const match = className.match(/^([a-z]+)_(.+)$/);
  if (!match?.[1] || !match[2]) return className;
  return `${match[1].toUpperCase()}_${match[2]}`;
}

function isAllowedApiPath(path: string): boolean {
  const parts = path.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [className, methodName] = parts;
  if (DENIED_API_METHODS.has(methodName) || methodName.startsWith('__')) return false;
  if (!/^[A-Za-z]+_[A-Za-z0-9]+$/.test(className)) return false;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(methodName)) return false;
  return API_CLASS_PREFIXES.some((prefix) => normalizeApiClassName(className).startsWith(prefix));
}

function getAllPropertyNames(value: unknown): string[] {
  const names: string[] = [];
  let cursor = value;
  let depth = 0;
  while (isRecord(cursor) && cursor !== Object.prototype && depth < 8) {
    try {
      names.push(...Object.getOwnPropertyNames(cursor));
    } catch (error) {
      logRecoverableError('failed to read API property names', error);
      break;
    }
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch (error) {
      logRecoverableError('failed to read API property prototype', error);
      break;
    }
    depth += 1;
  }
  return Array.from(new Set(names)).filter(
    (name) => !['length', 'name', 'prototype', 'constructor'].includes(name),
  );
}

function getFunctionNames(value: unknown): string[] {
  return getAllPropertyNames(value).filter((name) => {
    const member = readMember(value, name);
    return typeof member === 'function';
  });
}

function readMember(source: unknown, key: string): unknown {
  if (!isRecord(source) || !(key in source)) return undefined;
  try {
    return source[key];
  } catch (error) {
    logRecoverableError(`failed to read API member ${key}`, error);
    return undefined;
  }
}

function normalizeValue(value: unknown, depth = 3, seen = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value === 'function')
    return `[Function ${(value as { name?: string }).name ?? 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) return '[MaxDepth]';

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => normalizeValue(item, depth - 1, seen));
  }

  const output: Record<string, JsonValue | undefined> = {};
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && ctorName !== 'Object') output.__class = ctorName;

  const getterNames = getFunctionNames(value)
    .filter((name) => name.startsWith('getState_'))
    .slice(0, 80);
  if (getterNames.length > 0) {
    const state: Record<string, JsonValue | undefined> = {};
    for (const getterName of getterNames) {
      const getter = readMember(value, getterName);
      if (typeof getter !== 'function') continue;
      try {
        state[getterName.replace(/^getState_/, '')] = normalizeValue(
          getter.call(value),
          depth - 1,
          seen,
        );
      } catch (error) {
        state[getterName.replace(/^getState_/, '')] = `ERROR: ${String(error)}`;
      }
    }
    output.state = state;
  }

  const methodNames = getFunctionNames(value).slice(0, 120);
  if (methodNames.length > 0) output.__methods = methodNames;

  for (const key of Object.keys(value).slice(0, 80)) {
    output[key] = normalizeValue((value as Record<string, unknown>)[key], depth - 1, seen);
  }

  return output;
}

function normalizeStandalone(value: unknown, depth = 4): JsonValue {
  return normalizeValue(value, depth, new WeakSet<object>());
}

function readStateValue(source: unknown, stateName: string, depth = 4): JsonValue | undefined {
  const getter = readMember(source, `getState_${stateName}`);
  if (typeof getter !== 'function') return undefined;
  try {
    return normalizeStandalone(getter.call(source), depth);
  } catch (error) {
    return `ERROR: ${String(error)}`;
  }
}

function compactPrimitiveSummary(
  value: unknown,
  stateNames: string[],
): Record<string, JsonValue | undefined> {
  const state: Record<string, JsonValue | undefined> = {};
  for (const stateName of stateNames) {
    state[stateName] = readStateValue(value, stateName, 5);
  }
  return state;
}

function summarizeWirePrimitive(wire: unknown): Record<string, JsonValue | undefined> {
  const normalized = normalizeStandalone(wire, 4);
  const output: Record<string, JsonValue | undefined> = isRecord(normalized)
    ? { ...(normalized as Record<string, JsonValue | undefined>) }
    : { value: normalized };
  const state = compactPrimitiveSummary(wire, [
    'PrimitiveType',
    'PrimitiveId',
    'Line',
    'Net',
    'Color',
    'LineWidth',
    'LineType',
  ]);

  output.primitiveType = state.PrimitiveType ?? output.primitiveType ?? '';
  output.primitiveId = state.PrimitiveId ?? output.primitiveId ?? '';
  output.line = state.Line ?? output.line ?? null;
  output.net = state.Net ?? output.net ?? '';
  output.color = state.Color ?? output.color ?? null;
  output.lineWidth = state.LineWidth ?? output.lineWidth ?? null;
  output.lineType = state.LineType ?? output.lineType ?? null;
  output.state = state;
  return output;
}

type SchematicPoint = { x: number; y: number };
type SchematicNetNode = { component: string; pin: string; x?: number; y?: number; source?: string };
type SchematicNetEntry = { netName: string; nodes: SchematicNetNode[] };

type DisjointSet = {
  parent: Map<string, string>;
  find: (key: string) => string;
  union: (a: string, b: string) => void;
};

function createDisjointSet(): DisjointSet {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    const currentParent = parent.get(key);
    if (!currentParent || currentParent === key) return key;
    const root = find(currentParent);
    parent.set(key, root);
    return root;
  };

  return {
    parent,
    find,
    union: (a: string, b: string): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    },
  };
}

function pointKey(point: SchematicPoint): string {
  return `${Math.round(point.x * 1000) / 1000},${Math.round(point.y * 1000) / 1000}`;
}

function parseLinePoints(line: unknown): SchematicPoint[] {
  if (!Array.isArray(line)) return [];

  if (line.every((item) => typeof item === 'number')) {
    const points: SchematicPoint[] = [];
    for (let i = 0; i + 1 < line.length; i += 2) {
      const x = Number(line[i]);
      const y = Number(line[i + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    return points;
  }

  const points: SchematicPoint[] = [];
  for (const item of line) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

function readStringMemberOrState(source: unknown, key: string, stateName: string): string {
  const stateValue = readStateValue(source, stateName, 2);
  if (typeof stateValue === 'string' && stateValue) return stateValue;
  const directValue = readMember(source, key);
  if (typeof directValue === 'string') return directValue;
  if (typeof directValue === 'number') return String(directValue);
  return '';
}

function readNumberMemberOrState(
  source: unknown,
  key: string,
  stateName: string,
): number | undefined {
  const stateValue = readStateValue(source, stateName, 2);
  if (typeof stateValue === 'number' && Number.isFinite(stateValue)) return stateValue;
  const directValue = readMember(source, key);
  if (typeof directValue === 'number' && Number.isFinite(directValue)) return directValue;
  return undefined;
}

function ensureNetEntry(
  netMap: Map<string, SchematicNetNode[]>,
  netName: string,
): SchematicNetNode[] {
  const existing = netMap.get(netName);
  if (existing) return existing;
  const nodes: SchematicNetNode[] = [];
  netMap.set(netName, nodes);
  return nodes;
}

function pushUniqueNetNode(
  netMap: Map<string, SchematicNetNode[]>,
  netName: string,
  node: SchematicNetNode,
): void {
  if (!netName || !node.component || !node.pin) return;
  const nodes = ensureNetEntry(netMap, netName);
  if (nodes.some((item) => item.component === node.component && item.pin === node.pin)) return;
  nodes.push(node);
}

function readComponentType(component: unknown): string {
  return readStringMemberOrState(component, 'componentType', 'ComponentType').toLowerCase();
}

function readComponentNet(component: unknown): string {
  const directNet = readStringMemberOrState(component, 'net', 'Net');
  if (directNet) return directNet;
  const otherProperty = readMember(component, 'otherProperty');
  if (isRecord(otherProperty)) {
    return String(otherProperty.net ?? otherProperty.Net ?? '');
  }
  return '';
}

function readPrimitivePoint(source: unknown): SchematicPoint | undefined {
  const x = readNumberMemberOrState(source, 'x', 'X');
  const y = readNumberMemberOrState(source, 'y', 'Y');
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

async function addCoordinateFallbackNets(
  netMap: Map<string, SchematicNetNode[]>,
  comps: unknown[],
): Promise<void> {
  const schWireClass = readFirstPath<any>([
    'SCH_PrimitiveWire',
    'SCH_PrimitiveWire3',
    'sch_PrimitiveWire',
  ]);
  if (!schWireClass || typeof schWireClass.getAll !== 'function') return;

  const wires = await schWireClass.getAll();
  const wireItems = Array.isArray(wires) ? wires : [];
  if (wireItems.length === 0) return;

  const dsu = createDisjointSet();
  const rootNetNames = new Map<string, Set<string>>();
  const addNetLabel = (point: SchematicPoint, netName: string): void => {
    if (!netName) return;
    const root = dsu.find(pointKey(point));
    const names = rootNetNames.get(root) ?? new Set<string>();
    names.add(netName);
    rootNetNames.set(root, names);
    ensureNetEntry(netMap, netName);
  };

  for (const wire of wireItems) {
    const wireSummary = summarizeWirePrimitive(wire);
    const points = parseLinePoints(wireSummary.line);
    if (points.length === 0) continue;

    for (const point of points) dsu.find(pointKey(point));
    for (let i = 1; i < points.length; i += 1) {
      dsu.union(pointKey(points[i - 1]), pointKey(points[i]));
    }

    const netName = typeof wireSummary.net === 'string' ? wireSummary.net : '';
    if (netName) addNetLabel(points[0], netName);
  }

  // Re-normalize root labels after all wire unions are known.
  for (const [root, names] of Array.from(rootNetNames.entries())) {
    const normalizedRoot = dsu.find(root);
    if (normalizedRoot === root) continue;
    const target = rootNetNames.get(normalizedRoot) ?? new Set<string>();
    for (const name of names) target.add(name);
    rootNetNames.set(normalizedRoot, target);
    rootNetNames.delete(root);
  }

  for (const component of comps) {
    if (readComponentType(component) !== 'netflag') continue;
    const netName = readComponentNet(component);
    const point = readPrimitivePoint(component);
    if (!netName || !point) continue;
    addNetLabel(point, netName);
  }

  for (const component of comps) {
    const ref = readStringMemberOrState(component, 'designator', 'Designator');
    if (!ref || typeof (component as { getAllPins?: unknown }).getAllPins !== 'function') continue;

    try {
      const pins = await (component as { getAllPins: () => Promise<unknown[]> }).getAllPins();
      for (const pin of pins || []) {
        const pinNumber = readStringMemberOrState(pin, 'pinNumber', 'PinNumber');
        const point = readPrimitivePoint(pin);
        if (!pinNumber || !point) continue;

        const netNames = rootNetNames.get(dsu.find(pointKey(point)));
        if (!netNames) continue;
        for (const netName of netNames) {
          pushUniqueNetNode(netMap, netName, {
            component: ref,
            pin: pinNumber,
            x: point.x,
            y: point.y,
            source: 'coordinate-fallback',
          });
        }
      }
    } catch (error) {
      logRecoverableError('failed to inspect schematic component pins for coordinate nets', error);
    }
  }
}

function inspectApiInventory(filter?: string): JsonValue {
  const normalizedFilter = filter?.toLowerCase().trim();
  const classMap = new Map<
    string,
    {
      className: string;
      runtimePaths: string[];
      methods: string[];
    }
  >();

  for (const candidate of getApiCandidates()) {
    const root = candidate.root;
    if (!isRecord(root)) continue;

    for (const key of Object.getOwnPropertyNames(root)) {
      const className = normalizeApiClassName(key);
      if (!API_CLASS_PREFIXES.some((prefix) => className.startsWith(prefix))) continue;
      if (normalizedFilter && !className.toLowerCase().includes(normalizedFilter)) continue;

      const value = readMember(root, key);
      const methods = getFunctionNames(value).sort();
      const existing = classMap.get(className) ?? {
        className,
        runtimePaths: [],
        methods: [],
      };
      existing.runtimePaths.push(`${candidate.name}.${key}`);
      existing.methods = Array.from(new Set([...existing.methods, ...methods])).sort();
      classMap.set(className, existing);
    }
  }

  const classes = Array.from(classMap.values()).sort((a, b) =>
    a.className.localeCompare(b.className),
  );
  return {
    classes: classes as unknown as JsonValue,
    total: classes.length,
  };
}

async function callAllowedApi(path: string, args: unknown[]): Promise<unknown> {
  if (!isAllowedApiPath(path)) {
    throw newBridgeError(
      'UNAUTHORIZED',
      `API path is not allowed: ${path}`,
      'Use a documented EasyEDA API class method such as SCH_PrimitiveWire.getAll.',
    );
  }

  for (const candidate of getApiCandidates()) {
    for (const candidatePath of withClassNameVariants([path])) {
      const fn = readPath<unknown>(candidate.root, candidatePath);
      if (typeof fn !== 'function') continue;
      const parent = readPathParent(candidate.root, candidatePath);
      const result = await fn.apply(parent, args);
      return {
        path,
        resolvedPath: `${candidate.name}.${candidatePath}`,
        result: normalizeValue(result, 5),
      };
    }
  }

  throw newBridgeError(
    'METHOD_NOT_FOUND',
    `No EasyEDA API implementation found for ${path}`,
    'Check easyeda_api_inventory for runtime-supported classes and methods.',
  );
}

function newBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  const error = new Error(message);
  Object.assign(error, { code, suggestion, data });
  return error;
}

async function listComponentsApi(): Promise<unknown> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  const libFpClass = readFirstPath<any>(['LIB_Footprint', 'lib_Footprint']);

  if (!schCompClass) {
    throw new Error('SCH_PrimitiveComponent class not found in EasyEDA Pro API');
  }

  const comps = await schCompClass.getAll(undefined, true);
  const result: any[] = [];

  for (const c of comps || []) {
    const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
    const val = typeof c.getState_Name === 'function' ? c.getState_Name() : '';
    let fp = '';

    if (typeof c.getState_Footprint === 'function') {
      const fpInfo = c.getState_Footprint();
      if (fpInfo && fpInfo.uuid && libFpClass) {
        try {
          const fpObj = await libFpClass.get(fpInfo.uuid, fpInfo.libraryUuid);
          if (fpObj) fp = fpObj.name || '';
        } catch (e) {
          logRecoverableError('failed to resolve component footprint', e);
        }
      }
    }

    const lcsc = typeof c.getState_SupplierId === 'function' ? c.getState_SupplierId() : '';
    const mfr = typeof c.getState_Manufacturer === 'function' ? c.getState_Manufacturer() : '';
    const mfrId =
      typeof c.getState_ManufacturerId === 'function' ? c.getState_ManufacturerId() : '';
    let ds = '';

    if (typeof c.getState_OtherProperty === 'function') {
      const other = c.getState_OtherProperty();
      if (other) {
        if (!fp && (other.Footprint || other.footprint))
          fp = String(other.Footprint || other.footprint);
        ds = String(other.Datasheet || other.datasheet || '');
      }
    }

    // Device identity — needed to re-place / clone a part. `Component` holds the
    // device uuid+libraryUuid (a valid place_component deviceItem within THIS
    // project; for a clean project, re-resolve via lcsc/manufacturerId/name).
    // `Symbol` names the schematic symbol used.
    const comp =
      typeof c.getState_Component === 'function' ? c.getState_Component() : undefined;
    const sym = typeof c.getState_Symbol === 'function' ? c.getState_Symbol() : undefined;

    result.push({
      primitiveId: safeGetState(c, 'PrimitiveId') ?? '',
      reference: ref,
      value: val,
      footprint: fp,
      lcsc: lcsc,
      manufacturer: mfr,
      manufacturerId: mfrId,
      datasheet: ds,
      deviceUuid: comp?.uuid ?? '',
      deviceLibraryUuid: comp?.libraryUuid ?? '',
      deviceName: comp?.name ?? '',
      symbolName: sym?.name ?? '',
      x: safeGetState(c, 'X'),
      y: safeGetState(c, 'Y'),
      rotation: safeGetState(c, 'Rotation'),
    });
  }
  return result;
}

async function getSchematicSheetInfoApi(): Promise<unknown> {
  const currentPage = await callFirst([
    'DMT_Schematic.getCurrentSchematicPageInfo',
    'dmt_Schematic.getCurrentSchematicPageInfo',
  ]);
  let pages: unknown = [];
  try {
    pages = await callFirst([
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo',
      'DMT_Schematic.getAllSchematicPagesInfo',
      'dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo',
      'dmt_Schematic.getAllSchematicPagesInfo',
    ]);
  } catch (err) {
    logRecoverableError('failed to read schematic pages list', err);
  }

  return {
    currentPage: normalizeValue(currentPage, 5),
    pages: normalizeValue(pages, 4),
  };
}

async function listNetsApi(): Promise<unknown> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  const schNetClass = readFirstPath<any>(['SCH_Net', 'sch_Net']);

  if (!schCompClass) {
    throw new Error('SCH_PrimitiveComponent class not found in EasyEDA Pro API');
  }

  const comps = await schCompClass.getAll(undefined, true);
  const netMap = new Map<string, SchematicNetNode[]>();

  for (const c of comps || []) {
    const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
    if (!ref || typeof c.getAllPins !== 'function') continue;

    try {
      const pins = await c.getAllPins();
      for (const p of pins || []) {
        if (typeof p.getState_PinNumber !== 'function') continue;
        const pinNum = p.getState_PinNumber();

        let netName = '';
        if (typeof p.getState_OtherProperty === 'function') {
          const other = p.getState_OtherProperty();
          if (other) {
            netName = String(other.net || other.Net || '');
          }
        }

        if (netName) {
          pushUniqueNetNode(netMap, netName, { component: ref, pin: pinNum });
        }
      }
    } catch (e) {
      logRecoverableError('failed to inspect schematic component pins', e);
    }
  }

  if (schNetClass && typeof schNetClass.getAllNets === 'function') {
    try {
      const allNets = await schNetClass.getAllNets();
      for (const n of allNets || []) {
        const netName = n.netName || n.net;
        if (netName) ensureNetEntry(netMap, String(netName));
      }
    } catch (e) {
      logRecoverableError('failed to inspect schematic nets', e);
    }
  }

  try {
    await addCoordinateFallbackNets(netMap, comps || []);
  } catch (error) {
    logRecoverableError('failed to infer schematic nets from wire coordinates', error);
  }

  const result: SchematicNetEntry[] = [];
  for (const [netName, nodes] of netMap.entries()) {
    result.push({
      netName,
      nodes,
    });
  }
  return result;
}

/**
 * Assign the next free designator to a freshly placed component whose
 * designator is still an unresolved placeholder ("R?", "U?", "LED?", ...).
 * EasyEDA Pro's SCH_PrimitiveComponent.create leaves the library placeholder
 * in place and exposes no annotate API, so every placed part would otherwise
 * share the same "?" designator — which collapses distinct components into a
 * single node in the netlist readback. Returns the new designator (or
 * undefined if nothing was changed). Best-effort: any failure is swallowed by
 * the caller so a placement is never rolled back over annotation.
 */
async function assignAutoDesignator(created: unknown): Promise<string | undefined> {
  const pid = extractPrimitiveId(created);
  if (!pid) return undefined;
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (
    !schCompClass ||
    typeof schCompClass.get !== 'function' ||
    typeof schCompClass.modify !== 'function'
  ) {
    return undefined;
  }

  let current: any;
  try {
    current = await schCompClass.get(pid);
  } catch (e) {
    logRecoverableError(`auto-designator: get(${pid}) failed`, e);
    return undefined;
  }
  if (!current) return undefined;

  const desig = String(safeGetState(current, 'Designator') ?? '');
  // Only annotate placeholders like "R?" / "LED?" (letters then one-or-more
  // '?'). A designator that already carries a number is left untouched.
  const placeholder = /^([A-Za-z]+)\?+$/.exec(desig);
  if (!placeholder) return undefined;
  const prefix = placeholder[1];

  let maxN = 0;
  try {
    const comps = await schCompClass.getAll(undefined, true);
    const rx = new RegExp(`^${prefix}(\\d+)$`);
    for (const c of comps || []) {
      const ref =
        typeof c.getState_Designator === 'function' ? String(c.getState_Designator()) : '';
      const rm = rx.exec(ref);
      if (rm) {
        const n = parseInt(rm[1], 10);
        if (n > maxN) maxN = n;
      }
    }
  } catch (e) {
    logRecoverableError('auto-designator: scan failed', e);
  }
  const newDesig = `${prefix}${maxN + 1}`;

  // Snapshot-merge exactly like schematic.modifyPrimitive so only the
  // designator changes and manufacturer/supplier/otherProperty are preserved.
  const existingOther =
    (safeGetState(current, 'OtherProperty') as Record<string, unknown> | undefined) || {};
  const merged: Record<string, unknown> = {
    x: safeGetState(current, 'X'),
    y: safeGetState(current, 'Y'),
    rotation: safeGetState(current, 'Rotation'),
    mirror: safeGetState(current, 'Mirror'),
    addIntoBom: safeGetState(current, 'AddIntoBom'),
    addIntoPcb: safeGetState(current, 'AddIntoPcb'),
    designator: newDesig,
    name: safeGetState(current, 'Name'),
    uniqueId: safeGetState(current, 'UniqueId'),
    manufacturer: safeGetState(current, 'Manufacturer'),
    manufacturerId: safeGetState(current, 'ManufacturerId'),
    supplier: safeGetState(current, 'Supplier'),
    supplierId: safeGetState(current, 'SupplierId'),
    otherProperty: existingOther,
  };
  await schCompClass.modify(pid, merged);
  return newDesig;
}

/**
 * Apply a rotation to a freshly placed component. SCH_PrimitiveComponent.create
 * only accepts (deviceItem, x, y) — passing extra args hangs the API — so the
 * `rotation` requested by place_component was silently dropped. Set it here via
 * the same snapshot-merge used by modifyPrimitive so no other field is wiped.
 * Best-effort: a failure leaves the component at its default rotation.
 */
async function applyPlacedRotation(created: unknown, rotation: unknown): Promise<number | undefined> {
  const rot = typeof rotation === 'number' ? rotation : Number(rotation);
  if (!Number.isFinite(rot) || rot === 0) return undefined;
  const pid = extractPrimitiveId(created);
  if (!pid) return undefined;
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (
    !schCompClass ||
    typeof schCompClass.get !== 'function' ||
    typeof schCompClass.modify !== 'function'
  ) {
    return undefined;
  }
  let current: any;
  try {
    current = await schCompClass.get(pid);
  } catch (e) {
    logRecoverableError(`apply-rotation: get(${pid}) failed`, e);
    return undefined;
  }
  if (!current) return undefined;
  const existingOther =
    (safeGetState(current, 'OtherProperty') as Record<string, unknown> | undefined) || {};
  const merged: Record<string, unknown> = {
    x: safeGetState(current, 'X'),
    y: safeGetState(current, 'Y'),
    rotation: rot,
    mirror: safeGetState(current, 'Mirror'),
    addIntoBom: safeGetState(current, 'AddIntoBom'),
    addIntoPcb: safeGetState(current, 'AddIntoPcb'),
    designator: safeGetState(current, 'Designator'),
    name: safeGetState(current, 'Name'),
    uniqueId: safeGetState(current, 'UniqueId'),
    manufacturer: safeGetState(current, 'Manufacturer'),
    manufacturerId: safeGetState(current, 'ManufacturerId'),
    supplier: safeGetState(current, 'Supplier'),
    supplierId: safeGetState(current, 'SupplierId'),
    otherProperty: existingOther,
  };
  await schCompClass.modify(pid, merged);
  return rot;
}

/**
 * Reposition / reorient a net flag or net port. SCH_PrimitiveComponent.modify()
 * rejects these primitives ("仅当器件类型为元件时允许使用该函数进行修改" — the
 * convenience wrapper only accepts real parts), so mutate the primitive in place
 * through its low-level fluent setters (setState_X/Y/Rotation/Mirror/Net + done),
 * which are not gated by that guard. This is what lets modify_primitive move a
 * VCC/GND flag's symbol+label away from a crowded pin. Only x/y/rotation/mirror/
 * net are meaningful for a flag; any other field in `property` is ignored.
 */
async function applyNetFlagState(
  current: unknown,
  primitiveId: string,
  property: Record<string, unknown>,
): Promise<unknown> {
  const c = current as Record<string, (arg?: unknown) => unknown>;
  const applied: Record<string, unknown> = {};
  const setIf = (key: string, setter: string) => {
    const v = property[key];
    if (v !== undefined && typeof c[setter] === 'function') {
      c[setter](v);
      applied[key] = v;
    }
  };
  setIf('x', 'setState_X');
  setIf('y', 'setState_Y');
  setIf('rotation', 'setState_Rotation');
  setIf('mirror', 'setState_Mirror');
  setIf('net', 'setState_Net');
  if (typeof c.done === 'function') {
    await c.done();
  }
  return { primitiveId, componentType: readComponentType(current), applied };
}

async function inspectComponentsApi(limit = 5): Promise<unknown> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (!schCompClass || typeof schCompClass.getAll !== 'function') {
    throw new Error('SCH_PrimitiveComponent.getAll is not available in this EasyEDA runtime');
  }

  const comps = await schCompClass.getAll(undefined, true);
  const items = Array.isArray(comps) ? comps : [];
  return {
    total: items.length,
    samples: items
      .slice(0, Math.max(1, Math.min(limit, 25)))
      .map((item) => normalizeValue(item, 5)),
  };
}

async function inspectWiresApi(limit = 10, offset = 0): Promise<unknown> {
  const schWireClass = readFirstPath<any>([
    'SCH_PrimitiveWire',
    'SCH_PrimitiveWire3',
    'sch_PrimitiveWire',
  ]);
  if (!schWireClass || typeof schWireClass.getAll !== 'function') {
    throw new Error('SCH_PrimitiveWire.getAll is not available in this EasyEDA runtime');
  }

  const wires = await schWireClass.getAll();
  const items = Array.isArray(wires) ? wires : [];
  const start = Math.max(0, offset);
  const end = start + Math.max(1, Math.min(limit, 50));
  return {
    total: items.length,
    samples: items.slice(start, end).map((item) => summarizeWirePrimitive(item)),
  };
}

async function listLayersApi(): Promise<unknown> {
  const globalObj = getGlobal();
  const pcbLayerClass = readPath<any>(globalObj, 'pcb_Layer');
  if (!pcbLayerClass || typeof pcbLayerClass.getAllLayers !== 'function') {
    throw new Error('pcb_Layer class or getAllLayers method not found');
  }
  const layers = await pcbLayerClass.getAllLayers();
  return (layers || []).map((l: any) => ({
    name: l.name || '',
    type: l.type || '',
    color: l.color || '',
    visible: l.visible !== false,
    order: l.order || 0,
  }));
}

async function getStackupApi(): Promise<unknown> {
  const globalObj = getGlobal();
  const pcbLayerClass = readPath<any>(globalObj, 'pcb_Layer');
  if (!pcbLayerClass) {
    throw new Error('pcb_Layer class not found');
  }

  let totalCopper = 2;
  if (typeof pcbLayerClass.getTheNumberOfCopperLayers === 'function') {
    try {
      totalCopper = await pcbLayerClass.getTheNumberOfCopperLayers();
    } catch (e) {
      logRecoverableError('failed to read copper layer count', e);
    }
  }

  let physicalStacking: any = null;
  if (typeof pcbLayerClass.getCurrentPhysicalStackingConfiguration === 'function') {
    try {
      physicalStacking = await pcbLayerClass.getCurrentPhysicalStackingConfiguration();
    } catch (e) {
      logRecoverableError('failed to read physical stackup', e);
    }
  }

  const layers: any[] = [];
  if (physicalStacking && Array.isArray(physicalStacking.layers)) {
    for (const l of physicalStacking.layers) {
      layers.push({
        name: l.name || '',
        type: l.type || '',
        thicknessMm: l.thickness || 0,
        material: l.material || '',
        dielectricConstant: l.dielectric || 0,
        copperWeightOz: l.copperWeight || 0,
      });
    }
  }

  return {
    totalLayers: totalCopper,
    boardThicknessMm: physicalStacking?.thickness || 1.6,
    layers,
  };
}

async function getDimensionsApi(): Promise<unknown> {
  const globalObj = getGlobal();
  const pcbLineClass = readPath<any>(globalObj, 'pcb_PrimitiveLine');
  const pcbArcClass = readPath<any>(globalObj, 'pcb_PrimitiveArc');
  const pcbPadClass = readPath<any>(globalObj, 'pcb_PrimitivePad');

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  const updateBBox = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  if (pcbLineClass && typeof pcbLineClass.getAll === 'function') {
    try {
      const lines = await pcbLineClass.getAll();
      for (const l of lines || []) {
        if (typeof l.getState_Layer === 'function' && l.getState_Layer() === 11) {
          const points = typeof l.getState_Points === 'function' ? l.getState_Points() : [];
          for (const p of points || []) {
            updateBBox(p.x, p.y);
          }
        }
      }
    } catch (e) {
      logRecoverableError('failed to read board outline lines', e);
    }
  }

  if (pcbArcClass && typeof pcbArcClass.getAll === 'function') {
    try {
      const arcs = await pcbArcClass.getAll();
      for (const a of arcs || []) {
        if (typeof a.getState_Layer === 'function' && a.getState_Layer() === 11) {
          const sx = typeof a.getState_StartX === 'function' ? a.getState_StartX() : 0;
          const sy = typeof a.getState_StartY === 'function' ? a.getState_StartY() : 0;
          const ex = typeof a.getState_EndX === 'function' ? a.getState_EndX() : 0;
          const ey = typeof a.getState_EndY === 'function' ? a.getState_EndY() : 0;
          updateBBox(sx, sy);
          updateBBox(ex, ey);
        }
      }
    } catch (e) {
      logRecoverableError('failed to read board outline arcs', e);
    }
  }

  const width = maxX > minX ? maxX - minX : 0;
  const height = maxY > minY ? maxY - minY : 0;

  let mountingHoles = 0;
  if (pcbPadClass && typeof pcbPadClass.getAll === 'function') {
    try {
      const pads = await pcbPadClass.getAll();
      for (const p of pads || []) {
        const hType = typeof p.getState_HoleType === 'function' ? p.getState_HoleType() : '';
        const hSize = typeof p.getState_HoleSize === 'function' ? p.getState_HoleSize() : 0;
        if (hType === 'MountingHole' || hSize > 2) {
          mountingHoles++;
        }
      }
    } catch (e) {
      logRecoverableError('failed to read mounting-hole pads', e);
    }
  }

  return {
    widthMm: width,
    heightMm: height,
    shape: 'custom',
    mountingHoleCount: mountingHoles,
    areaMm2: width * height,
  };
}

async function getFeaturesApi(): Promise<unknown> {
  const globalObj = getGlobal();
  const pcbViaClass = readPath<any>(globalObj, 'pcb_PrimitiveVia');
  const pcbTrackClass = readPath<any>(globalObj, 'pcb_PrimitiveTrack');
  const pcbPadClass = readPath<any>(globalObj, 'pcb_PrimitivePad');
  const pcbPourClass = readPath<any>(globalObj, 'pcb_PrimitivePour');
  const pcbCompClass = readPath<any>(globalObj, 'pcb_PrimitiveComponent');

  let viasCount = 0;
  let tracksCount = 0;
  let padsCount = 0;
  let zonesCount = 0;
  let compsCount = 0;

  try {
    if (pcbViaClass && typeof pcbViaClass.getAll === 'function') {
      viasCount = (await pcbViaClass.getAll())?.length || 0;
    }
  } catch (e) {
    logRecoverableError('failed to count vias', e);
  }

  try {
    if (pcbTrackClass && typeof pcbTrackClass.getAll === 'function') {
      tracksCount = (await pcbTrackClass.getAll())?.length || 0;
    }
  } catch (e) {
    logRecoverableError('failed to count tracks', e);
  }

  try {
    if (pcbPadClass && typeof pcbPadClass.getAll === 'function') {
      padsCount = (await pcbPadClass.getAll())?.length || 0;
    }
  } catch (e) {
    logRecoverableError('failed to count pads', e);
  }

  try {
    if (pcbPourClass && typeof pcbPourClass.getAll === 'function') {
      zonesCount = (await pcbPourClass.getAll())?.length || 0;
    }
  } catch (e) {
    logRecoverableError('failed to count zones', e);
  }

  try {
    if (pcbCompClass && typeof pcbCompClass.getAll === 'function') {
      compsCount = (await pcbCompClass.getAll())?.length || 0;
    }
  } catch (e) {
    logRecoverableError('failed to count PCB components', e);
  }

  return {
    vias: viasCount,
    tracks: tracksCount,
    zones: zonesCount,
    pads: padsCount,
    components: compsCount,
  };
}

async function generateBomApi(params: any): Promise<unknown> {
  const comps = (await listComponentsApi()) as any[];
  const groupBy = params.groupBy || 'value';
  const groups = new Map<string, any>();

  for (const c of comps) {
    let key = '';
    if (groupBy === 'lcsc') {
      key = c.lcsc || c.value;
    } else if (groupBy === 'footprint') {
      key = c.footprint || 'no-footprint';
    } else {
      key = c.value || 'no-value';
    }

    if (!groups.has(key)) {
      groups.set(key, {
        references: [],
        value: c.value,
        footprint: c.footprint,
        lcsc: c.lcsc,
        manufacturer: c.manufacturer,
        quantity: 0,
      });
    }
    const group = groups.get(key);
    group.references.push(c.reference);
    group.quantity += 1;
  }

  const entries = [];
  for (const group of groups.values()) {
    entries.push({
      reference: group.references.join(', '),
      value: group.value,
      footprint: group.footprint,
      lcsc: group.lcsc,
      quantity: group.quantity,
      manufacturer: group.manufacturer,
    });
  }
  return entries;
}

/**
 * Try to connect a specific component pin to a net by finding the component,
 * locating the pin, and setting its net property. Falls back gracefully when
 * the runtime API does not expose pin-level modification.
 */
async function connectPinToNetImpl(
  primitiveId: string,
  pinNumber: string,
  netName: string,
): Promise<void> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);

  if (!schCompClass || typeof schCompClass.getAll !== 'function') {
    // Fallback: try SCH_Netlist API
    try {
      await callFirst(
        ['SCH_Netlist.create', 'sch_Netlist.create', 'SCH_Netlist.connectPin'],
        primitiveId,
        pinNumber,
        netName,
      );
      return;
    } catch {
      // Both paths failed — surface the primary error
      throw newBridgeError(
        'EASYEDA_API_ERROR',
        'No API available to connect pin to net. Ensure SCH_PrimitiveComponent and SCH_Netlist are available.',
        'Verify the bridge extension supports the installed EasyEDA Pro version.',
      );
    }
  }

  const comps = await schCompClass.getAll(undefined, true);

  // Try to find the component by:
  // 1. Primitive ID (e.g. "e98") — via getState().PrimitiveId
  // 2. Designator (e.g. "R1") — via getState_Designator()
  const target = (comps || []).find((c: any) => {
    try {
      // Check primitiveId via getState
      if (typeof c.getState === 'function') {
        const st = c.getState();
        if (st && st.PrimitiveId === primitiveId) return true;
      }
    } catch {}
    try {
      // Check getState_PrimitiveId directly
      if (
        typeof c.getState_PrimitiveId === 'function' &&
        String(c.getState_PrimitiveId()) === primitiveId
      )
        return true;
    } catch {}
    try {
      // Check by designator (legacy)
      if (typeof c.getState_Designator === 'function' && c.getState_Designator() === primitiveId)
        return true;
    } catch {}
    return false;
  });
  if (!target) {
    throw newBridgeError(
      'EASYEDA_API_ERROR',
      `Component with primitiveId "${primitiveId}" not found`,
      'Verify the primitiveId is correct.',
    );
  }

  if (typeof target.getAllPins !== 'function') {
    throw newBridgeError(
      'EASYEDA_API_ERROR',
      `Component "${primitiveId}" does not expose getAllPins`,
      'Component may not support pin enumeration.',
    );
  }

  const pins = await target.getAllPins();
  const targetPin = (pins || []).find(
    (p: any) =>
      typeof p.getState_PinNumber === 'function' &&
      String(p.getState_PinNumber()) === String(pinNumber),
  );
  if (!targetPin) {
    throw newBridgeError(
      'EASYEDA_API_ERROR',
      `Pin "${pinNumber}" not found on component "${primitiveId}"`,
      'Verify the pin number is correct.',
    );
  }

  // Modify the pin's OtherProperty to set the net name
  // This is the same property read by listNetsApi()
  const existing =
    typeof targetPin.getState_OtherProperty === 'function'
      ? targetPin.getState_OtherProperty()
      : {};
  const updated = { ...(existing || {}), net: netName };

  if (typeof targetPin.setState_OtherProperty === 'function') {
    targetPin.setState_OtherProperty(updated);
  } else {
    // Fallback: try explicit modify on the component
    try {
      await callFirst(
        ['SCH_PrimitiveComponent.modify', 'sch_PrimitiveComponent.modify'],
        primitiveId,
        { property: { OtherProperty: updated } },
      );
    } catch {
      throw newBridgeError(
        'EASYEDA_API_ERROR',
        'Pin found but no API available to modify its net property.',
        'The EasyEDA Pro runtime may not support programmatic pin net assignment.',
      );
    }
  }
}

function normalizeDrcSeverity(raw: unknown): 'error' | 'warning' | 'info' {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('fatal') || s.includes('error')) return 'error';
  if (s.includes('warn')) return 'warning';
  return 'info';
}

function normalizeDrcViolation(item: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
  const message = obj.message ?? obj.msg ?? obj.description ?? obj.text ?? obj.detail ?? item;
  const severitySource = obj.level ?? obj.severity ?? obj.type ?? obj.errorLevel;
  const posSource =
    obj.position && typeof obj.position === 'object'
      ? (obj.position as Record<string, unknown>)
      : obj.location && typeof obj.location === 'object'
        ? (obj.location as Record<string, unknown>)
        : obj;
  const x = posSource.x;
  const y = posSource.y;
  return {
    rule: String(obj.rule ?? obj.ruleName ?? obj.type ?? 'unknown'),
    description: typeof message === 'string' ? message : JSON.stringify(message),
    severity: normalizeDrcSeverity(severitySource),
    net: obj.net ?? obj.netName ?? undefined,
    component: obj.component ?? obj.ref ?? obj.designator ?? obj.primitiveId ?? undefined,
    location:
      typeof x === 'number' && typeof y === 'number'
        ? { x, y, layer: obj.layer as string | undefined }
        : undefined,
  };
}

/**
 * Detects the `{type: 'fatal'|'error'|'warn'|'info', count: number}` shape
 * that `SCH_Drc.check`/`PCB_Drc.check` actually return in verbose mode —
 * confirmed live: a schematic with 6 real "multiple net names" warnings
 * (visible itemized in EasyEDA's own bottom DRC panel) produced exactly one
 * verbose-array entry, `{type:"warn", count:6}`. The native API only exposes
 * coarse per-severity totals through its return value; the itemized
 * per-violation text (which wire, which net) is rendered by the UI panel
 * itself and is not part of what check() resolves with, so it cannot be
 * reconstructed here.
 */
function normalizeDrcAggregate(
  item: unknown,
): { severity: 'error' | 'warning' | 'info'; count: number } | null {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj) return null;
  const { type, count } = obj;
  if (typeof type === 'string' && typeof count === 'number') {
    return { severity: normalizeDrcSeverity(type), count };
  }
  return null;
}

/**
 * Runs the native SCH_Drc.check/PCB_Drc.check API correctly.
 *
 * The previous implementation forwarded a single `{projectId, ...}` params
 * object as the function's first argument, but the real signature is
 * `check(strict: boolean, userInterface: boolean, includeVerboseError: boolean)`
 * — three positional booleans, not one options object. Passing an object for
 * `strict` made `includeVerboseError` implicitly `undefined` (falsy), which
 * selects the *boolean-return* overload instead of the verbose-array one. The
 * tool then silently treated that stray `true`/`false` as an empty result,
 * so `easyeda_erc_run`/`easyeda_drc_run` always reported 0 violations/passed
 * regardless of what EasyEDA's own DRC panel actually found.
 *
 * Passing `userInterface: false` alone was still not enough: verified live
 * against a schematic with 6 real "multiple net names" wire warnings visible
 * in EasyEDA's own bottom DRC panel, `check(true, false, true)` returned an
 * empty violations array — the netlist/wire-consistency class of checks only
 * runs as part of the *UI-driven* check path, not the headless one. Calling
 * with `userInterface: true` (the same thing clicking "Check DRC" does) is
 * required to actually populate the verbose violations array; this opens/
 * refreshes the bottom DRC panel in the user's EasyEDA window as a visible
 * side effect, same as the manual button.
 */
async function runDrcCheck(classPaths: string[]): Promise<{
  violations: Array<Record<string, unknown>>;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  passed: boolean;
}> {
  const raw = await callFirst(classPaths, true, true, true);
  const items = Array.isArray(raw) ? raw : [];

  const aggregates = items
    .map(normalizeDrcAggregate)
    .filter((a): a is { severity: 'error' | 'warning' | 'info'; count: number } => a !== null);

  if (aggregates.length > 0) {
    const violations = aggregates
      .filter((a) => a.count > 0)
      .map((a) => ({
        rule: 'aggregate',
        description:
          `${a.count} ${a.severity}(s) reported by EasyEDA's native design/electrical rule ` +
          "check. Per-violation detail (affected wire/net/component) is only shown in EasyEDA " +
          "Pro's own bottom DRC panel and is not exposed by the check() API's return value.",
        severity: a.severity,
      }));
    const errorCount = aggregates
      .filter((a) => a.severity === 'error')
      .reduce((sum, a) => sum + a.count, 0);
    const warningCount = aggregates
      .filter((a) => a.severity === 'warning')
      .reduce((sum, a) => sum + a.count, 0);
    return {
      violations,
      totalViolations: aggregates.reduce((sum, a) => sum + a.count, 0),
      errorCount,
      warningCount,
      passed: errorCount === 0,
    };
  }

  const violations = items.map(normalizeDrcViolation);
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warningCount = violations.filter((v) => v.severity === 'warning').length;
  return {
    violations,
    totalViolations: violations.length,
    errorCount,
    warningCount,
    passed: errorCount === 0,
  };
}

async function dispatch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case 'project.open':
      return callFirst(['dmt_Project.openProject', 'project.open'], params.projectId);
    case 'project.save':
      return callFirst([
        'dmt_Workspace.saveAll',
        'dmt_Workspace.saveActiveDocument',
        'sch_Document.save',
        'pcb_Document.save',
        'pnl_Document.save',
      ]);
    case 'project.export':
      return callFirst(
        ['PCB_ManufactureData.getManufactureData', 'SCH_ManufactureData.getExportDocumentFile'],
        params,
      );
    case 'schematic.listNets':
      return listNetsApi();
    case 'schematic.getNetDetail': {
      const netName = params.netName as string;
      const allNets = (await listNetsApi()) as Array<{ netName: string; nodes: unknown[] }>;
      const match = allNets.find((n) => n.netName === netName);
      if (!match)
        throw newBridgeError(
          'NET_NOT_FOUND',
          `Net "${netName}" not found`,
          'Check net name spelling.',
        );
      return match;
    }
    case 'schematic.listComponents':
      return listComponentsApi();
    case 'schematic.getSheetInfo':
      return getSchematicSheetInfoApi();
    case 'schematic.searchDevice':
      return callFirst(
        ['LIB_Device.search', 'lib_Device.search'],
        params.key,
        params.libraryUuid,
        params.classification,
        params.symbolType,
        params.itemsOfPage,
        params.page,
      );
    case 'schematic.placeComponent': {
      // SCH_PrimitiveComponent.create expects (deviceItem, x, y) only.
      // Extra arguments cause the API to hang or reject.
      const createdComp = await callFirst(
        ['SCH_PrimitiveComponent.create', 'sch_PrimitiveComponent.create'],
        params.deviceItem,
        params.x,
        params.y,
      );
      // Resolve the library "R?"/"U?" placeholder to a unique designator so the
      // netlist keeps distinct parts distinct. Best-effort: if annotation fails
      // the component is still placed, just with its placeholder designator.
      try {
        const newDesig = await assignAutoDesignator(createdComp);
        if (newDesig && createdComp && typeof createdComp === 'object') {
          (createdComp as Record<string, unknown>).designator = newDesig;
        }
      } catch (e) {
        logRecoverableError('auto-designator failed', e);
      }
      // create() ignores rotation; apply it after placement so the caller's
      // requested orientation actually takes effect.
      try {
        const appliedRot = await applyPlacedRotation(createdComp, params.rotation);
        if (appliedRot !== undefined && createdComp && typeof createdComp === 'object') {
          (createdComp as Record<string, unknown>).rotation = appliedRot;
        }
      } catch (e) {
        logRecoverableError('apply-rotation failed', e);
      }
      return createdComp;
    }
    case 'schematic.addWire': {
      const rawPoints: Array<{ x: number; y: number }> = Array.isArray(params.points)
        ? params.points
        : [];
      const netName = params.netName as string;

      const collision = await findForeignNetCollision(rawPoints, netName);
      if (collision) {
        throw newBridgeError(
          'NET_COLLISION',
          `Refusing to draw wire for net "${netName}": point (${collision.x}, ${collision.y}) ` +
            `coincides with an existing wire on net "${collision.foreignNet}". EasyEDA Pro ` +
            'auto-merges wires that share a coordinate (not just endpoints), which would ' +
            'silently short these two nets together.',
          `Route this wire through coordinates not used by net "${collision.foreignNet}", ` +
            'or call schematic_nets afterward to confirm the intended topology.',
        );
      }

      const pts = rawPoints.flatMap((p) => [p.x, p.y]);
      return callFirst(
        ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
        pts,
        netName,
        params.color,
        params.lineWidth,
        params.lineType,
      );
    }
    case 'schematic.deletePrimitive':
      return callFirst(
        [
          'SCH_PrimitiveComponent.delete',
          'SCH_PrimitiveWire.delete',
          'sch_PrimitiveComponent.delete',
          'sch_PrimitiveWire.delete',
        ],
        params.primitiveIds,
      );
    case 'schematic.modifyPrimitive': {
      // The native SCH_PrimitiveComponent.modify/SCH_PrimitiveWire.modify APIs
      // reset any property field omitted from the call rather than leaving it
      // unchanged (e.g. passing only `{ designator }` wipes manufacturer/
      // supplier/otherProperty). To make partial updates behave like partial
      // updates, snapshot the primitive's current state first and merge the
      // caller's partial property over it before writing.
      const primitiveId = params.primitiveId as string;
      const property = (params.property as Record<string, unknown>) || {};

      const schCompClass = readFirstPath<any>([
        'SCH_PrimitiveComponent',
        'SCH_PrimitiveComponent3',
        'sch_PrimitiveComponent',
      ]);
      if (schCompClass && typeof schCompClass.get === 'function' && typeof schCompClass.modify === 'function') {
        let current: unknown;
        try {
          current = await schCompClass.get(primitiveId);
        } catch (e) {
          logRecoverableError(`SCH_PrimitiveComponent.get(${primitiveId}) failed`, e);
        }
        if (current) {
          // Net flags / net ports are components too, but the modify() wrapper
          // refuses them. Reposition them via the low-level setState path so
          // modify_primitive can move a VCC/GND flag's label off a crowded pin.
          const ct = readComponentType(current);
          if (ct === 'netflag' || ct === 'netport') {
            return applyNetFlagState(current, primitiveId, property);
          }
          const existingOther =
            (safeGetState(current, 'OtherProperty') as Record<string, unknown> | undefined) || {};
          const incomingOther = property.otherProperty as Record<string, unknown> | undefined;
          const merged: Record<string, unknown> = {
            x: safeGetState(current, 'X'),
            y: safeGetState(current, 'Y'),
            rotation: safeGetState(current, 'Rotation'),
            mirror: safeGetState(current, 'Mirror'),
            addIntoBom: safeGetState(current, 'AddIntoBom'),
            addIntoPcb: safeGetState(current, 'AddIntoPcb'),
            designator: safeGetState(current, 'Designator'),
            name: safeGetState(current, 'Name'),
            uniqueId: safeGetState(current, 'UniqueId'),
            manufacturer: safeGetState(current, 'Manufacturer'),
            manufacturerId: safeGetState(current, 'ManufacturerId'),
            supplier: safeGetState(current, 'Supplier'),
            supplierId: safeGetState(current, 'SupplierId'),
            ...property,
            otherProperty: incomingOther ? { ...existingOther, ...incomingOther } : existingOther,
          };
          return schCompClass.modify(primitiveId, merged);
        }
      }

      const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
      if (schWireClass && typeof schWireClass.get === 'function' && typeof schWireClass.modify === 'function') {
        let current: unknown;
        try {
          current = await schWireClass.get(primitiveId);
        } catch (e) {
          logRecoverableError(`SCH_PrimitiveWire.get(${primitiveId}) failed`, e);
        }
        if (current) {
          const merged: Record<string, unknown> = {
            line: safeGetState(current, 'Line'),
            net: safeGetState(current, 'Net'),
            color: safeGetState(current, 'Color'),
            lineWidth: safeGetState(current, 'LineWidth'),
            lineType: safeGetState(current, 'LineType'),
            ...property,
          };
          return schWireClass.modify(primitiveId, merged);
        }
      }

      // Fallback for primitive types this runtime doesn't expose get() for —
      // best-effort passthrough, same as the previous behavior.
      return callFirst(
        [
          'SCH_PrimitiveComponent.modify',
          'SCH_PrimitiveWire.modify',
          'sch_PrimitiveComponent.modify',
          'sch_PrimitiveWire.modify',
        ],
        primitiveId,
        property,
      );
    }
    case 'schematic.createNetFlag': {
      const nfX = params.x as number;
      const nfY = params.y as number;
      const nfName = params.netName as string;
      const nfRotation = (params.rotation as number) ?? 0;
      // EasyEDA Pro exposes two distinct primitives here (verified against the
      // live runtime inventory):
      //   - SCH_PrimitiveComponent.createNetFlag(identification, net, x, y, rotation, mirror)
      //     is the power-symbol flag and only accepts the four power
      //     identifications (Power / Ground / AnalogGround / ProtectGround).
      //   - SCH_PrimitiveAttribute.createNetLabel(x, y, net) is the generic
      //     named net label that works for any net name.
      // Prefer the power flag when a valid identification is supplied,
      // otherwise fall back to a generic net label.
      const POWER_IDS = ['Power', 'Ground', 'AnalogGround', 'ProtectGround'];
      const nfIdentification = params.identification as string | undefined;
      let nfResult: unknown;
      if (nfIdentification && POWER_IDS.includes(nfIdentification)) {
        nfResult = await callFirst(
          ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
          nfIdentification,
          nfName,
          nfX,
          nfY,
          nfRotation,
        );
      } else {
        // NOTE: createNetLabel returns no addressable primitive id, and an
        // unattached net label is not registered in SCH_PrimitiveAttribute's
        // id set until it lands on a wire (verified live via api.call), so
        // there is no reliable id to recover at creation time.
        nfResult = await callFirst(
          ['SCH_PrimitiveAttribute.createNetLabel', 'sch_PrimitiveAttribute.createNetLabel'],
          nfX,
          nfY,
          nfName,
        );
      }
      const nfPrimitiveId = extractPrimitiveId(nfResult);
      return {
        primitiveId: nfPrimitiveId || `netflag_${Date.now()}`,
        netName: nfName,
      };
    }
    case 'schematic.createNetPort': {
      const npX = params.x as number;
      const npY = params.y as number;
      const npName = params.netName as string;
      const npRotation = (params.rotation as number) ?? 0;
      // SCH_PrimitiveComponent.createNetPort(direction, net, x, y, rotation, mirror)
      // where direction is one of IN / OUT / BI. Map the MCP portType onto it.
      const portTypeMap: Record<string, 'IN' | 'OUT' | 'BI'> = {
        input: 'IN',
        output: 'OUT',
        bidirectional: 'BI',
        triState: 'BI',
        passive: 'BI',
      };
      const npDirection = portTypeMap[(params.portType as string) ?? 'passive'] ?? 'BI';
      const npResult = await callFirst(
        ['SCH_PrimitiveComponent.createNetPort', 'sch_PrimitiveComponent.createNetPort'],
        npDirection,
        npName,
        npX,
        npY,
        npRotation,
      );
      const npPrimitiveId = extractPrimitiveId(npResult);
      return {
        primitiveId: npPrimitiveId || `netport_${Date.now()}`,
        netName: npName,
      };
    }
    case 'schematic.connectPinToNet': {
      await connectPinToNetImpl(
        params.primitiveId as string,
        params.pinNumber as string,
        params.netName as string,
      );
      // connectPinToNetImpl stamps a custom pin.OtherProperty.net value; it is
      // NOT a real SCH_Netlist/SCH_Net entry, so it is invisible to ERC,
      // ratsnest, and autorouting. Report that honestly rather than implying
      // this created genuine EasyEDA connectivity.
      return {
        connected: true,
        real: false,
        warning:
          'This records a logical pin/net association as a custom pin property, not real ' +
          'EasyEDA netlist connectivity. It will NOT appear in ERC, ratsnest, or autorouting. ' +
          'Use schematic.addWire to create genuine electrical connectivity.',
      };
    }
    case 'schematic.connectPinsByNet': {
      const pins = params.pins as Array<{ primitiveId: string; pinNumber: string }>;
      let connectedCount = 0;
      for (const pin of pins || []) {
        try {
          await connectPinToNetImpl(pin.primitiveId, pin.pinNumber, params.netName as string);
          connectedCount++;
        } catch (err) {
          logRecoverableError(
            `connectPinToNet failed for ${pin.primitiveId}/${pin.pinNumber}`,
            err,
          );
        }
      }
      return {
        count: connectedCount,
        real: false,
        warning:
          'This records logical pin/net associations as custom pin properties, not real ' +
          'EasyEDA netlist connectivity. It will NOT appear in ERC, ratsnest, or autorouting. ' +
          'Use schematic.addWire to create genuine electrical connectivity.',
      };
    }
    case 'schematic.validateNetlist': {
      const netlistData = (await listNetsApi()) as Array<{
        netName: string;
        nodes: Array<{ component: string; pin: string }>;
      }>;
      const connectedRefs = new Set<string>();
      const connectedPins = new Set<string>();
      const nets = (netlistData || []).map((n) => {
        const refs = [...new Set((n.nodes || []).map((node) => node.component))];
        const pins = (n.nodes || []).map((node) => node.pin);
        refs.forEach((r) => connectedRefs.add(r));
        pins.forEach((p) => connectedPins.add(p));
        return {
          netName: n.netName,
          refs,
          pins,
          hasNetFlag: true,
        };
      });
      // Floating pins: pins whose (designator, pin) does not appear in any
      // net's node list. Determine connectivity from the same authoritative
      // net data used to build `nets` above — NOT by re-reading each pin's
      // OtherProperty.net. That property is only populated for pins connected
      // via a stamped pin property and is empty for pins connected by a wire,
      // power/ground flag, or net label, so re-reading it misreported every
      // wire/flag/label-connected pin as floating.
      const connectedNodes = new Set<string>();
      for (const n of netlistData || []) {
        for (const node of n.nodes || []) {
          connectedNodes.add(`${node.component} ${node.pin}`);
        }
      }
      const floatingPins: Array<{ primitiveId: string; designator: string; pinNumber: string }> =
        [];
      const partRefs = new Set<string>();
      const schCompClass = readFirstPath<any>([
        'SCH_PrimitiveComponent',
        'SCH_PrimitiveComponent3',
        'sch_PrimitiveComponent',
      ]);
      if (schCompClass && typeof schCompClass.getAll === 'function') {
        const allComps = await schCompClass.getAll(undefined, true);
        for (const c of allComps || []) {
          const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
          // Skip primitives without a designator (title block, net flags, net
          // ports, net labels): they are not schematic parts and have no pins
          // to treat as floating, and counting them inflated the tally.
          if (!ref || typeof c.getAllPins !== 'function') continue;
          partRefs.add(ref);
          const primitiveId =
            typeof c.getState_PrimitiveId === 'function' ? String(c.getState_PrimitiveId()) : '';
          try {
            const pins = await c.getAllPins();
            for (const p of pins || []) {
              if (typeof p.getState_PinNumber !== 'function') continue;
              const pinNum = String(p.getState_PinNumber());
              if (!connectedNodes.has(`${ref} ${pinNum}`)) {
                floatingPins.push({
                  primitiveId: primitiveId || ref,
                  designator: ref,
                  pinNumber: pinNum,
                });
              }
            }
          } catch {
            // skip component
          }
        }
      }
      const warnings: string[] = [];
      // Count only real parts (those with a designator), not net flags/ports/
      // labels or the title block, so the tally is not inflated by non-parts.
      const totalRefs = partRefs.size;
      if (floatingPins.length > 0) {
        warnings.push(`${floatingPins.length} pin(s) are not connected to any net.`);
      }
      if (connectedRefs.size < totalRefs) {
        warnings.push(`${totalRefs - connectedRefs.size} component(s) have no net connections.`);
      }
      // The `nets` above are INFERRED from pin properties + coordinate
      // coincidence. A power/ground flag (or any pin) sitting exactly on
      // another pin is reported here as connected, but EasyEDA's native ERC
      // treats overlapping endpoints as "overlap and not connected" unless a
      // wire actually joins them. Cross-check with the native ERC so `valid`
      // cannot be a false positive (this is the authoritative source).
      let nativeErc: { errorCount: number; warningCount: number; passed: boolean } | undefined;
      try {
        const drc = await runDrcCheck(['SCH_Drc.check']);
        nativeErc = {
          errorCount: drc.errorCount,
          warningCount: drc.warningCount,
          passed: drc.passed,
        };
        if (drc.errorCount > 0) {
          warnings.push(
            `Native ERC reports ${drc.errorCount} error(s): the inferred connectivity above may ` +
              'include pins that overlap without a wire (not truly connected). Run erc_run or ' +
              "check EasyEDA's DRC panel for authoritative, per-violation detail.",
          );
        }
      } catch (e) {
        logRecoverableError('validateNetlist: native ERC cross-check failed', e);
      }
      return {
        nets,
        floatingPins,
        wiresWithoutNetlist: [],
        nativeErc,
        warnings,
      };
    }
    case 'system.apiInventory':
      return inspectApiInventory(typeof params.filter === 'string' ? params.filter : undefined);
    case 'system.inspectComponents':
      return inspectComponentsApi(typeof params.limit === 'number' ? params.limit : 5);
    case 'system.inspectWires':
      return inspectWiresApi(
        typeof params.limit === 'number' ? params.limit : 10,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'api.call':
      return callAllowedApi(
        typeof params.path === 'string' ? params.path : '',
        Array.isArray(params.args) ? params.args : [],
      );
    case 'api.execute': {
      const code = typeof params.code === 'string' ? params.code : '';
      if (!code.trim())
        throw newBridgeError(
          'INVALID_PARAMS',
          'code is required',
          'Provide JavaScript code to execute',
        );
      const AsyncFunction = Object.getPrototypeOf(async function () {})
        .constructor as FunctionConstructor;
      const edaGlobal = (() => {
        try {
          if (typeof eda !== 'undefined' && eda) return eda;
        } catch {}
        return (globalThis as any).eda;
      })();
      const fn = new AsyncFunction('eda', code) as (eda: unknown) => Promise<unknown>;
      const result = await fn(edaGlobal);
      return { result: normalizeValue(result, 5) };
    }
    case 'board.listLayers':
      return listLayersApi();
    case 'board.getStackup':
      return getStackupApi();
    case 'board.getDimensions':
      return getDimensionsApi();
    case 'board.getFeatures':
      return getFeaturesApi();
    case 'board.exportGerbers':
      return normalizeBinaryResultSafely(
        await callFirst(['PCB_ManufactureData.getGerberFile'], params),
        'gerbers.zip',
      );
    case 'pcb.exportRouteContext':
      return normalizeBinaryResultSafely(
        await callFirst(
          ['PCB_ManufactureData.getDsnFile'],
          typeof params.fileName === 'string' ? params.fileName : undefined,
        ),
        'route-context.dsn',
      );
    case 'system.getStatus': {
      const globals: Record<string, unknown> = {};
      try {
        globals.typeof_api = typeof (globalThis as any).api;
        globals.typeof_eda = typeof (globalThis as any).eda;
        globals.typeof_EDA = typeof (globalThis as any).EDA;

        try {
          globals.typeof_local_api = typeof api;
        } catch (e) {
          globals.typeof_local_api_err = String(e);
        }
        try {
          globals.typeof_local_eda = typeof eda;
        } catch (e) {
          globals.typeof_local_eda_err = String(e);
        }
        try {
          globals.typeof_local_EDA = typeof EDA;
        } catch (e) {
          globals.typeof_local_EDA_err = String(e);
        }

        if (typeof eda !== 'undefined' && eda) {
          try {
            globals.eda_keys = Object.getOwnPropertyNames(eda);
          } catch (e) {
            globals.eda_keys_err = String(e);
          }
          try {
            const edaKeys: string[] = [];
            for (const key in eda) {
              edaKeys.push(key);
            }
            globals.eda_for_in_keys = edaKeys;
          } catch (e) {
            globals.eda_for_in_keys_err = String(e);
          }

          const getAllPropertyNames = (obj: any): string[] => {
            let props: string[] = [];
            let currentObj = obj;
            while (currentObj && currentObj !== Object.prototype) {
              try {
                props = props.concat(Object.getOwnPropertyNames(currentObj));
              } catch (e) {
                logRecoverableError('failed to read debug probe property names', e);
              }
              try {
                currentObj = Object.getPrototypeOf(currentObj);
              } catch (e) {
                logRecoverableError('failed to read debug probe prototype', e);
                break;
              }
            }
            return Array.from(new Set(props)).filter(
              (p) => !['length', 'name', 'prototype', 'constructor'].includes(p),
            );
          };

          try {
            if ((eda as any).sch_PrimitiveComponent) {
              globals.sch_PrimitiveComponent_all_keys = getAllPropertyNames(
                (eda as any).sch_PrimitiveComponent,
              );
            }
          } catch (e) {
            globals.sch_PrimitiveComponent_err = String(e);
          }

          try {
            if ((eda as any).sch_Document) {
              globals.sch_Document_all_keys = getAllPropertyNames((eda as any).sch_Document);
            }
          } catch (e) {
            globals.sch_Document_err = String(e);
          }

          try {
            if ((eda as any).pcb_Document) {
              globals.pcb_Document_all_keys = getAllPropertyNames((eda as any).pcb_Document);
            }
          } catch (e) {
            globals.pcb_Document_err = String(e);
          }

          try {
            if ((eda as any).dmt_Schematic) {
              globals.dmt_Schematic_all_keys = getAllPropertyNames((eda as any).dmt_Schematic);
            }
          } catch (e) {
            globals.dmt_Schematic_err = String(e);
          }

          try {
            if ((eda as any).dmt_Project) {
              globals.dmt_Project_all_keys = getAllPropertyNames((eda as any).dmt_Project);
            }
          } catch (e) {
            globals.dmt_Project_err = String(e);
          }

          try {
            if ((eda as any).dmt_Pcb) {
              globals.dmt_Pcb_all_keys = getAllPropertyNames((eda as any).dmt_Pcb);
            }
          } catch (e) {
            globals.dmt_Pcb_err = String(e);
          }
        }

        if (typeof EDA !== 'undefined' && EDA) {
          try {
            globals.EDA_keys = Object.getOwnPropertyNames(EDA as object);
          } catch (e) {
            globals.EDA_keys_err = String(e);
          }
          try {
            const edaKeys: string[] = [];
            for (const key in EDA as object) {
              edaKeys.push(key);
            }
            globals.EDA_for_in_keys = edaKeys;
          } catch (e) {
            globals.EDA_for_in_keys_err = String(e);
          }
        }

        try {
          const globalKeys = Object.getOwnPropertyNames(globalThis);
          globals.globalThis_matched_keys = globalKeys.filter((k) => {
            const kl = k.toLowerCase();
            return (
              kl.includes('dmt') ||
              kl.includes('eda') ||
              kl.includes('schematic') ||
              kl.includes('pcb') ||
              kl.includes('api')
            );
          });
        } catch (e) {
          globals.globalThis_keys_err = String(e);
        }

        try {
          const allGlobalKeys: string[] = [];
          for (const key in globalThis) {
            const kl = key.toLowerCase();
            if (
              kl.includes('dmt') ||
              kl.includes('eda') ||
              kl.includes('schematic') ||
              kl.includes('pcb') ||
              kl.includes('api')
            ) {
              allGlobalKeys.push(key);
            }
          }
          globals.globalThis_for_in_matched_keys = allGlobalKeys;
        } catch (e) {
          globals.globalThis_for_in_err = String(e);
        }
      } catch (e) {
        globals.error = String(e);
      }

      const hasEdaLocal = typeof eda !== 'undefined';
      const hasEDALocal = typeof EDA !== 'undefined';
      const hasDMTLocal = typeof eda !== 'undefined' && eda && 'DMT_Schematic' in (eda as any);
      const hasDMTEDA = typeof EDA !== 'undefined' && EDA && 'DMT_Schematic' in (EDA as any);

      return {
        bridgeVersion: BRIDGE_VERSION,
        capabilities: [
          'project.open',
          'project.save',
          'project.export',
          'schematic.listNets',
          'schematic.getNetDetail',
          'schematic.listComponents',
          'schematic.searchDevice',
          'schematic.getSheetInfo',
          'schematic.placeComponent',
          'schematic.addWire',
          'schematic.deletePrimitive',
          'schematic.modifyPrimitive',
          'schematic.createNetFlag',
          'schematic.createNetPort',
          'schematic.connectPinToNet',
          'schematic.connectPinsByNet',
          'schematic.validateNetlist',
          'system.apiInventory',
          'system.inspectComponents',
          'system.inspectWires',
          'api.call',
          'api.execute',
          'board.listLayers',
          'board.getStackup',
          'board.getDimensions',
          'board.getFeatures',
          'board.exportGerbers',
          'bom.generate',
          'bom.validate',
          'inventory.search',
          'inventory.getPrice',
          'design.ruleCheck',
          'design.erc',
          'design.drc',
          'export.pickPlace',
          'export.pdf',
          'export.netlist',
          'pcb.placeComponent',
          'pcb.addTrack',
          'pcb.addVia',
          'pcb.addZone',
          'pcb.deleteComponent',
          'pcb.modifyComponent',
          'canvas.capture',
          'canvas.captureRegion',
          'canvas.locate',
          'library.getDeviceByLcscId',
        ],
        devMode: false,
        globals: globals,
        hasEda: hasEdaLocal || hasEDALocal,
        hasDMT: 'DMT_Schematic' in globalThis || !!hasDMTLocal || !!hasDMTEDA,
      };
    }
    case 'bom.generate':
      return generateBomApi(params);
    case 'bom.validate': {
      const comps = (await listComponentsApi()) as any[];
      return { totalParts: comps.length, missing: [], obsolete: [], alternates: [] };
    }
    case 'inventory.search':
      return [];
    case 'inventory.getPrice':
      return null;
    case 'design.ruleCheck':
      return runDrcCheck(['PCB_Drc.check', 'SCH_Drc.check']);
    case 'design.erc':
      return runDrcCheck(['SCH_Drc.check']);
    case 'design.drc':
      return runDrcCheck(['PCB_Drc.check', 'SCH_Drc.check']);
    case 'export.pickPlace':
      return normalizeBinaryResultSafely(
        await callFirst(['PCB_ManufactureData.getPickAndPlaceFile'], params),
        `pick-place.${typeof params.format === 'string' ? params.format : 'csv'}`,
      );
    case 'export.pdf':
      return normalizeBinaryResultSafely(
        await callFirst(
          ['PCB_ManufactureData.getPdfFile', 'SCH_ManufactureData.getExportDocumentFile'],
          params.what === 'board' ? params : { ...params, type: 'schematic' },
        ),
        'export.pdf',
      );
    case 'export.netlist':
      return normalizeBinaryResultSafely(
        await callFirst(
          [
            'SCH_Netlist.getNetlist',
            'SCH_ManufactureData.getNetlistFile',
            'PCB_ManufactureData.getNetlistFile',
          ],
          params,
        ),
        `netlist.${typeof params.format === 'string' ? params.format : 'txt'}`,
      );
    case 'canvas.capture': {
      const tabId = typeof params.tabId === 'string' ? params.tabId : undefined;
      const blob = await callFirst(['DMT_EditorControl.getCurrentRenderedAreaImage'], tabId);
      return normalizeBinaryResultSafely(blob, 'capture.png');
    }
    case 'canvas.captureRegion': {
      const { left, right, top, bottom, tabId } = params as {
        left: number;
        right: number;
        top: number;
        bottom: number;
        tabId?: string;
      };
      await callFirst(['DMT_EditorControl.zoomToRegion'], left, right, top, bottom, tabId);
      const blob = await callFirst(['DMT_EditorControl.getCurrentRenderedAreaImage'], tabId);
      return normalizeBinaryResultSafely(blob, 'capture-region.png');
    }
    case 'canvas.locate': {
      const { x, y, scaleRatio, tabId } = params as {
        x?: number;
        y?: number;
        scaleRatio?: number;
        tabId?: string;
      };
      return callFirst(['DMT_EditorControl.zoomTo'], x, y, scaleRatio, tabId);
    }
    case 'library.getDeviceByLcscId': {
      const lcscId = String(params.lcscId ?? '');
      const libraryUuid = typeof params.libraryUuid === 'string' ? params.libraryUuid : undefined;
      return callFirst(['LIB_Device.getByLcscIds'], [lcscId], libraryUuid, false);
    }
    case 'pcb.placeComponent':
      return callFirst(
        ['PCB_PrimitiveComponent.create', 'pcb_PrimitiveComponent.create'],
        params.footprint,
        params.x,
        params.y,
        params.rotation,
        params.layer,
      );
    case 'pcb.addTrack':
      return callFirst(
        ['PCB_PrimitivePolyline.create', 'PCB_PrimitiveLine.create'],
        params.points,
        params.layer,
        params.width,
        params.netName,
      );
    case 'pcb.addVia':
      return callFirst(
        ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
        params.x,
        params.y,
        params.outerDiameter,
        params.holeSize,
        params.netName,
      );
    case 'pcb.addZone':
      return callFirst(
        ['PCB_PrimitivePour.create', 'PCB_ComplexPolygon.create', 'pcb_PrimitivePour.create'],
        params.points,
        params.layer,
        params.netName,
        params.clearance,
      );
    case 'pcb.deleteComponent':
      return callFirst(
        ['PCB_PrimitiveComponent.delete', 'pcb_PrimitiveComponent.delete'],
        params.primitiveIds,
      );
    case 'pcb.modifyComponent':
      return callFirst(
        ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
        params.primitiveId,
        params.property,
      );
    default:
      throw newBridgeError(
        'METHOD_NOT_ALLOWED',
        `Unsupported bridge method: ${method}`,
        'Update the extension dispatcher or call a supported method.',
      );
  }
}

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
  // EasyEDA Pro v3.2.x can also create the socket but never call connectedCallFn,
  // so fire the open hook through a guarded fallback timer as well.
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
      setTimeout(fireOpen, EASYEDA_REGISTER_OPEN_FALLBACK_MS);
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

function send(data: JsonValue): void {
  const payload = JSON.stringify(data);
  const sysWs = getWsApi();

  if (socketHandle?.type === 'easyeda-register' && sysWs?.send) {
    try {
      sysWs.send(socketHandle.id ?? SOCKET_ID, payload);
      return;
    } catch (err) {
      log('sysWs.send threw exception', err);
      closeSocket();
    }
    return;
  }

  try {
    socketHandle?.raw?.send?.(payload);
  } catch (err) {
    log('socket raw send threw exception', err);
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
    extensionVersion: '0.21.0', // x-release-please-version
    easyedaVersion: getEasyedaVersion(),
    devMode: false,
  };
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
      logRecoverableError('failed to read EasyEDA version', error);
      return undefined;
    }
  }
  return undefined;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connectedPort !== null) {
      send({ type: 'heartbeat', timestamp: Date.now() });
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleRequest(message: BridgeRequest): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await dispatch(message.method, message.params);
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
        message:
          error instanceof Error
            ? error.message
            : isRecord(error) && typeof error.message === 'string'
              ? error.message
              : String(error),
        suggestion: String(record.suggestion ?? 'Check EasyEDA Pro and extension logs.'),
        data: record.data,
      },
      durationMs: Date.now() - startedAt,
    };
    send(response as unknown as JsonValue);
  }
}

function handleMessage(raw: string): InboundMessageType {
  const message = JSON.parse(raw) as { type?: string };

  if (message.type === 'hello') {
    const record = message as Record<string, unknown>;
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
    log('Bridge handshake accepted');
    return 'hello';
  }

  if (message.type === 'heartbeat') {
    send({ type: 'heartbeat', timestamp: Date.now() });
    return 'heartbeat';
  }

  if (message.type === 'request') {
    void handleRequest(message as BridgeRequest);
    return 'request';
  }

  return 'ignored';
}

async function connectToPort(
  port: number,
  runId: number,
  showSuccessToast: boolean,
): Promise<boolean> {
  const url = `ws://${LOOPBACK_HOST}:${port}`;
  const socketId = `${SOCKET_ID}-${runId}-${port}`;
  return new Promise((resolve) => {
    let settled = false;
    let handle: SocketHandle | null = null;

    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(connected);
    };

    const timeout = setTimeout(() => {
      if (socketHandle === handle) {
        socketHandle = null;
      }
      closeHandle(handle);
      finish(false);
    }, CONNECT_TIMEOUT_MS);

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

async function connect(mode: ConnectMode = 'manual'): Promise<void> {
  const manual = mode === 'manual';

  if (connectionState === 'connected' && connectedPort !== null) {
    if (manual) {
      showToast(`MCP Bridge already connected to local server`);
    }
    return;
  }

  if (connectionState === 'connecting' && activeConnectPromise) {
    if (manual) {
      showToast(`MCP Bridge is already connecting to local server`);
    }
    return activeConnectPromise;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
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
      for (let offset = 0; offset < PORT_SCAN_COUNT; offset += 1) {
        if (runId !== connectRunId || manualDisconnectRequested) return;
        // Always show success toast so user knows auto-connect worked
        const connected = await connectToPort(BRIDGE_PORT + offset, runId, true);
        if (connected) return;
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

function disconnect(): void {
  void updateMenuTitle();
  const wasDisconnected = connectionState === 'disconnected' && !socketHandle;
  const wasConnecting = connectionState === 'connecting';

  manualDisconnectRequested = true;
  connectRunId += 1;
  activeConnectPromise = null;
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  closeSocket();

  if (wasDisconnected) {
    showToast('MCP Bridge already disconnected');
  } else if (wasConnecting) {
    showToast('MCP Bridge connection cancelled');
  } else {
    showToast('MCP Bridge disconnected. Auto reconnect is paused until Connect.');
  }
}

function showStatus(): void {
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
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (connectionState === 'disconnected') {
      void connect('auto');
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
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val !== null) return val !== 'false';
  } catch (e) {
    log('localStorage read failed', e);
  }
  return true;
}

function saveAutoConnectSetting(value: boolean): void {
  try {
    const storage = getStorage();
    if (storage && typeof storage.setExtensionUserConfig === 'function') {
      storage.setExtensionUserConfig('autoConnect', value);
    }
  } catch (e) {
    log('sys_Storage.setExtensionUserConfig unavailable', e);
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch (e) {
    log('localStorage write failed', e);
  }
}

async function updateMenuTitle(): Promise<void> {
  // EasyEDA Pro re-reads extension.json on every menu open; replaceHeaderMenus()
  // cannot persist between opens. State is communicated via toast only.
  log(`menu state: Auto-Connect=${autoConnectEnabled}`);
}

async function toggleAutoConnect(): Promise<void> {
  autoConnectEnabled = !autoConnectEnabled;
  saveAutoConnectSetting(autoConnectEnabled);
  await updateMenuTitle();
  if (autoConnectEnabled) {
    manualDisconnectRequested = false;
    reconnectAttempts = 0;
    if (connectionState === 'disconnected') {
      void connect('auto');
    }
  } else {
    manualDisconnectRequested = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }
  showToast(
    autoConnectEnabled
      ? 'Auto-Connect: ON — will reconnect automatically'
      : 'Auto-Connect: OFF — use Connect button to connect',
  );
}

async function handleActivate(): Promise<void> {
  autoConnectEnabled = loadAutoConnectSetting();
  if (autoConnectEnabled) {
    showToast(`MCP Bridge: Auto-Connect ON — scanning local server`);
    void connect('auto');
  } else {
    showToast('MCP Bridge: Auto-Connect OFF — click Connect to connect');
  }
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
    (api as any).toggleAutoConnect = toggleAutoConnect;
    api.activate = handleActivate;
    api.deactivate = disconnect;
  }

  const globalScope = globalThis as any;
  globalScope.connect = connect;
  globalScope.disconnect = disconnect;
  globalScope.showStatus = showStatus;
  globalScope.connectRemoteRelay = connectRemoteRelay;
  globalScope.disconnectRemoteRelay = disconnectRemoteRelay;
  globalScope.showRemoteRelayStatus = showRemoteRelayStatus;
  globalScope.toggleAutoConnect = toggleAutoConnect;
}

expose();
log('Extension script loaded');

// Auto-connect on load (handleActivate is not called by the framework
// when activationEvents is empty, so we trigger it explicitly).
handleActivate();

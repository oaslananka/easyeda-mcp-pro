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
const CONNECT_TIMEOUT_MS = 8000;
const EASYEDA_REGISTER_OPEN_FALLBACK_MS = 600;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STORAGE_KEY = 'easyeda-mcp-pro:autoConnect';
const HEARTBEAT_MS = 15000;
const SOCKET_ID = 'easyeda-mcp-pro-bridge';
const PORT_SCAN_LABEL = `${BRIDGE_PORT}-${BRIDGE_PORT + PORT_SCAN_COUNT - 1}`;
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
  console.warn(`[easyeda-mcp-pro] ${context}`, error);
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
    let ds = '';

    if (typeof c.getState_OtherProperty === 'function') {
      const other = c.getState_OtherProperty();
      if (other) {
        if (!fp && (other.Footprint || other.footprint))
          fp = String(other.Footprint || other.footprint);
        ds = String(other.Datasheet || other.datasheet || '');
      }
    }

    result.push({
      reference: ref,
      value: val,
      footprint: fp,
      lcsc: lcsc,
      manufacturer: mfr,
      datasheet: ds,
    });
  }
  return result;
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
  const netMap = new Map<string, Array<{ component: string; pin: string }>>();

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
          if (!netMap.has(netName)) {
            netMap.set(netName, []);
          }
          netMap.get(netName)!.push({ component: ref, pin: pinNum });
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
        if (netName && !netMap.has(netName)) {
          netMap.set(netName, []);
        }
      }
    } catch (e) {
      logRecoverableError('failed to inspect schematic nets', e);
    }
  }

  const result: any[] = [];
  for (const [netName, nodes] of netMap.entries()) {
    result.push({
      netName,
      nodes,
    });
  }
  return result;
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
      return callFirst(['dmt_Project.export', 'project.export'], params);
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
    case 'schematic.placeComponent':
      // SCH_PrimitiveComponent.create expects (deviceItem, x, y) only.
      // Extra arguments cause the API to hang or reject.
      return callFirst(
        ['SCH_PrimitiveComponent.create', 'sch_PrimitiveComponent.create'],
        params.deviceItem,
        params.x,
        params.y,
      );
    case 'schematic.addWire': {
      const pts = Array.isArray(params.points) ? params.points.flatMap((p: any) => [p.x, p.y]) : [];
      return callFirst(
        ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
        pts,
        params.netName,
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
    case 'schematic.modifyPrimitive':
      return callFirst(
        [
          'SCH_PrimitiveComponent.modify',
          'SCH_PrimitiveWire.modify',
          'sch_PrimitiveComponent.modify',
          'sch_PrimitiveWire.modify',
        ],
        params.primitiveId,
        params.property,
      );
    case 'schematic.createNetFlag': {
      const nfX = params.x as number;
      const nfY = params.y as number;
      const nfName = params.netName as string;
      const nfRotation = (params.rotation as number) ?? 0;
      const nfResult = await callFirst(
        [
          'SCH_PrimitiveNetLabel.create',
          'sch_PrimitiveNetLabel.create',
          'SCH_NetFlag.create',
          'sch_NetFlag.create',
        ],
        nfX,
        nfY,
        nfName,
        nfRotation,
      );
      const nfPrimitiveId =
        typeof nfResult === 'object' && nfResult !== null
          ? String(
              (nfResult as Record<string, unknown>).primitiveId ??
                (nfResult as Record<string, unknown>).uuid ??
                '',
            )
          : '';
      return {
        primitiveId: nfPrimitiveId || `netflag_${Date.now()}`,
        netName: nfName,
      };
    }
    case 'schematic.createNetPort': {
      const npX = params.x as number;
      const npY = params.y as number;
      const npName = params.netName as string;
      const npType = (params.portType as string) ?? 'passive';
      const npRotation = (params.rotation as number) ?? 0;
      const npResult = await callFirst(
        [
          'SCH_PrimitiveNetPort.create',
          'sch_PrimitiveNetPort.create',
          'SCH_NetPort.create',
          'sch_NetPort.create',
        ],
        npX,
        npY,
        npName,
        npType,
        npRotation,
      );
      const npPrimitiveId =
        typeof npResult === 'object' && npResult !== null
          ? String(
              (npResult as Record<string, unknown>).primitiveId ??
                (npResult as Record<string, unknown>).uuid ??
                '',
            )
          : '';
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
      return { connected: true };
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
      return { count: connectedCount };
    }
    case 'schematic.validateNetlist': {
      const netlistData = (await listNetsApi()) as Array<{
        netName: string;
        nodes: Array<{ component: string; pin: string }>;
      }>;
      const comps = (await listComponentsApi()) as Array<{
        reference: string;
        value: string;
        footprint: string;
        lcsc: string;
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
      // Floating pins: components that exist but aren't in any net's nodes
      const floatingPins: Array<{ primitiveId: string; pinNumber: string }> = [];
      const schCompClass = readFirstPath<any>([
        'SCH_PrimitiveComponent',
        'SCH_PrimitiveComponent3',
        'sch_PrimitiveComponent',
      ]);
      if (schCompClass && typeof schCompClass.getAll === 'function') {
        const allComps = await schCompClass.getAll(undefined, true);
        for (const c of allComps || []) {
          const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
          if (ref && typeof c.getAllPins === 'function') {
            try {
              const pins = await c.getAllPins();
              for (const p of pins || []) {
                if (typeof p.getState_PinNumber !== 'function') continue;
                let pinNet = '';
                if (typeof p.getState_OtherProperty === 'function') {
                  const other = p.getState_OtherProperty();
                  if (other) pinNet = String(other.net || other.Net || '');
                }
                if (!pinNet) {
                  floatingPins.push({
                    primitiveId: ref,
                    pinNumber: String(p.getState_PinNumber()),
                  });
                }
              }
            } catch {
              // skip component
            }
          }
        }
      }
      const warnings: string[] = [];
      const totalRefs = comps.length;
      if (floatingPins.length > 0) {
        warnings.push(`${floatingPins.length} pin(s) are not connected to any net.`);
      }
      if (connectedRefs.size < totalRefs) {
        warnings.push(`${totalRefs - connectedRefs.size} component(s) have no net connections.`);
      }
      return {
        nets,
        floatingPins,
        wiresWithoutNetlist: [],
        warnings,
      };
    }
    case 'system.apiInventory':
      return inspectApiInventory(typeof params.filter === 'string' ? params.filter : undefined);
    case 'system.inspectComponents':
      return inspectComponentsApi(typeof params.limit === 'number' ? params.limit : 5);
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
      return callFirst(['dmt_PCB.exportGerbers', 'board.exportGerbers'], params);
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
      return callFirst(['dmt_DRC.runRuleCheck', 'design.ruleCheck'], params);
    case 'design.erc':
      return callFirst(['dmt_ERC.run', 'design.erc'], params);
    case 'design.drc':
      return callFirst(['dmt_DRC.run', 'design.drc'], params);
    case 'export.pickPlace':
      return callFirst(
        ['dmt_Project.exportPickPlace', 'dmt_PCB.exportPickAndPlace', 'board.exportPickPlace'],
        params,
      );
    case 'export.pdf':
      return callFirst(
        ['dmt_Schematic.exportPdf', 'dmt_PCB.exportPdf', 'sch_Document.exportPdf'],
        params.what === 'board' ? params : { ...params, type: 'schematic' },
      );
    case 'export.netlist':
      return callFirst(['dmt_Project.exportNetlist', 'sch_Document.exportNetlist'], params);
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
        ['PCB_PrimitiveTrack.create', 'pcb_PrimitiveTrack.create'],
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
    extensionVersion: '0.6.3', // x-release-please-version
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
  const url = `ws://127.0.0.1:${port}`;
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
                showToast(`MCP Bridge connected: 127.0.0.1:${port}`);
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
      showToast(`MCP Bridge already connected: 127.0.0.1:${connectedPort}`);
    }
    return;
  }

  if (connectionState === 'connecting' && activeConnectPromise) {
    if (manual) {
      showToast(`MCP Bridge is already connecting: 127.0.0.1:${PORT_SCAN_LABEL}`);
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
    showToast(`MCP Bridge connecting: 127.0.0.1:${PORT_SCAN_LABEL}`);
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
        const message = `MCP Bridge offline: no server found on 127.0.0.1:${PORT_SCAN_LABEL}`;
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
    showToast(`MCP Bridge connected: 127.0.0.1:${connectedPort} | ${autoLabel}`);
    return;
  }

  if (connectionState === 'connecting') {
    showToast(`MCP Bridge connecting: 127.0.0.1:${PORT_SCAN_LABEL} | ${autoLabel}`);
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
    showToast(`MCP Bridge: Auto-Connect ON — scanning 127.0.0.1:${PORT_SCAN_LABEL}`);
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
    (api as any).toggleAutoConnect = toggleAutoConnect;
    api.activate = handleActivate;
    api.deactivate = disconnect;
  }

  const globalScope = globalThis as any;
  globalScope.connect = connect;
  globalScope.disconnect = disconnect;
  globalScope.showStatus = showStatus;
  globalScope.toggleAutoConnect = toggleAutoConnect;
}

expose();
log('Extension script loaded');

// Auto-connect on load (handleActivate is not called by the framework
// when activationEvents is empty, so we trigger it explicitly).
handleActivate();

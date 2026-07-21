// The hot-swappable dispatcher module: every EasyEDA Pro API interaction lives
// here, behind createDispatcher(toolkit). The loader (index.ts) bakes this
// module in as the fallback dispatcher; in dev mode the MCP server can push a
// freshly built dispatcher bundle over the bridge and swap it in without
// re-importing the .eext. All runtime globals are resolved through the
// injected DispatcherToolkit (see toolkit.ts) so the identical code works both
// baked into the extension script scope and eval'd via AsyncFunction.

import { normalizeBinaryResult, type BinaryResultPayload } from './binary-result.js';
import type { Dispatcher, DispatcherToolkit } from './toolkit.js';
import {
  isRecord,
  log,
  logRecoverableError,
  readPath,
  readPathParent,
  type JsonValue,
} from './utils.js';

// Injected at build time via esbuild --define; identifies this bundle build.
declare const __MCP_DISPATCHER_BUILD_ID__: string | undefined;

const BUILD_ID =
  typeof __MCP_DISPATCHER_BUILD_ID__ !== 'undefined' && __MCP_DISPATCHER_BUILD_ID__
    ? __MCP_DISPATCHER_BUILD_ID__
    : 'baked-dev';

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

/** Every bridge method handled by dispatch() below. Keep in lockstep with the
 *  switch cases AND the server's EasyedaApiMethodSchema (src/bridge/types.ts). */
const METHOD_LIST: readonly string[] = [
  'api.call',
  'api.execute',
  'board.exportGerbers',
  'board.getDimensions',
  'board.getFeatures',
  'board.getStackup',
  'board.listLayers',
  'bom.generate',
  'bom.validate',
  'canvas.capture',
  'canvas.captureRegion',
  'canvas.locate',
  'design.drc',
  'design.erc',
  'design.ruleCheck',
  'export.netlist',
  'export.pdf',
  'export.pickPlace',
  'inventory.getPrice',
  'inventory.search',
  'library.getDeviceByLcscId',
  'pcb.addSilkscreenLine',
  'pcb.addText',
  'pcb.addTrack',
  'pcb.addVia',
  'pcb.addZone',
  'pcb.deleteComponent',
  'pcb.exportRouteContext',
  'pcb.listComponents',
  'pcb.listTracks',
  'pcb.listVias',
  'pcb.modifyComponent',
  'project.export',
  'project.open',
  'project.save',
  'schematic.addCircle',
  'schematic.addPolygon',
  'schematic.addRectangle',
  'schematic.addText',
  'schematic.addWire',
  'schematic.connectPinToNet',
  'schematic.connectPinsByNet',
  'schematic.createNetFlag',
  'schematic.createNetPort',
  'schematic.deletePrimitive',
  'schematic.getNetDetail',
  'schematic.getPinNoConnect',
  'schematic.getPrimitiveSnapshot',
  'schematic.getSheetInfo',
  'schematic.listComponents',
  'schematic.listNets',
  'schematic.listPrimitiveIds',
  'schematic.listRectangles',
  'schematic.modifyPrimitive',
  'schematic.placeComponent',
  'schematic.primitiveBounds',
  'schematic.recreatePrimitiveSnapshot',
  'schematic.restorePrimitiveSnapshot',
  'schematic.searchDevice',
  'schematic.setPinNoConnect',
  'schematic.setTitleBlock',
  'schematic.syncToPcb',
  'schematic.validateNetlist',
  'system.apiInventory',
  'system.getStatus',
  'system.inspectComponents',
  'system.inspectWires',
];

// The toolkit for the active dispatcher instance. Set by createDispatcher();
// a hot-swapped bundle is a fresh module scope, so instances never share it.
let tk: DispatcherToolkit;

function newBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  const error = new Error(message);
  Object.assign(error, { code, suggestion, data });
  return error;
}

function getApiCandidates(): Array<{ name: string; root: unknown }> {
  const candidates: Array<{ name: string; root: unknown }> = [];
  const edaObj = tk.getEda();
  if (edaObj) candidates.push({ name: 'eda', root: edaObj });
  const EDAObj = tk.getEDA();
  if (EDAObj) candidates.push({ name: 'EDA', root: EDAObj });
  const apiObj = tk.getApi();
  if (apiObj) candidates.push({ name: 'api', root: apiObj });
  candidates.push({ name: 'globalThis', root: globalThis });
  return candidates;
}

async function callFirst(paths: string[], ...args: unknown[]): Promise<unknown> {
  const allPaths = withClassNameVariants(paths);

  for (const candidate of getApiCandidates()) {
    for (const path of allPaths) {
      const fn = readPath<unknown>(candidate.root, path);
      if (typeof fn === 'function') {
        return await fn.apply(readPathParent(candidate.root, path), args);
      }
    }
  }

  throw newBridgeError(
    'METHOD_NOT_FOUND',
    `No EasyEDA API implementation found for ${paths.join(' or ')}`,
    'Verify the bridge extension supports the installed EasyEDA Pro version.',
  );
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
function callStateGetter(obj: object, record: Record<string, unknown>, key: string): unknown {
  const getter = record[`getState_${key}`];
  if (typeof getter !== 'function') return undefined;
  try {
    return (getter as () => unknown).call(obj);
  } catch {
    return undefined;
  }
}

function readStateObject(
  obj: object,
  record: Record<string, unknown>,
  key: string,
  lowerCamelKey: string,
): unknown {
  if (typeof record.getState !== 'function') return undefined;
  try {
    const state = (record.getState as () => unknown).call(obj);
    if (!isRecord(state)) return undefined;
    if (key in state) return state[key];
    if (lowerCamelKey in state) return state[lowerCamelKey];
  } catch {
    return undefined;
  }
  return undefined;
}

function safeGetState(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  const lowerCamelKey = key.length > 0 ? key.charAt(0).toLowerCase() + key.slice(1) : key;
  const getterValue = callStateGetter(obj, obj, key);
  if (getterValue !== undefined) return getterValue;
  const stateValue = readStateObject(obj, obj, key, lowerCamelKey);
  if (stateValue !== undefined) return stateValue;
  if (key in obj) return obj[key];
  return obj[lowerCamelKey];
}

type PublicTextAlignMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

interface TextPrimitiveRead {
  publicCurrent?: unknown;
  persistentCurrent?: unknown;
  className: string;
}

const textAlignModeCache = new Map<string, PublicTextAlignMode>();

function asPublicTextAlignMode(value: unknown): PublicTextAlignMode | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
    ? (value as PublicTextAlignMode)
    : undefined;
}

function requirePublicTextAlignMode(value: unknown, field = 'alignMode'): PublicTextAlignMode {
  const alignMode = asPublicTextAlignMode(value);
  if (alignMode === undefined) {
    throw newBridgeError(
      'INVALID_PARAMS',
      `${field} must be an integer from 1 through 9`,
      'Use the documented ESCH_PrimitiveTextAlignMode values: LEFT_TOP=1 through RIGHT_BOTTOM=9.',
    );
  }
  return alignMode;
}

function readTextState(text: TextPrimitiveRead, key: string): unknown {
  const publicValue = safeGetState(text.publicCurrent, key);
  if (publicValue !== undefined) return publicValue;
  return safeGetState(text.persistentCurrent, key);
}

function resolvePublicTextAlignMode(
  text: TextPrimitiveRead,
  primitiveId: string,
): PublicTextAlignMode | undefined {
  const publicAlignMode = asPublicTextAlignMode(safeGetState(text.publicCurrent, 'AlignMode'));
  if (publicAlignMode !== undefined) {
    textAlignModeCache.set(primitiveId, publicAlignMode);
    return publicAlignMode;
  }

  // getAll() can expose EasyEDA's internal encoded state (for example 6, 11,
  // 20) rather than ESCH_PrimitiveTextAlignMode. Never pass that value back to
  // the public modify() API. A short-lived dispatcher cache preserves the last
  // public value observed through get()/create()/modify() during a transaction.
  return textAlignModeCache.get(primitiveId);
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

function isBetween(value: number, a: number, b: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b);
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

function pointOnAxisAlignedSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  if (a.x === b.x) return point.x === a.x && isBetween(point.y, a.y, b.y);
  if (a.y === b.y) return point.y === a.y && isBetween(point.x, a.x, b.x);
  return samePoint(point, a) || samePoint(point, b);
}

function pointOnPolyline(
  point: { x: number; y: number },
  points: Array<{ x: number; y: number }>,
): boolean {
  if (points.length === 1) return samePoint(point, points[0]);
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (pointOnAxisAlignedSegment(point, points[i], points[i + 1])) return true;
  }
  return false;
}

function axisAlignedSegmentIntersection(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): { x: number; y: number } | null {
  const aVertical = a1.x === a2.x;
  const aHorizontal = a1.y === a2.y;
  const bVertical = b1.x === b2.x;
  const bHorizontal = b1.y === b2.y;

  if (aVertical && bVertical && a1.x === b1.x) {
    const y = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
    if (isBetween(y, a1.y, a2.y) && isBetween(y, b1.y, b2.y)) return { x: a1.x, y };
  }
  if (aHorizontal && bHorizontal && a1.y === b1.y) {
    const x = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x));
    if (isBetween(x, a1.x, a2.x) && isBetween(x, b1.x, b2.x)) return { x, y: a1.y };
  }
  if (aVertical && bHorizontal && isBetween(a1.x, b1.x, b2.x) && isBetween(b1.y, a1.y, a2.y)) {
    return { x: a1.x, y: b1.y };
  }
  if (aHorizontal && bVertical && isBetween(b1.x, a1.x, a2.x) && isBetween(a1.y, b1.y, b2.y)) {
    return { x: b1.x, y: a1.y };
  }

  return null;
}

function polylineIntersection(
  a: Array<{ x: number; y: number }>,
  b: Array<{ x: number; y: number }>,
): { x: number; y: number } | null {
  for (let i = 0; i + 1 < a.length; i += 1) {
    for (let j = 0; j + 1 < b.length; j += 1) {
      const intersection = axisAlignedSegmentIntersection(a[i], a[i + 1], b[j], b[j + 1]);
      if (intersection) return intersection;
    }
  }
  return null;
}

function parsePointKey(key: string): { x: number; y: number } | null {
  const [xRaw, yRaw] = key.split(',');
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Checks whether any of `points` exactly coincides with a coordinate already
 * used by an existing wire on a *different* net. EasyEDA Pro auto-merges
 * wires that share a coordinate (not just endpoints), which silently unions
 * their connectivity — a real hazard when routing two unrelated nets through
 * overlapping "highway" columns/rows. Returns the first collision found, or
 * null if the runtime doesn't expose wire introspection or none is found.
 */
/** Pin coordinates from listNetsApi()'s coordinate-fallback nodes, which carry
 *  x/y for pins connected via a wire touching their coordinate (the primary
 *  mechanism since connect_pin_to_net started drawing real wire stubs). */
async function collectPinCoordinateNets(): Promise<Map<string, string>> {
  const coordToNet = new Map<string, string>();
  try {
    const netlistData = (await listNetsApi()) as SchematicNetEntry[];
    for (const net of netlistData) {
      for (const node of net.nodes) {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          coordToNet.set(pointKey({ x: node.x, y: node.y }), net.netName);
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes('SCH_PrimitiveComponent class not found')) {
      logRecoverableError('failed to build pin coordinate map for net-collision check', e);
    }
  }
  return coordToNet;
}

/** Net flag/port coordinates read directly from components — these aren't in
 *  listNetsApi()'s per-component node list (they have no designator) but do
 *  carry both a coordinate and a net name via readComponentType/readComponentNet. */
async function collectFlagPortCoordinateNets(): Promise<Map<string, string>> {
  const coordToNet = new Map<string, string>();
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (!schCompClass || typeof schCompClass.getAll !== 'function') return coordToNet;
  try {
    const allComps = (await schCompClass.getAll(undefined, true)) || [];
    for (const c of allComps) {
      const type = readComponentType(c);
      if (type !== 'netflag' && type !== 'netport') continue;
      const netName = readComponentNet(c);
      const point = readPrimitivePoint(c);
      if (netName && point) coordToNet.set(pointKey(point), netName);
    }
  } catch (e) {
    logRecoverableError('failed to read net flags/ports for net-collision check', e);
  }
  return coordToNet;
}

/**
 * Coordinate -> netName for every pin/flag/port this bridge can positively
 * attribute to a specific net, used to extend the wire-drawing collision
 * guard beyond wire-vs-wire (see findForeignNetCollision).
 * Pins connected only via the legacy stamped OtherProperty.net (no x/y) are
 * NOT included — there is no coordinate to collide with.
 */
async function buildForeignConnectivityMap(): Promise<Map<string, string>> {
  const [pinCoords, flagCoords] = await Promise.all([
    collectPinCoordinateNets(),
    collectFlagPortCoordinateNets(),
  ]);
  return new Map([...pinCoords, ...flagCoords]);
}

async function shouldSuppressDuplicateWireNetName(
  points: Array<{ x: number; y: number }>,
  netName: string | undefined,
): Promise<boolean> {
  if (!netName || points.length === 0) return false;

  const pointKeys = new Set(points.map(pointKey));
  const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
  if (schWireClass && typeof schWireClass.getAll === 'function') {
    try {
      const wires = ((await schWireClass.getAll()) || []) as unknown[];
      for (const wire of wires) {
        const wireNet = String(safeGetState(wire, 'Net') ?? '');
        if (wireNet !== netName) continue;
        for (const point of normalizeWireLine(safeGetState(wire, 'Line'))) {
          if (pointKeys.has(pointKey(point))) return true;
        }
      }
    } catch (e) {
      logRecoverableError('failed to read existing wires for duplicate-net-label suppression', e);
    }
  }

  const connectivityMap = await buildForeignConnectivityMap();
  for (const point of points) {
    if (connectivityMap.get(pointKey(point)) === netName) return true;
  }

  return false;
}

async function findForeignNetCollision(
  points: Array<{ x: number; y: number }>,
  netName: string,
): Promise<{ x: number; y: number; foreignNet: string; kind: 'wire' | 'pin_or_flag' } | null> {
  if (!netName || points.length === 0) return null;
  const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
  if (schWireClass && typeof schWireClass.getAll === 'function') {
    let wires: unknown[] = [];
    try {
      wires = (await schWireClass.getAll()) || [];
    } catch (e) {
      logRecoverableError('failed to read existing wires for net-collision check', e);
      wires = [];
    }

    for (const wire of wires) {
      const wireNet = String(safeGetState(wire, 'Net') ?? '');
      if (!wireNet || wireNet === netName) continue;
      const wirePts = normalizeWireLine(safeGetState(wire, 'Line'));
      const intersection = polylineIntersection(points, wirePts);
      if (intersection) {
        return { x: intersection.x, y: intersection.y, foreignNet: wireNet, kind: 'wire' };
      }
    }
  }

  // Wire-vs-wire found nothing; also check pin/net-flag/net-port coordinates
  // directly, since EasyEDA merges by coordinate regardless of primitive
  // type — a wire landing exactly on a foreign pin or flag shorts it just
  // like landing on a foreign wire does, and the check above never saw it
  // (the foreign pin has no wire of its own at that point).
  const foreignMap = await buildForeignConnectivityMap();
  for (const [key, foreignNet] of foreignMap) {
    const p = parsePointKey(key);
    if (!p) continue;
    if (foreignNet && foreignNet !== netName) {
      if (pointOnPolyline(p, points)) {
        return { x: p.x, y: p.y, foreignNet, kind: 'pin_or_flag' };
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
 * exceed the server's advertised BRIDGE_MAX_PAYLOAD_SIZE (via the toolkit)
 * before it is ever handed to send(). Sending an oversized WS frame closes
 * the whole connection (code 4009) rather than just failing this one call,
 * so we throw a normal, small, structured error instead — handleRequest()
 * turns it into an ok:false response.
 */
async function normalizeBinaryResultSafely(
  value: unknown,
  fallbackFileName: string,
): Promise<unknown> {
  const normalized = await normalizeBinaryResult(value, fallbackFileName);
  if (isBinaryResultPayload(normalized)) {
    const maxPayloadSize = tk.getBridgeMaxPayloadSize();
    const budget = Math.floor(maxPayloadSize * PAYLOAD_SAFETY_MARGIN);
    if (normalized.byteLength > budget) {
      throw newBridgeError(
        'PAYLOAD_TOO_LARGE',
        `"${normalized.fileName}" is ${normalized.byteLength} bytes, which exceeds the safe transport budget (${budget} bytes, derived from the server's BRIDGE_MAX_PAYLOAD_SIZE=${maxPayloadSize}).`,
        'Increase BRIDGE_MAX_PAYLOAD_SIZE in the MCP server environment, or (for canvas captures) zoom to a smaller region.',
      );
    }
  }
  return normalized;
}

interface CanvasRegion {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function normalizeCanvasRegion(value: CanvasRegion): CanvasRegion {
  const coordinates = [value.left, value.right, value.top, value.bottom];
  if (!coordinates.every(Number.isFinite)) {
    throw newBridgeError(
      'INVALID_PARAMS',
      'Capture region coordinates must be finite numbers.',
      'Provide finite left, right, top, and bottom document coordinates.',
    );
  }

  const region = {
    left: Math.min(value.left, value.right),
    right: Math.max(value.left, value.right),
    top: Math.max(value.top, value.bottom),
    bottom: Math.min(value.top, value.bottom),
  };
  if (region.left === region.right || region.top === region.bottom) {
    throw newBridgeError(
      'INVALID_PARAMS',
      'Capture region must have non-zero width and height.',
      'Expand the bounds around the component before capturing it.',
    );
  }
  return region;
}

async function waitForCanvasPaint(): Promise<void> {
  const requestFrame = (globalThis as { requestAnimationFrame?: (callback: () => void) => number })
    .requestAnimationFrame;
  if (typeof requestFrame === 'function') {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      // A minimized/background Electron window can suspend animation frames.
      // Keep capture bounded instead of waiting indefinitely for repaint.
      const timeout = setTimeout(finish, 75);
      requestFrame.call(globalThis, () => requestFrame.call(globalThis, finish));
    });
    return;
  }

  // Vitest/Node and older extension shells may not expose requestAnimationFrame.
  // A macrotask still lets an asynchronously scheduled canvas update settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, depth - 1, seen));
    }

    const output: Record<string, JsonValue | undefined> = {};
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== 'Object') output.__class = ctorName;

    const getterNames = getFunctionNames(value).filter((name) => name.startsWith('getState_'));
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

    const methodNames = getFunctionNames(value);
    if (methodNames.length > 0) output.__methods = methodNames;

    for (const key of Object.keys(value)) {
      output[key] = normalizeValue((value as Record<string, unknown>)[key], depth - 1, seen);
    }

    return output;
  } finally {
    // Track only the active recursion path. Repeated references are valid data;
    // only a reference back into the current path is a true cycle.
    seen.delete(value);
  }
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

type NetDetailStage =
  | 'component_enumeration'
  | 'component_pin_read'
  | 'net_catalog_read'
  | 'wire_read'
  | 'coordinate_pin_read';

type NetDetailBudget = {
  netName: string;
  startedAt: number;
  deadlineAt: number;
  operationTimeoutMs: number;
};

const NET_DETAIL_DEFAULT_TIMEOUT_MS = 15_000;
const NET_DETAIL_MAX_TIMEOUT_MS = 20_000;
const NET_DETAIL_STAGE_TIMEOUT_MS = 5_000;

function createNetDetailBudget(netName: string, requestedTimeoutMs: unknown): NetDetailBudget {
  const numericTimeout =
    typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
      ? Math.trunc(requestedTimeoutMs)
      : NET_DETAIL_DEFAULT_TIMEOUT_MS;
  const operationTimeoutMs = Math.max(1, Math.min(NET_DETAIL_MAX_TIMEOUT_MS, numericTimeout));
  const startedAt = Date.now();
  return {
    netName,
    startedAt,
    deadlineAt: startedAt + operationTimeoutMs,
    operationTimeoutMs,
  };
}

function isNetDetailTimeout(error: unknown): boolean {
  return isRecord(error) && error.code === 'NET_DETAIL_TIMEOUT';
}

async function awaitNetDetailStage<T>(
  budget: NetDetailBudget | undefined,
  stage: NetDetailStage,
  operation: () => PromiseLike<T> | T,
  context: Record<string, unknown> = {},
): Promise<T> {
  if (!budget) return await operation();

  const remainingMs = budget.deadlineAt - Date.now();
  const stageTimeoutMs = Math.min(NET_DETAIL_STAGE_TIMEOUT_MS, remainingMs);
  if (stageTimeoutMs <= 0) {
    throw newBridgeError(
      'NET_DETAIL_TIMEOUT',
      `Net detail scan timed out before ${stage} while resolving "${budget.netName}".`,
      'Retry with the affected schematic focused; inspect the timeout stage and component in error data.',
      {
        stage,
        netName: budget.netName,
        elapsedMs: Date.now() - budget.startedAt,
        operationTimeoutMs: budget.operationTimeoutMs,
        ...context,
      },
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            newBridgeError(
              'NET_DETAIL_TIMEOUT',
              `Net detail scan timed out during ${stage} while resolving "${budget.netName}".`,
              'Retry with the affected schematic focused; inspect the timeout stage and component in error data.',
              {
                stage,
                netName: budget.netName,
                elapsedMs: Date.now() - budget.startedAt,
                operationTimeoutMs: budget.operationTimeoutMs,
                stageTimeoutMs,
                ...context,
              },
            ),
          );
        }, stageTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

function addUnnamedWireNetLabels(
  netMap: Map<string, SchematicNetNode[]>,
  dsu: DisjointSet,
  rootNetNames: Map<string, Set<string>>,
): void {
  const canonicalPointByRoot = new Map<string, string>();
  for (const point of dsu.parent.keys()) {
    const root = dsu.find(point);
    const canonicalPoint = canonicalPointByRoot.get(root);
    if (!canonicalPoint || point.localeCompare(canonicalPoint) < 0) {
      canonicalPointByRoot.set(root, point);
    }
  }

  const unnamedRoots = Array.from(canonicalPointByRoot.entries())
    .filter(([root]) => !rootNetNames.get(root)?.size)
    .sort((a, b) => a[1].localeCompare(b[1]));
  let nextAnonymousNet = 1;

  for (const [root] of unnamedRoots) {
    let netName = `N$${nextAnonymousNet}`;
    while (netMap.has(netName)) {
      nextAnonymousNet += 1;
      netName = `N$${nextAnonymousNet}`;
    }
    nextAnonymousNet += 1;
    rootNetNames.set(root, new Set([netName]));
    ensureNetEntry(netMap, netName);
  }
}

async function addCoordinateFallbackNets(
  netMap: Map<string, SchematicNetNode[]>,
  comps: unknown[],
  budget?: NetDetailBudget,
): Promise<void> {
  const schWireClass = readFirstPath<any>([
    'SCH_PrimitiveWire',
    'SCH_PrimitiveWire3',
    'sch_PrimitiveWire',
  ]);
  if (!schWireClass || typeof schWireClass.getAll !== 'function') return;

  const wires = await awaitNetDetailStage(budget, 'wire_read', () => schWireClass.getAll());
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
    const componentType = readComponentType(component);
    if (componentType !== 'netflag' && componentType !== 'netport') continue;
    const netName = readComponentNet(component);
    const point = readPrimitivePoint(component);
    if (!netName || !point) continue;
    addNetLabel(point, netName);
  }

  // EasyEDA leaves Wire.Net empty for ordinary point-to-point connections.
  // Give each unlabeled connected wire component a stable local name so its
  // endpoint pins still appear together in schematic.listNets readback.
  addUnnamedWireNetLabels(netMap, dsu, rootNetNames);

  for (const component of comps) {
    const ref = readStringMemberOrState(component, 'designator', 'Designator');
    if (!ref || typeof (component as { getAllPins?: unknown }).getAllPins !== 'function') continue;

    try {
      const pins = await awaitNetDetailStage(
        budget,
        'coordinate_pin_read',
        () => (component as { getAllPins: () => Promise<unknown[]> }).getAllPins(),
        { component: ref },
      );
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
      if (isNetDetailTimeout(error)) throw error;
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
      const methods = getFunctionNames(value).sort((a, b) => a.localeCompare(b));
      const existing = classMap.get(className) ?? {
        className,
        runtimePaths: [],
        methods: [],
      };
      existing.runtimePaths.push(`${candidate.name}.${key}`);
      existing.methods = Array.from(new Set([...existing.methods, ...methods])).sort((a, b) =>
        a.localeCompare(b),
      );
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

function readOtherPropertyValue(
  otherProperty: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!otherProperty) return undefined;
  const exact = otherProperty[key];
  if (exact !== undefined && exact !== null && String(exact).trim()) return String(exact);
  const normalizedKey = key.trim().toLowerCase();
  for (const [candidateKey, candidateValue] of Object.entries(otherProperty)) {
    if (
      candidateKey.trim().toLowerCase() === normalizedKey &&
      candidateValue !== undefined &&
      candidateValue !== null &&
      String(candidateValue).trim()
    ) {
      return String(candidateValue);
    }
  }
  return undefined;
}

/** Resolve EasyEDA display expressions such as `={Value}` to their actual
 * component metadata. Library-created parts commonly store the expression in
 * Name while the concrete value lives in OtherProperty or ManufacturerId. */
function resolveComponentDisplayValue(
  rawName: unknown,
  otherProperty: Record<string, unknown> | undefined,
  manufacturerId: string,
  deviceName: string,
): string {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const expression = /^=\{(.+)\}$/.exec(name);
  if (expression) {
    const propertyName = expression[1].trim();
    const propertyValue = readOtherPropertyValue(otherProperty, propertyName);
    if (propertyValue) return propertyValue;
    if (propertyName.toLowerCase() === 'manufacturer part' && manufacturerId) {
      return manufacturerId;
    }
    return manufacturerId || deviceName || name;
  }
  if (name) return name;
  return readOtherPropertyValue(otherProperty, 'Value') || manufacturerId || deviceName || '';
}

function isSchematicBomComponent(component: unknown): boolean {
  const componentType = readComponentType(component);
  if (componentType === 'sheet' || componentType === 'netflag' || componentType === 'netport') {
    return false;
  }
  const device = safeGetState(component, 'Component');
  const deviceName = isRecord(device) ? String(device.name ?? '') : '';
  return !deviceName.startsWith('Drawing-Symbol_');
}

async function listComponentsApi(limit?: number, offset = 0): Promise<unknown> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  const libFpClass = readFirstPath<any>(['LIB_Footprint', 'lib_Footprint']);

  if (!schCompClass) {
    throw new Error('SCH_PrimitiveComponent class not found in EasyEDA Pro API');
  }

  const allComps = (await schCompClass.getAll(undefined, true)) || [];
  const bomComps = allComps.filter((component: unknown) => isSchematicBomComponent(component));
  const total = bomComps.length;
  const start = Math.max(0, offset);
  const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
  const comps = bomComps.slice(start, end);
  const result: any[] = [];

  for (const c of comps || []) {
    const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
    const lcsc = typeof c.getState_SupplierId === 'function' ? c.getState_SupplierId() : '';
    const mfr = typeof c.getState_Manufacturer === 'function' ? c.getState_Manufacturer() : '';
    const mfrId =
      typeof c.getState_ManufacturerId === 'function' ? c.getState_ManufacturerId() : '';
    const comp = typeof c.getState_Component === 'function' ? c.getState_Component() : undefined;
    const sym = typeof c.getState_Symbol === 'function' ? c.getState_Symbol() : undefined;
    const other =
      typeof c.getState_OtherProperty === 'function' && isRecord(c.getState_OtherProperty())
        ? (c.getState_OtherProperty() as Record<string, unknown>)
        : undefined;
    const rawName = typeof c.getState_Name === 'function' ? c.getState_Name() : '';
    const val = resolveComponentDisplayValue(rawName, other, String(mfrId || ''), comp?.name ?? '');

    let fp = '';
    if (typeof c.getState_Footprint === 'function') {
      const fpInfo = c.getState_Footprint();
      if (isRecord(fpInfo)) {
        // The live runtime already exposes the resolved footprint name here;
        // prefer it and avoid a redundant library lookup that may fail offline.
        if (typeof fpInfo.name === 'string' && fpInfo.name.trim()) fp = fpInfo.name;
        if (!fp && fpInfo.uuid && libFpClass) {
          try {
            const fpObj = await libFpClass.get(fpInfo.uuid, fpInfo.libraryUuid);
            if (fpObj) fp = fpObj.name || '';
          } catch (e) {
            logRecoverableError('failed to resolve component footprint', e);
          }
        }
      }
    }

    if (!fp) {
      fp =
        readOtherPropertyValue(other, 'Footprint') ||
        readOtherPropertyValue(other, 'Supplier Footprint') ||
        '';
    }
    const ds =
      readOtherPropertyValue(other, 'Datasheet') ||
      readOtherPropertyValue(other, 'datasheet') ||
      '';

    // Device identity — needed to re-place / clone a part. `Component` holds the
    // device uuid+libraryUuid (a valid place_component deviceItem within THIS
    // project; for a clean project, re-resolve via lcsc/manufacturerId/name).
    // `Symbol` names the schematic symbol used.
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
  return { total, items: result };
}

interface RawPrimitiveBBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Real rendered (sheet-space) bounding box per primitive, via the runtime's own
 * SCH_Primitive.getPrimitivesBBox -- already rotation/mirror-aware since it reads
 * the live rendered geometry rather than recomputing it from origin+rotation.
 */
async function primitiveBoundsApi(primitiveIds: unknown): Promise<unknown> {
  const schPrimitiveClass = readFirstPath<any>(['SCH_Primitive', 'sch_Primitive']);
  if (!schPrimitiveClass) {
    throw new Error('SCH_Primitive class not found in EasyEDA Pro API');
  }
  const ids = Array.isArray(primitiveIds)
    ? primitiveIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  const items: Array<{ primitiveId: string; bounds: RawPrimitiveBBox | null }> = [];
  for (const id of ids) {
    let bounds: RawPrimitiveBBox | null = null;
    try {
      bounds = (await schPrimitiveClass.getPrimitivesBBox([id])) ?? null;
    } catch (err) {
      logRecoverableError(`failed to read bounding box for primitive ${id}`, err);
    }
    items.push({ primitiveId: id, bounds });
  }

  let combined: RawPrimitiveBBox | null = null;
  if (ids.length > 0) {
    try {
      combined = (await schPrimitiveClass.getPrimitivesBBox(ids)) ?? null;
    } catch (err) {
      logRecoverableError('failed to read combined bounding box', err);
    }
  }

  return { items, combined };
}

type SheetInfoSource = 'current_page' | 'focused_document' | 'current_schematic_page_list';

type SheetInfoAttempt = {
  stage: string;
  status: 'value' | 'empty' | 'unavailable';
  error?: string;
};

function asNonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  return value;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

async function trySheetInfoCall(
  stage: string,
  paths: string[],
  attempts: SheetInfoAttempt[],
  ...args: unknown[]
): Promise<unknown> {
  try {
    const value = normalizeValue(await callFirst(paths, ...args), 5);
    const meaningful = Array.isArray(value)
      ? value.length > 0
      : Boolean(asNonEmptyRecord(value)) || (value !== null && value !== undefined);
    attempts.push({ stage, status: meaningful ? 'value' : 'empty' });
    return value;
  } catch (error) {
    attempts.push({
      stage,
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function getSchematicSheetInfoApi(): Promise<unknown> {
  const attempts: SheetInfoAttempt[] = [];
  let source: SheetInfoSource | undefined;

  let currentPage = asNonEmptyRecord(
    await trySheetInfoCall('current_page', ['DMT_Schematic.getCurrentSchematicPageInfo'], attempts),
  );
  if (currentPage) source = 'current_page';

  let pages = asRecordArray(
    await trySheetInfoCall(
      'current_page_list',
      ['DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo'],
      attempts,
    ),
  );
  if (pages.length === 0) {
    pages = asRecordArray(
      await trySheetInfoCall('all_page_list', ['DMT_Schematic.getAllSchematicPagesInfo'], attempts),
    );
  }

  const focusedDocument = asNonEmptyRecord(
    await trySheetInfoCall(
      'focused_document',
      ['DMT_SelectControl.getCurrentDocumentInfo'],
      attempts,
    ),
  );
  const focusedPageUuid =
    typeof focusedDocument?.uuid === 'string' && focusedDocument.uuid.trim()
      ? focusedDocument.uuid
      : undefined;

  let currentSchematic: Record<string, unknown> | undefined;
  if (!currentPage || pages.length === 0) {
    currentSchematic = asNonEmptyRecord(
      await trySheetInfoCall(
        'current_schematic',
        ['DMT_Schematic.getCurrentSchematicInfo'],
        attempts,
      ),
    );
  }

  if (!currentPage && focusedPageUuid) {
    currentPage = asNonEmptyRecord(
      await trySheetInfoCall(
        'focused_document_page',
        ['DMT_Schematic.getSchematicPageInfo'],
        attempts,
        focusedPageUuid,
      ),
    );
    if (currentPage) source = 'focused_document';
  }

  const schematicPages = asRecordArray(currentSchematic?.page);
  if (pages.length === 0 && schematicPages.length > 0) pages = schematicPages;

  if (!currentPage && focusedPageUuid && pages.length > 0) {
    currentPage = pages.find((page) => page.uuid === focusedPageUuid);
    if (currentPage) source = 'focused_document';
  }

  if (!currentPage && pages.length === 1 && currentSchematic) {
    currentPage = pages[0];
    source = 'current_schematic_page_list';
  }

  const diagnostics = {
    stage: 'focused_sheet_resolution',
    currentPageAvailable: Boolean(currentPage),
    pageListAvailable: pages.length > 0,
    focusedDocumentAvailable: Boolean(focusedDocument),
    attempts,
  };

  if (!currentPage) {
    throw newBridgeError(
      'SHEET_INFO_UNAVAILABLE',
      'EasyEDA did not expose metadata for the focused schematic page.',
      'Focus the schematic editor tab and retry. The diagnostics identify which runtime paths were empty or unavailable.',
      diagnostics,
    );
  }

  return {
    currentPage,
    pages,
    source,
    focusedDocument,
    diagnostics,
  };
}

async function listNetsApi(budget?: NetDetailBudget): Promise<unknown> {
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  const schNetClass = readFirstPath<any>(['SCH_Net', 'sch_Net']);

  if (!schCompClass) {
    throw new Error('SCH_PrimitiveComponent class not found in EasyEDA Pro API');
  }

  const comps = await awaitNetDetailStage(budget, 'component_enumeration', () =>
    schCompClass.getAll(undefined, true),
  );
  const netMap = new Map<string, SchematicNetNode[]>();

  for (const c of comps || []) {
    const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
    if (!ref || typeof c.getAllPins !== 'function') continue;

    try {
      const pins = await awaitNetDetailStage(budget, 'component_pin_read', () => c.getAllPins(), {
        component: ref,
      });
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
      if (isNetDetailTimeout(e)) throw e;
      logRecoverableError('failed to inspect schematic component pins', e);
    }
  }

  if (schNetClass && typeof schNetClass.getAllNets === 'function') {
    try {
      const allNets = await awaitNetDetailStage(budget, 'net_catalog_read', () =>
        schNetClass.getAllNets(),
      );
      for (const n of allNets || []) {
        const netName = n.netName || n.net;
        if (netName) ensureNetEntry(netMap, String(netName));
      }
    } catch (e) {
      if (isNetDetailTimeout(e)) throw e;
      logRecoverableError('failed to inspect schematic nets', e);
    }
  }

  try {
    await addCoordinateFallbackNets(netMap, comps || [], budget);
  } catch (error) {
    if (isNetDetailTimeout(error)) throw error;
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
async function applyPlacedRotation(
  created: unknown,
  rotation: unknown,
): Promise<number | undefined> {
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

type SchematicPrimitiveSnapshotKind =
  'component' | 'netflag' | 'netport' | 'wire' | 'text' | 'rectangle' | 'circle' | 'polygon';

interface SchematicPrimitiveSnapshot {
  schemaVersion: 'schematic-primitive-snapshot/v1';
  primitiveId: string;
  primitiveKind: SchematicPrimitiveSnapshotKind;
  componentType?: string;
  property: Record<string, unknown>;
}

function compactDefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

async function readPrimitiveFromClass(
  paths: string[],
  primitiveId: string,
): Promise<{ current: unknown; className: string } | null> {
  for (const path of paths) {
    const primitiveClass = readFirstPath<any>([path]);
    if (!primitiveClass || typeof primitiveClass.get !== 'function') continue;
    try {
      const current = await primitiveClass.get(primitiveId);
      if (current) return { current, className: path };
    } catch (error) {
      logRecoverableError(`${path}.get(${primitiveId}) failed while creating snapshot`, error);
    }
  }
  return null;
}

/**
 * Read a schematic text through both documented public access paths.
 *
 * `get(id)` is authoritative for public enum values. In EasyEDA Pro 3.2.x it
 * can become lossy for individual fields after modify(), while `getAll()` may
 * expose internal encoded values. We therefore use getAll() only to fill
 * non-enum fields that are missing from get(id).
 */
async function readPublicTextPrimitive(primitiveClass: any, path: string, primitiveId: string) {
  if (typeof primitiveClass.get !== 'function') return undefined;
  try {
    return await primitiveClass.get(primitiveId);
  } catch (error) {
    logRecoverableError(`${path}.get(${primitiveId}) failed while reading text`, error);
    return undefined;
  }
}

async function readPersistentTextPrimitive(primitiveClass: any, path: string, primitiveId: string) {
  if (typeof primitiveClass.getAll !== 'function') return undefined;
  try {
    const all = (await primitiveClass.getAll()) || [];
    if (!Array.isArray(all)) return undefined;
    return all.find((item) => extractPrimitiveId(item) === primitiveId);
  } catch (error) {
    logRecoverableError(`${path}.getAll() failed while reading text fallback state`, error);
    return undefined;
  }
}

function validatedPublicTextPrimitive(
  publicCurrent: unknown,
  persistentCurrent: unknown,
  primitiveId: string,
): unknown {
  if (!publicCurrent) return undefined;
  const publicPrimitiveId = extractPrimitiveId(publicCurrent);
  const identifiesRequestedPrimitive = publicPrimitiveId === primitiveId;
  const confirmedByInventory = !publicPrimitiveId && Boolean(persistentCurrent);
  return identifiesRequestedPrimitive || confirmedByInventory ? publicCurrent : undefined;
}

async function readTextPrimitiveFromClass(
  paths: string[],
  primitiveId: string,
): Promise<TextPrimitiveRead | null> {
  for (const path of paths) {
    const primitiveClass = readFirstPath<any>([path]);
    if (!primitiveClass) continue;
    const persistentCurrent = await readPersistentTextPrimitive(primitiveClass, path, primitiveId);
    const publicCandidate = await readPublicTextPrimitive(primitiveClass, path, primitiveId);
    const publicCurrent = validatedPublicTextPrimitive(
      publicCandidate,
      persistentCurrent,
      primitiveId,
    );
    if (publicCurrent || persistentCurrent) {
      return { publicCurrent, persistentCurrent, className: path };
    }
  }
  return null;
}

function componentSnapshotProperty(
  current: unknown,
  componentType: string,
): Record<string, unknown> {
  if (componentType === 'netflag' || componentType === 'netport') {
    return compactDefinedRecord({
      x: safeGetState(current, 'X'),
      y: safeGetState(current, 'Y'),
      rotation: safeGetState(current, 'Rotation'),
      mirror: safeGetState(current, 'Mirror'),
      net: safeGetState(current, 'Net'),
    });
  }
  return compactDefinedRecord({
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
    otherProperty:
      (safeGetState(current, 'OtherProperty') as Record<string, unknown> | undefined) || {},
  });
}

const COMPONENT_CLASS_PATHS = [
  'SCH_PrimitiveComponent',
  'SCH_PrimitiveComponent3',
  'sch_PrimitiveComponent',
];
const WIRE_CLASS_PATHS = ['SCH_PrimitiveWire', 'SCH_PrimitiveWire3', 'sch_PrimitiveWire'];
const TEXT_CLASS_PATHS = ['SCH_PrimitiveText', 'sch_PrimitiveText'];
const RECTANGLE_CLASS_PATHS = ['SCH_PrimitiveRectangle', 'sch_PrimitiveRectangle'];
const CIRCLE_CLASS_PATHS = ['SCH_PrimitiveCircle', 'sch_PrimitiveCircle'];
const POLYGON_CLASS_PATHS = ['SCH_PrimitivePolygon', 'sch_PrimitivePolygon'];

interface TextSnapshotRead {
  candidateFound: boolean;
  snapshot?: SchematicPrimitiveSnapshot;
}

function componentKindFromType(componentType: string): SchematicPrimitiveSnapshotKind {
  if (componentType === 'netflag') return 'netflag';
  if (componentType === 'netport') return 'netport';
  return 'component';
}

function componentSnapshot(primitiveId: string, current: unknown): SchematicPrimitiveSnapshot {
  const componentType = readComponentType(current);
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: componentKindFromType(componentType),
    componentType,
    property: componentSnapshotProperty(current, componentType),
  };
}

function wireSnapshot(primitiveId: string, current: unknown): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: 'wire',
    property: compactDefinedRecord({
      line: safeGetState(current, 'Line'),
      net: safeGetState(current, 'Net'),
      color: safeGetState(current, 'Color'),
      lineWidth: safeGetState(current, 'LineWidth'),
      lineType: safeGetState(current, 'LineType'),
    }),
  };
}

function textSnapshot(
  primitiveId: string,
  text: TextPrimitiveRead,
  alignMode: PublicTextAlignMode,
): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: 'text',
    property: compactDefinedRecord({
      x: readTextState(text, 'X'),
      y: readTextState(text, 'Y'),
      content: readTextState(text, 'Content'),
      rotation: readTextState(text, 'Rotation'),
      color: readTextState(text, 'TextColor') ?? readTextState(text, 'Color'),
      fontName: readTextState(text, 'FontName'),
      fontSize: readTextState(text, 'FontSize'),
      bold: readTextState(text, 'Bold'),
      italic: readTextState(text, 'Italic'),
      underline: readTextState(text, 'UnderLine'),
      alignMode,
    }),
  };
}

function rectangleSnapshot(primitiveId: string, current: unknown): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: 'rectangle',
    property: compactDefinedRecord({
      x: safeGetState(current, 'TopLeftX') ?? safeGetState(current, 'X'),
      y: safeGetState(current, 'TopLeftY') ?? safeGetState(current, 'Y'),
      width: safeGetState(current, 'Width'),
      height: safeGetState(current, 'Height'),
      cornerRadius: safeGetState(current, 'CornerRadius'),
      rotation: safeGetState(current, 'Rotation'),
      color: safeGetState(current, 'Color'),
      fillColor: safeGetState(current, 'FillColor'),
      lineWidth: safeGetState(current, 'LineWidth'),
      lineType: safeGetState(current, 'LineType'),
      fillStyle: safeGetState(current, 'FillStyle'),
    }),
  };
}

function circleSnapshot(primitiveId: string, current: unknown): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: 'circle',
    property: compactDefinedRecord({
      centerX: safeGetState(current, 'CenterX'),
      centerY: safeGetState(current, 'CenterY'),
      radius: safeGetState(current, 'Radius'),
      color: safeGetState(current, 'Color'),
      fillColor: safeGetState(current, 'FillColor'),
      lineWidth: safeGetState(current, 'LineWidth'),
      lineType: safeGetState(current, 'LineType'),
      fillStyle: safeGetState(current, 'FillStyle'),
    }),
  };
}

function polygonSnapshot(primitiveId: string, current: unknown): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId,
    primitiveKind: 'polygon',
    property: compactDefinedRecord({
      line: safeGetState(current, 'Line'),
      color: safeGetState(current, 'Color'),
      fillColor: safeGetState(current, 'FillColor'),
      lineWidth: safeGetState(current, 'LineWidth'),
      lineType: safeGetState(current, 'LineType'),
    }),
  };
}

async function readComponentSnapshot(
  primitiveId: string,
  expectedKind?: SchematicPrimitiveSnapshotKind,
): Promise<SchematicPrimitiveSnapshot | null> {
  const primitive = await readPrimitiveFromClass(COMPONENT_CLASS_PATHS, primitiveId);
  if (!primitive) return null;
  const snapshot = componentSnapshot(primitiveId, primitive.current);
  return expectedKind && snapshot.primitiveKind !== expectedKind ? null : snapshot;
}

async function readClassSnapshot(
  primitiveId: string,
  paths: string[],
  factory: (primitiveId: string, current: unknown) => SchematicPrimitiveSnapshot,
): Promise<SchematicPrimitiveSnapshot | null> {
  const primitive = await readPrimitiveFromClass(paths, primitiveId);
  return primitive ? factory(primitiveId, primitive.current) : null;
}

async function readTextSnapshot(primitiveId: string): Promise<TextSnapshotRead> {
  const text = await readTextPrimitiveFromClass(TEXT_CLASS_PATHS, primitiveId);
  if (!text) return { candidateFound: false };
  const alignMode = resolvePublicTextAlignMode(text, primitiveId);
  return {
    candidateFound: true,
    snapshot: alignMode === undefined ? undefined : textSnapshot(primitiveId, text, alignMode),
  };
}

function throwUnsupportedTextSnapshot(primitiveId: string): never {
  throw newBridgeError(
    'UNSUPPORTED_RUNTIME',
    `Text ${primitiveId} did not expose a public alignMode`,
    'Retry after reloading the document. Exact text rollback requires a documented ESCH_PrimitiveTextAlignMode value from 1 through 9.',
  );
}

async function readSnapshotByKind(
  primitiveId: string,
  kind: SchematicPrimitiveSnapshotKind,
): Promise<SchematicPrimitiveSnapshot | null> {
  switch (kind) {
    case 'component':
    case 'netflag':
    case 'netport':
      return readComponentSnapshot(primitiveId, kind);
    case 'wire':
      return readClassSnapshot(primitiveId, WIRE_CLASS_PATHS, wireSnapshot);
    case 'text': {
      const text = await readTextSnapshot(primitiveId);
      if (text.candidateFound && !text.snapshot) throwUnsupportedTextSnapshot(primitiveId);
      return text.snapshot ?? null;
    }
    case 'rectangle':
      return readClassSnapshot(primitiveId, RECTANGLE_CLASS_PATHS, rectangleSnapshot);
    case 'circle':
      return readClassSnapshot(primitiveId, CIRCLE_CLASS_PATHS, circleSnapshot);
    case 'polygon':
      return readClassSnapshot(primitiveId, POLYGON_CLASS_PATHS, polygonSnapshot);
  }
}

async function readUnconstrainedSnapshot(
  primitiveId: string,
): Promise<SchematicPrimitiveSnapshot | null> {
  const component = await readComponentSnapshot(primitiveId);
  if (component) return component;
  const wire = await readClassSnapshot(primitiveId, WIRE_CLASS_PATHS, wireSnapshot);
  if (wire) return wire;

  const text = await readTextSnapshot(primitiveId);
  if (text.snapshot) return text.snapshot;
  const rectangle = await readClassSnapshot(primitiveId, RECTANGLE_CLASS_PATHS, rectangleSnapshot);
  if (rectangle) return rectangle;
  const circle = await readClassSnapshot(primitiveId, CIRCLE_CLASS_PATHS, circleSnapshot);
  if (circle) return circle;
  const polygon = await readClassSnapshot(primitiveId, POLYGON_CLASS_PATHS, polygonSnapshot);
  if (polygon) return polygon;
  if (text.candidateFound) throwUnsupportedTextSnapshot(primitiveId);
  return null;
}

async function getSchematicPrimitiveSnapshot(
  primitiveId: string,
  expectedPrimitiveKind?: SchematicPrimitiveSnapshotKind,
): Promise<SchematicPrimitiveSnapshot> {
  if (!primitiveId) {
    throw newBridgeError(
      'INVALID_PARAMS',
      'primitiveId is required',
      'Provide the primitive ID returned by a schematic read or write operation.',
    );
  }

  const snapshot = expectedPrimitiveKind
    ? await readSnapshotByKind(primitiveId, expectedPrimitiveKind)
    : await readUnconstrainedSnapshot(primitiveId);
  if (snapshot) return snapshot;
  if (expectedPrimitiveKind) {
    throw newBridgeError(
      'PRIMITIVE_NOT_FOUND',
      `Primitive ${primitiveId} was not found as expected kind ${expectedPrimitiveKind}`,
      'Refresh the expected primitive inventory and retry the transaction.',
    );
  }
  throw newBridgeError(
    'PRIMITIVE_NOT_FOUND',
    `Primitive ${primitiveId} was not found in a transaction-safe schematic class`,
    'Use a component, net flag/port, wire, text, rectangle, circle, or polygon primitive ID.',
  );
}

function parseSchematicPrimitiveSnapshot(input: unknown): SchematicPrimitiveSnapshot {
  if (!isRecord(input)) {
    throw newBridgeError(
      'INVALID_PARAMS',
      'snapshot must be an object',
      'Pass the exact object returned by schematic.getPrimitiveSnapshot.',
    );
  }
  const schemaVersion = input.schemaVersion;
  const primitiveId = input.primitiveId;
  const primitiveKind = input.primitiveKind;
  const property = input.property;
  const allowedKinds = new Set<SchematicPrimitiveSnapshotKind>([
    'component',
    'netflag',
    'netport',
    'wire',
    'text',
    'rectangle',
    'circle',
    'polygon',
  ]);
  if (
    schemaVersion !== 'schematic-primitive-snapshot/v1' ||
    typeof primitiveId !== 'string' ||
    !allowedKinds.has(primitiveKind as SchematicPrimitiveSnapshotKind) ||
    !isRecord(property)
  ) {
    throw newBridgeError(
      'INVALID_PARAMS',
      'snapshot does not match schematic-primitive-snapshot/v1',
      'Pass an unmodified snapshot returned by schematic.getPrimitiveSnapshot.',
    );
  }
  return {
    schemaVersion,
    primitiveId,
    primitiveKind: primitiveKind as SchematicPrimitiveSnapshotKind,
    componentType: typeof input.componentType === 'string' ? input.componentType : undefined,
    property: { ...property },
  };
}

const RECREATABLE_SCHEMATIC_KINDS = new Set<SchematicPrimitiveSnapshotKind>([
  'wire',
  'text',
  'rectangle',
  'circle',
  'polygon',
]);

function schematicPrimitiveClassPaths(kind: SchematicPrimitiveSnapshotKind): string[] {
  switch (kind) {
    case 'component':
    case 'netflag':
    case 'netport':
      return ['SCH_PrimitiveComponent', 'SCH_PrimitiveComponent3', 'sch_PrimitiveComponent'];
    case 'wire':
      return ['SCH_PrimitiveWire', 'SCH_PrimitiveWire3', 'sch_PrimitiveWire'];
    case 'text':
      return ['SCH_PrimitiveText', 'sch_PrimitiveText'];
    case 'rectangle':
      return ['SCH_PrimitiveRectangle', 'sch_PrimitiveRectangle'];
    case 'circle':
      return ['SCH_PrimitiveCircle', 'sch_PrimitiveCircle'];
    case 'polygon':
      return ['SCH_PrimitivePolygon', 'sch_PrimitivePolygon'];
  }
}

function parseSchematicPrimitiveKind(value: unknown): SchematicPrimitiveSnapshotKind {
  const allowed = new Set<SchematicPrimitiveSnapshotKind>([
    'component',
    'netflag',
    'netport',
    'wire',
    'text',
    'rectangle',
    'circle',
    'polygon',
  ]);
  if (typeof value !== 'string' || !allowed.has(value as SchematicPrimitiveSnapshotKind)) {
    throw newBridgeError(
      'INVALID_PARAMS',
      `Unsupported schematic primitive kind: ${String(value)}`,
      `Use one of: ${Array.from(allowed).join(', ')}.`,
    );
  }
  return value as SchematicPrimitiveSnapshotKind;
}

function primitiveIdFromValue(value: unknown): string {
  const direct = extractPrimitiveId(value);
  if (direct) return direct;
  const fallback = safeGetState(value, 'PrimitiveId');
  if (typeof fallback === 'string') return fallback;
  if (typeof fallback === 'number' || typeof fallback === 'bigint') return String(fallback);
  return '';
}

async function listSchematicPrimitiveIds(
  kindInput: unknown,
): Promise<{ primitiveKind: SchematicPrimitiveSnapshotKind; primitiveIds: string[] }> {
  const primitiveKind = parseSchematicPrimitiveKind(kindInput);
  const primitiveClass = readFirstPath<any>(schematicPrimitiveClassPaths(primitiveKind));
  if (!primitiveClass) return { primitiveKind, primitiveIds: [] };

  let values: unknown[] = [];
  if (typeof primitiveClass.getAll === 'function') {
    try {
      values =
        primitiveKind === 'component' || primitiveKind === 'netflag' || primitiveKind === 'netport'
          ? (await primitiveClass.getAll(undefined, true)) || []
          : (await primitiveClass.getAll()) || [];
    } catch (error) {
      logRecoverableError(`failed to list ${primitiveKind} primitives`, error);
    }
  }

  if (values.length === 0 && typeof primitiveClass.getAllPrimitiveId === 'function') {
    try {
      const primitiveIds = ((await primitiveClass.getAllPrimitiveId()) || [])
        .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
        .sort((a: string, b: string) => a.localeCompare(b));
      return { primitiveKind, primitiveIds: Array.from(new Set(primitiveIds)) };
    } catch (error) {
      logRecoverableError(`failed to list ${primitiveKind} primitive IDs`, error);
    }
  }

  const primitiveIds = values
    .filter((value) => {
      if (primitiveKind === 'component') {
        const componentType = readComponentType(value);
        return componentType !== 'netflag' && componentType !== 'netport';
      }
      if (primitiveKind === 'netflag' || primitiveKind === 'netport') {
        return readComponentType(value) === primitiveKind;
      }
      return true;
    })
    .map(primitiveIdFromValue)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { primitiveKind, primitiveIds: Array.from(new Set(primitiveIds)) };
}

async function primitiveExistsInClass(primitiveClass: any, primitiveId: string): Promise<boolean> {
  if (typeof primitiveClass.get === 'function') {
    try {
      return Boolean(await primitiveClass.get(primitiveId));
    } catch {
      return false;
    }
  }
  if (typeof primitiveClass.getAllPrimitiveId === 'function') {
    try {
      return ((await primitiveClass.getAllPrimitiveId()) || []).includes(primitiveId);
    } catch {
      return false;
    }
  }
  return false;
}

async function deleteSchematicPrimitives(
  primitiveIdsInput: unknown,
): Promise<{ success: boolean; deleted: string[]; notFound: string[] }> {
  const primitiveIds = Array.isArray(primitiveIdsInput)
    ? primitiveIdsInput.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : [];
  const kinds: SchematicPrimitiveSnapshotKind[] = [
    'component',
    'wire',
    'text',
    'rectangle',
    'circle',
    'polygon',
  ];
  const deleted: string[] = [];
  const notFound: string[] = [];

  for (const primitiveId of primitiveIds) {
    let owner: any;
    for (const kind of kinds) {
      const primitiveClass = readFirstPath<any>(schematicPrimitiveClassPaths(kind));
      if (!primitiveClass || typeof primitiveClass.delete !== 'function') continue;
      if (await primitiveExistsInClass(primitiveClass, primitiveId)) {
        owner = primitiveClass;
        break;
      }
    }
    if (!owner) {
      notFound.push(primitiveId);
      continue;
    }
    await owner.delete([primitiveId]);
    textAlignModeCache.delete(primitiveId);
    deleted.push(primitiveId);
  }
  return { success: notFound.length === 0, deleted, notFound };
}

function requiredSnapshotNumber(property: Record<string, unknown>, key: string): number {
  const value = property[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw newBridgeError(
      'INVALID_PARAMS',
      `Snapshot property ${key} must be a finite number`,
      'Pass an unmodified snapshot returned by schematic.getPrimitiveSnapshot.',
    );
  }
  return value;
}

async function recreateSchematicPrimitiveSnapshot(
  input: unknown,
): Promise<{ primitiveId: string; snapshot: SchematicPrimitiveSnapshot }> {
  const snapshot = parseSchematicPrimitiveSnapshot(input);
  if (!RECREATABLE_SCHEMATIC_KINDS.has(snapshot.primitiveKind)) {
    throw newBridgeError(
      'UNSUPPORTED_RUNTIME',
      `Delete rollback is not supported for ${snapshot.primitiveKind} primitives`,
      'Use transaction-backed modify, or avoid deleting components/net flags/net ports until a complete creation descriptor is available.',
    );
  }

  const before = new Set((await listSchematicPrimitiveIds(snapshot.primitiveKind)).primitiveIds);
  const property = snapshot.property;
  let result: unknown;
  switch (snapshot.primitiveKind) {
    case 'wire':
      result = await callFirst(
        ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
        property.line,
        property.net,
        property.color,
        property.lineWidth,
        property.lineType,
      );
      break;
    case 'text': {
      const rawY = requiredSnapshotNumber(property, 'y');
      result = await callFirst(
        ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
        requiredSnapshotNumber(property, 'x'),
        -rawY,
        property.content,
        property.rotation ?? 0,
        property.color ?? '#000000',
        property.fontName ?? 'Arial',
        property.fontSize ?? 20,
        property.bold ?? false,
        property.italic ?? false,
        property.underline ?? false,
        requirePublicTextAlignMode(property.alignMode, 'snapshot.property.alignMode'),
      );
      break;
    }
    case 'rectangle': {
      const rawY = requiredSnapshotNumber(property, 'y');
      result = await callFirst(
        ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
        requiredSnapshotNumber(property, 'x'),
        -rawY,
        requiredSnapshotNumber(property, 'width'),
        requiredSnapshotNumber(property, 'height'),
        property.cornerRadius ?? 0,
        property.rotation ?? 0,
        property.color ?? '#000000',
        property.fillColor ?? 'none',
        property.lineWidth ?? 1,
        property.lineType ?? 0,
        property.fillStyle ?? 'none',
      );
      break;
    }
    case 'circle':
      result = await callFirst(
        ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
        requiredSnapshotNumber(property, 'centerX'),
        requiredSnapshotNumber(property, 'centerY'),
        requiredSnapshotNumber(property, 'radius'),
        property.color ?? '#000000',
        property.fillColor ?? 'none',
        property.lineWidth ?? 1,
        property.lineType ?? 0,
        property.fillStyle ?? 'none',
      );
      break;
    case 'polygon':
      result = await callFirst(
        ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
        property.line,
        property.color ?? '#000000',
        property.fillColor ?? 'none',
        property.lineWidth ?? 1,
        property.lineType ?? 0,
      );
      break;
    default:
      throw newBridgeError(
        'UNSUPPORTED_RUNTIME',
        `Cannot recreate ${snapshot.primitiveKind}`,
        'Use a supported drawing primitive snapshot.',
      );
  }

  let primitiveId = extractPrimitiveId(result);
  if (!primitiveId) {
    const after = (await listSchematicPrimitiveIds(snapshot.primitiveKind)).primitiveIds;
    const added = after.filter((id) => !before.has(id));
    if (added.length === 1) primitiveId = added[0];
  }
  if (!primitiveId) {
    throw newBridgeError(
      'CREATE_UNCONFIRMED',
      `Recreated ${snapshot.primitiveKind} did not expose a unique primitive ID`,
      'Inspect the sheet before retrying; the primitive may have been created without an addressable result.',
    );
  }
  return { primitiveId, snapshot: await getSchematicPrimitiveSnapshot(primitiveId) };
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

async function requireActivePcbContext(): Promise<void> {
  const dmtPcb = readFirstPath<any>(['DMT_Pcb', 'dmt_Pcb']);
  if (!dmtPcb || typeof dmtPcb.getCurrentPcbInfo !== 'function') {
    // Older EasyEDA builds may not expose DMT_Pcb. Preserve compatibility and
    // let the concrete PCB API call decide whether the context is usable.
    return;
  }

  let currentPcb: unknown;
  try {
    currentPcb = await dmtPcb.getCurrentPcbInfo();
  } catch (error) {
    throw newBridgeError(
      'CONTEXT_UNAVAILABLE',
      'PCB data is unavailable in the current editor context.',
      'Open and focus a PCB document, then retry.',
      { cause: errorMessage(error) },
    );
  }
  if (!currentPcb) {
    throw newBridgeError(
      'CONTEXT_UNAVAILABLE',
      'No active PCB document is focused.',
      'Open and focus a PCB document, then retry.',
    );
  }
}

function isActivePcbLayerName(name: string, copperLayerCount: number): boolean {
  const inner = /^Inner(\d+)$/i.exec(name);
  if (inner) return Number(inner[1]) <= Math.max(0, copperLayerCount - 2);
  // EasyEDA returns its entire layer catalogue (200 Custom slots and all 32
  // possible inner layers) from getAllLayers(). Those catalogue placeholders
  // are not layers in the active board. A renamed custom layer no longer
  // matches this placeholder pattern and is retained.
  if (/^Custom\d+$/i.test(name) || /^Dielectric\d+$/i.test(name)) return false;
  return true;
}

async function readCopperLayerCount(pcbLayerClass: any): Promise<number> {
  if (typeof pcbLayerClass?.getTheNumberOfCopperLayers !== 'function') return 0;
  try {
    const value = Number(await pcbLayerClass.getTheNumberOfCopperLayers());
    return Number.isInteger(value) && value >= 2 ? value : 0;
  } catch (error) {
    logRecoverableError('failed to read copper layer count', error);
    return 0;
  }
}

async function listLayersApi(): Promise<unknown> {
  await requireActivePcbContext();
  const pcbLayerClass = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
  if (!pcbLayerClass || typeof pcbLayerClass.getAllLayers !== 'function') {
    throw new Error('pcb_Layer class or getAllLayers method not found');
  }
  const copperLayerCount = await readCopperLayerCount(pcbLayerClass);
  const rawLayers = await pcbLayerClass.getAllLayers();
  const layers = Array.isArray(rawLayers) ? rawLayers : [];
  return layers
    .filter((layer: any) => isActivePcbLayerName(String(layer?.name ?? ''), copperLayerCount))
    .map((layer: any, index: number) => ({
      name: layer?.name || '',
      type: layer?.type || '',
      color: layer?.color || '',
      visible: layer?.visible !== false,
      order:
        typeof layer?.order === 'number' && Number.isFinite(layer.order) && layer.order > 0
          ? layer.order
          : index,
    }));
}

async function getStackupApi(): Promise<unknown> {
  await requireActivePcbContext();
  const pcbLayerClass = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
  if (!pcbLayerClass) {
    throw new Error('pcb_Layer class not found');
  }

  const totalCopper = await readCopperLayerCount(pcbLayerClass);
  let physicalStacking: any = null;
  if (typeof pcbLayerClass.getCurrentPhysicalStackingConfiguration === 'function') {
    try {
      physicalStacking = await pcbLayerClass.getCurrentPhysicalStackingConfiguration();
    } catch (error) {
      logRecoverableError('failed to read physical stackup', error);
    }
  }

  const rawLayers = Array.isArray(physicalStacking?.layers)
    ? physicalStacking.layers
    : Array.isArray(physicalStacking?.stackup)
      ? physicalStacking.stackup
      : [];
  const layers = rawLayers.map((layer: any) => ({
    name: layer?.name || '',
    type: layer?.type || '',
    thicknessMm: typeof layer?.thicknessMm === 'number' ? layer.thicknessMm : layer?.thickness,
    material: layer?.material || '',
    dielectricConstant:
      typeof layer?.dielectricConstant === 'number' ? layer.dielectricConstant : layer?.dielectric,
    copperWeightOz:
      typeof layer?.copperWeightOz === 'number' ? layer.copperWeightOz : layer?.copperWeight,
  }));
  const boardThickness =
    typeof physicalStacking?.thicknessMm === 'number'
      ? physicalStacking.thicknessMm
      : typeof physicalStacking?.thickness === 'number'
        ? physicalStacking.thickness
        : undefined;
  const available = Boolean(physicalStacking && layers.length > 0);

  return {
    totalLayers: totalCopper,
    boardThicknessMm: boardThickness,
    layers,
    available,
    source: available ? 'physical_stackup' : 'copper_layer_count_only',
  };
}

async function getDimensionsApi(): Promise<unknown> {
  await requireActivePcbContext();
  const globalObj = tk.getGlobal();
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

  const hasOutline = width > 0 && height > 0;
  return {
    widthMm: width,
    heightMm: height,
    shape: hasOutline ? 'custom' : undefined,
    mountingHoleCount: mountingHoles,
    areaMm2: width * height,
    hasOutline,
  };
}

async function getFeaturesApi(): Promise<unknown> {
  await requireActivePcbContext();
  const globalObj = tk.getGlobal();
  const pcbViaClass = readPath<any>(globalObj, 'pcb_PrimitiveVia');
  // Tracks are PCB_PrimitiveLine segments (confirmed live: PCB_PrimitivePolyline
  // never accepts a valid create() call). 'pcb_PrimitiveTrack' does not exist in
  // the runtime at all, so this count was always silently 0.
  const pcbTrackClass = readPath<any>(globalObj, 'pcb_PrimitiveLine');
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

/**
 * Classes pcbDeletePrimitivesApi checks, in lookup order. Confirmed live
 * (2026-07-07): PCB_PrimitiveComponent.delete() returns `true` for ANY id,
 * including ids belonging to other primitive types or ids that don't exist
 * at all — it does not validate ownership. The previous pcb.deleteComponent
 * implementation called only this method, so deleting a via or track
 * primitiveId silently did nothing while reporting success. PCB_Primitive's
 * own getPrimitiveTypeByPrimitiveId() is an empty stub in this runtime
 * (`async getPrimitiveTypeByPrimitiveId(t){}`) and cannot be used to route
 * by type, so each candidate class's real membership is checked directly via
 * getAllPrimitiveId() before calling its delete().
 */
const PCB_DELETABLE_CLASSES = [
  'PCB_PrimitiveComponent',
  'PCB_PrimitiveVia',
  'PCB_PrimitiveLine',
  'PCB_PrimitivePad',
  'PCB_PrimitivePolyline',
  'PCB_PrimitivePour',
  'PCB_PrimitiveArc',
  'PCB_PrimitiveAttribute',
  'PCB_PrimitiveDimension',
  'PCB_PrimitiveFill',
  'PCB_PrimitiveImage',
  'PCB_PrimitiveObject',
  'PCB_PrimitivePoured',
  'PCB_PrimitiveRegion',
  'PCB_PrimitiveString',
] as const;

async function pcbDeletePrimitivesApi(
  primitiveIds: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  const remaining = new Set(primitiveIds);
  const deleted: string[] = [];

  for (const className of PCB_DELETABLE_CLASSES) {
    if (remaining.size === 0) break;
    const cls = readFirstPath<any>([className]);
    if (!cls || typeof cls.getAllPrimitiveId !== 'function' || typeof cls.delete !== 'function') {
      continue;
    }
    let ownedIds: Set<string>;
    try {
      ownedIds = new Set((await cls.getAllPrimitiveId()) ?? []);
    } catch (e) {
      logRecoverableError(`pcb.deleteComponent: ${className}.getAllPrimitiveId failed`, e);
      continue;
    }
    const matches = [...remaining].filter((id) => ownedIds.has(id));
    if (matches.length === 0) continue;
    try {
      await cls.delete(matches);
      for (const id of matches) {
        remaining.delete(id);
        deleted.push(id);
      }
    } catch (e) {
      logRecoverableError(`pcb.deleteComponent: ${className}.delete failed`, e);
    }
  }

  return { deleted, notFound: [...remaining] };
}

/**
 * PCB readback: list placed components, tracks, and vias. Field names below
 * are taken from getState_* getters observed live on real primitives
 * (created via the fixed pcb.addVia/pcb.addTrack and a manually-placed
 * footprint) — not guessed, unlike the schematic reflection-based readers.
 * Requires an active/focused PCB tab in EasyEDA Pro; DMT_Pcb.getCurrentPcbInfo()
 * returns null otherwise and these calls will return an empty list rather
 * than throw, since "no PCB open" is a normal state, not an error.
 */
async function pcbListComponentsApi(limit?: number, offset = 0): Promise<unknown> {
  await requireActivePcbContext();
  const pcbCompClass = readFirstPath<any>(['PCB_PrimitiveComponent', 'pcb_PrimitiveComponent']);
  if (!pcbCompClass || typeof pcbCompClass.getAll !== 'function') {
    return { total: 0, items: [] };
  }
  const all = (await pcbCompClass.getAll()) || [];
  const total = all.length;
  const start = Math.max(0, offset);
  const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
  const items = all.slice(start, end).map((c: any) => {
    const footprint = safeGetState(c, 'Footprint') as Record<string, unknown> | undefined;
    const component = safeGetState(c, 'Component') as Record<string, unknown> | undefined;
    return {
      primitiveId: safeGetState(c, 'PrimitiveId') ?? '',
      designator: safeGetState(c, 'Designator') ?? '',
      footprintName: footprint?.name ?? '',
      footprintUuid: footprint?.uuid ?? '',
      footprintLibraryUuid: footprint?.libraryUuid ?? '',
      deviceName: component?.name ?? '',
      x: safeGetState(c, 'X'),
      y: safeGetState(c, 'Y'),
      rotation: safeGetState(c, 'Rotation'),
      layer: safeGetState(c, 'Layer'),
      locked: safeGetState(c, 'PrimitiveLock') ?? false,
    };
  });
  return { total, items };
}

async function pcbListTracksApi(limit?: number, offset = 0): Promise<unknown> {
  await requireActivePcbContext();
  // Tracks are PCB_PrimitiveLine segments — see the pcb.addTrack case for why
  // PCB_PrimitivePolyline is not used (its create() never resolved live).
  const pcbLineClass = readFirstPath<any>(['PCB_PrimitiveLine', 'pcb_PrimitiveLine']);
  if (!pcbLineClass || typeof pcbLineClass.getAll !== 'function') {
    return { total: 0, items: [] };
  }
  const all = (await pcbLineClass.getAll()) || [];
  const total = all.length;
  const start = Math.max(0, offset);
  const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
  const items = all.slice(start, end).map((l: any) => ({
    primitiveId: safeGetState(l, 'PrimitiveId') ?? '',
    net: safeGetState(l, 'Net') ?? '',
    layer: safeGetState(l, 'Layer'),
    startX: safeGetState(l, 'StartX'),
    startY: safeGetState(l, 'StartY'),
    endX: safeGetState(l, 'EndX'),
    endY: safeGetState(l, 'EndY'),
    width: safeGetState(l, 'LineWidth'),
    locked: safeGetState(l, 'PrimitiveLock') ?? false,
  }));
  return { total, items };
}

async function pcbListViasApi(limit?: number, offset = 0): Promise<unknown> {
  await requireActivePcbContext();
  const pcbViaClass = readFirstPath<any>(['PCB_PrimitiveVia', 'pcb_PrimitiveVia']);
  if (!pcbViaClass || typeof pcbViaClass.getAll !== 'function') {
    return { total: 0, items: [] };
  }
  const all = (await pcbViaClass.getAll()) || [];
  const total = all.length;
  const start = Math.max(0, offset);
  const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
  const items = all.slice(start, end).map((v: any) => ({
    primitiveId: safeGetState(v, 'PrimitiveId') ?? '',
    net: safeGetState(v, 'Net') ?? '',
    x: safeGetState(v, 'X'),
    y: safeGetState(v, 'Y'),
    holeDiameter: safeGetState(v, 'HoleDiameter'),
    diameter: safeGetState(v, 'Diameter'),
    locked: safeGetState(v, 'PrimitiveLock') ?? false,
  }));
  return { total, items };
}

async function generateBomApi(params: any): Promise<unknown> {
  const comps = ((await listComponentsApi()) as { items: any[] }).items;
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
/** Default length (schematic units) of the wire stub connect_pin_to_net draws
 *  outward from a pin when the caller does not specify one. Matches the
 *  common pin length observed on placed library symbols. */
const DEFAULT_CONNECT_STUB_LENGTH = 10;

interface PinPoint {
  x: number;
  y: number;
  rotation: number;
}

function readPinPoint(pin: unknown): Partial<PinPoint> {
  const state = readMember(pin, 'state');
  const stateRecord = isRecord(state) ? state : undefined;
  const x = readMember(pin, 'x') ?? stateRecord?.X;
  const y = readMember(pin, 'y') ?? stateRecord?.Y;
  const rotation = readMember(pin, 'rotation') ?? stateRecord?.Rotation;
  return {
    x: typeof x === 'number' ? x : undefined,
    y: typeof y === 'number' ? y : undefined,
    rotation: typeof rotation === 'number' ? rotation : undefined,
  };
}

function readPinNumber(pin: unknown): string {
  const value = safeGetState(pin, 'PinNumber');
  return value !== undefined && value !== null ? String(value) : '';
}

type PinNoConnectState = {
  componentPrimitiveId: string;
  pinPrimitiveId: string;
  pinNumber: string;
  pinName: string;
  noConnected: boolean;
  pin: unknown;
};

function readPinName(pin: unknown): string {
  const value = safeGetState(pin, 'PinName');
  return value !== undefined && value !== null ? String(value) : '';
}

function readPinNoConnected(pin: unknown): boolean {
  const value = safeGetState(pin, 'NoConnected');
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}

async function resolvePinNoConnectState(
  componentPrimitiveId: string,
  pinNumber: string,
): Promise<PinNoConnectState> {
  const pins = await callFirst(
    [
      'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
      'sch_PrimitiveComponent.getAllPinsByPrimitiveId',
    ],
    componentPrimitiveId,
  );
  const matches = (Array.isArray(pins) ? pins : []).filter(
    (pin) => readPinNumber(pin) === String(pinNumber),
  );
  if (matches.length === 0) {
    throw newBridgeError(
      'PIN_NOT_FOUND',
      `Pin "${pinNumber}" was not found on component "${componentPrimitiveId}"`,
      'Verify the component primitive ID and exact pin number with easyeda_schematic_component_pins.',
      { componentPrimitiveId, pinNumber },
    );
  }
  if (matches.length > 1) {
    throw newBridgeError(
      'PIN_AMBIGUOUS',
      `Pin number "${pinNumber}" matched ${matches.length} pins on component "${componentPrimitiveId}"`,
      'Use a component whose pin numbers are unique before applying a no-connect marker.',
      { componentPrimitiveId, pinNumber, matchCount: matches.length },
    );
  }
  const pin = matches[0];
  const pinPrimitiveId = extractPrimitiveId(pin) || String(safeGetState(pin, 'PrimitiveId') ?? '');
  if (!pinPrimitiveId) {
    throw newBridgeError(
      'PIN_PRIMITIVE_ID_UNAVAILABLE',
      `Pin "${pinNumber}" on component "${componentPrimitiveId}" has no addressable primitive ID`,
      'Update EasyEDA Pro or the bridge extension before retrying this write.',
      { componentPrimitiveId, pinNumber },
    );
  }
  return {
    componentPrimitiveId,
    pinPrimitiveId,
    pinNumber: readPinNumber(pin),
    pinName: readPinName(pin),
    noConnected: readPinNoConnected(pin),
    pin,
  };
}

function publicPinNoConnectState(state: PinNoConnectState) {
  return {
    componentPrimitiveId: state.componentPrimitiveId,
    pinPrimitiveId: state.pinPrimitiveId,
    pinNumber: state.pinNumber,
    pinName: state.pinName,
    noConnected: state.noConnected,
  };
}

async function setPinNoConnectState(
  componentPrimitiveId: string,
  pinNumber: string,
  noConnected: boolean,
) {
  const before = await resolvePinNoConnectState(componentPrimitiveId, pinNumber);
  if (before.noConnected === noConnected) {
    return {
      ...publicPinNoConnectState(before),
      previousNoConnected: before.noConnected,
      changed: false,
      verified: true,
    };
  }

  const pinRecord = isRecord(before.pin) ? before.pin : undefined;
  const setter = pinRecord?.setState_NoConnected;
  const done = pinRecord?.done;
  if (typeof setter === 'function' && typeof done === 'function') {
    const updated = setter.call(before.pin, noConnected);
    const doneTarget =
      isRecord(updated) && typeof updated.done === 'function' ? updated : before.pin;
    await (doneTarget as { done: () => Promise<unknown> | unknown }).done();
  } else {
    const pinClass = readFirstPath<any>(['SCH_PrimitivePin', 'sch_PrimitivePin']);
    if (!pinClass || typeof pinClass.modify !== 'function') {
      throw newBridgeError(
        'PIN_NO_CONNECT_UNSUPPORTED',
        'The connected EasyEDA runtime does not expose a supported component-pin no-connect write path',
        'Update EasyEDA Pro or use a bridge build that supports SCH_PrimitivePin.modify.',
        { componentPrimitiveId, pinNumber },
      );
    }
    await pinClass.modify(before.pin, { noConnected });
  }

  const after = await resolvePinNoConnectState(componentPrimitiveId, pinNumber);
  if (after.noConnected !== noConnected) {
    throw newBridgeError(
      'PIN_NO_CONNECT_VERIFY_FAILED',
      `Pin "${pinNumber}" no-connect readback did not match the requested state`,
      'Do not retry blindly; inspect the pin state and EasyEDA ERC result first.',
      {
        componentPrimitiveId,
        pinNumber,
        requested: noConnected,
        observed: after.noConnected,
      },
    );
  }
  return {
    ...publicPinNoConnectState(after),
    previousNoConnected: before.noConnected,
    changed: true,
    verified: true,
  };
}

/**
 * Resolve a pin's exact connection coordinate and outward direction (away
 * from the component body, along the pin's own axis). Verified live: a wire
 * endpoint placed at this exact (x, y) — the same coordinate
 * SCH_PrimitiveComponent.getAllPinsByPrimitiveId reports and the same one
 * easyeda_schematic_component_pins exposes — registers as connected to the
 * pin under EasyEDA's native ERC, with no separate "attach" step needed.
 */
async function resolvePinEndpoint(
  primitiveId: string,
  pinNumber: string,
): Promise<{ x: number; y: number; dx: number; dy: number }> {
  const pins = await callFirst(
    [
      'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
      'sch_PrimitiveComponent.getAllPinsByPrimitiveId',
    ],
    primitiveId,
  );
  const pinList = Array.isArray(pins) ? pins : [];
  const target = pinList.find((p) => readPinNumber(p) === String(pinNumber));
  if (!target) {
    throw newBridgeError(
      'EASYEDA_API_ERROR',
      `Pin "${pinNumber}" not found on component "${primitiveId}"`,
      'Verify the primitiveId and pin number are correct (see schematic_component_pins).',
    );
  }
  const point = readPinPoint(target);
  if (point.x === undefined || point.y === undefined) {
    throw newBridgeError(
      'EASYEDA_API_ERROR',
      `Pin "${pinNumber}" on component "${primitiveId}" did not report coordinates`,
      'The EasyEDA Pro runtime may not expose pin coordinates for this component type.',
    );
  }
  const rotation = point.rotation ?? 0;
  const rad = (rotation * Math.PI) / 180;
  // Round to the nearest integer: rotation is conventionally a multiple of
  // 90 degrees, so cos/sin land on {-1, 0, 1} up to floating-point noise.
  const dx = Math.round(Math.cos(rad));
  const dy = Math.round(Math.sin(rad));
  return { x: point.x, y: point.y, dx, dy };
}

/** Every pin coordinate for a placed component, used to snapshot "what did this
 *  component's pins touch" before a move so `followConnectedWires` can find
 *  wires that need to follow. Silently omits pins the runtime doesn't report
 *  coordinates for (same tolerance as resolvePinEndpoint). */
async function getComponentPinCoordinates(primitiveId: string): Promise<SchematicPoint[]> {
  let pins: unknown;
  try {
    pins = await callFirst(
      [
        'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
        'sch_PrimitiveComponent.getAllPinsByPrimitiveId',
      ],
      primitiveId,
    );
  } catch (e) {
    logRecoverableError(`failed to read pins for ${primitiveId}`, e);
    return [];
  }
  const pinList = Array.isArray(pins) ? pins : [];
  const points: SchematicPoint[] = [];
  for (const pin of pinList) {
    const point = readPinPoint(pin);
    if (typeof point.x === 'number' && typeof point.y === 'number') {
      points.push({ x: point.x, y: point.y });
    }
  }
  return points;
}

/**
 * Given a wire's raw `Line` state (flat number[] or [x,y][] pairs — see
 * normalizeWireLine), translate only the points matching `targetKeys` by
 * (dx, dy), preserving the original shape. Returns null if nothing matched
 * (so callers can skip writing wires that weren't touched by the move).
 */
function shiftWireLine(
  rawLine: unknown,
  targetKeys: Set<string>,
  dx: number,
  dy: number,
): { line: unknown } | null {
  if (!Array.isArray(rawLine) || rawLine.length === 0) return null;
  let changed = false;
  if (Array.isArray(rawLine[0])) {
    const updated = (rawLine as number[][]).map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return pair;
      const [x, y, ...rest] = pair;
      if (!targetKeys.has(pointKey({ x, y }))) return pair;
      changed = true;
      return [x + dx, y + dy, ...rest];
    });
    return changed ? { line: updated } : null;
  }
  const flat = (rawLine as number[]).slice();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (!targetKeys.has(pointKey({ x: flat[i], y: flat[i + 1] }))) continue;
    flat[i] += dx;
    flat[i + 1] += dy;
    changed = true;
  }
  return changed ? { line: flat } : null;
}

/**
 * After a component has been moved by (dx, dy), find every wire with an
 * endpoint that was touching one of the component's *old* pin coordinates
 * (`oldPinPoints`, captured before the move) and translate that endpoint by
 * the same delta — so the wire keeps following the pin instead of being left
 * behind at its old absolute coordinate (which orphans it, and risks a new
 * silent short if the component's new pin position happens to land on
 * another unrelated primitive). Preserves each wire's net/color/width/style
 * by re-merging its full current state before writing, matching the
 * modify-resets-omitted-fields behavior documented on schematic.modifyPrimitive.
 */
async function followConnectedWires(
  oldPinPoints: SchematicPoint[],
  dx: number,
  dy: number,
): Promise<{ movedWireIds: string[]; failedWireIds: string[] }> {
  const outcome = { movedWireIds: [] as string[], failedWireIds: [] as string[] };
  if (oldPinPoints.length === 0 || (dx === 0 && dy === 0)) return outcome;

  const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
  if (
    !schWireClass ||
    typeof schWireClass.getAll !== 'function' ||
    typeof schWireClass.modify !== 'function'
  ) {
    return outcome;
  }

  const targetKeys = new Set(oldPinPoints.map((p) => pointKey(p)));
  let wires: unknown[] = [];
  try {
    wires = (await schWireClass.getAll()) || [];
  } catch (e) {
    logRecoverableError('failed to read wires while following a component move', e);
    return outcome;
  }

  for (const wire of wires) {
    const shifted = shiftWireLine(safeGetState(wire, 'Line'), targetKeys, dx, dy);
    if (!shifted) continue;
    const wireId = extractPrimitiveId(wire);
    if (!wireId) {
      outcome.failedWireIds.push('<unknown>');
      continue;
    }
    try {
      await schWireClass.modify(wireId, {
        line: shifted.line,
        net: safeGetState(wire, 'Net'),
        color: safeGetState(wire, 'Color'),
        lineWidth: safeGetState(wire, 'LineWidth'),
        lineType: safeGetState(wire, 'LineType'),
      });
      outcome.movedWireIds.push(wireId);
    } catch (e) {
      logRecoverableError(`failed to follow wire ${wireId} after component move`, e);
      outcome.failedWireIds.push(wireId);
    }
  }
  return outcome;
}

/**
 * Create REAL EasyEDA netlist connectivity for a single pin by drawing a
 * short wire stub from the pin's exact coordinate, tagged with `netName`.
 * Per the bridge's connectivity model, any wire sharing a net name merges
 * into that net regardless of physical location — so this stub alone joins
 * the pin to every other primitive already using `netName`, without needing
 * to route to a specific existing wire. Runs the same foreign-net collision
 * guard as schematic.addWire before writing.
 */
async function connectPinToNetImpl(
  primitiveId: string,
  pinNumber: string,
  netName: string,
  stubLength: number = DEFAULT_CONNECT_STUB_LENGTH,
): Promise<{ primitiveId: string; endpoint: { x: number; y: number } }> {
  const { x, y, dx, dy } = await resolvePinEndpoint(primitiveId, pinNumber);
  const endpoint = { x: x + dx * stubLength, y: y + dy * stubLength };
  const points = [{ x, y }, endpoint];

  const collision = await findForeignNetCollision(points, netName);
  if (collision) {
    const collidedWith = collision.kind === 'wire' ? 'an existing wire' : 'a pin or net flag/port';
    throw newBridgeError(
      'NET_COLLISION',
      `Refusing to connect pin "${pinNumber}" on "${primitiveId}" to net "${netName}": point ` +
        `(${collision.x}, ${collision.y}) coincides with ${collidedWith} on net ` +
        `"${collision.foreignNet}". EasyEDA Pro auto-merges primitives that share a coordinate, ` +
        'which would silently short these two nets together.',
      `Retry with a different stubLength, or route this connection manually with schematic.addWire.`,
    );
  }

  const created = await callFirst(
    ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
    [x, y, endpoint.x, endpoint.y],
    netName,
    undefined,
    undefined,
    undefined,
  );
  const createdId = extractPrimitiveId(created);
  return { primitiveId: createdId, endpoint };
}

function normalizeDrcSeverity(raw: unknown): 'error' | 'warning' | 'info' {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('fatal') || s.includes('error')) return 'error';
  if (s.includes('warn')) return 'warning';
  return 'info';
}

function normalizeDrcViolation(item: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
  const explanation =
    obj.explanation && typeof obj.explanation === 'object'
      ? (obj.explanation as Record<string, unknown>).str
      : undefined;
  const message =
    obj.message ?? obj.msg ?? obj.description ?? obj.text ?? obj.detail ?? explanation ?? item;
  const severitySource = [
    obj.level,
    obj.severity,
    obj.type,
    obj.errorLevel,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    obj.ruleName,
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
  const posSource =
    obj.position && typeof obj.position === 'object'
      ? (obj.position as Record<string, unknown>)
      : obj.location && typeof obj.location === 'object'
        ? (obj.location as Record<string, unknown>)
        : obj;
  const x = posSource.x;
  const y = posSource.y;
  return {
    rule: String(
      obj.rule ??
        obj.ruleName ??
        obj.ruleTypeName ??
        obj.errorType ??
        obj.name ??
        obj.type ??
        'unknown',
    ),
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

function normalizeDrcAggregate(
  item: unknown,
): { severity: 'error' | 'warning' | 'info'; count: number } | null {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj || typeof obj.count !== 'number') return null;
  const severitySource = [
    obj.type,
    obj.severity,
    obj.level,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    Array.isArray(obj.title) ? obj.title.join(' ') : obj.title,
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
  return { severity: normalizeDrcSeverity(severitySource), count: obj.count };
}

function hasDrcLeafDetail(obj: Record<string, unknown>): boolean {
  return [
    'message',
    'msg',
    'description',
    'text',
    'detail',
    'explanation',
    'errorType',
    'errorObjType',
    'rule',
    'ruleName',
    'ruleTypeName',
  ].some((key) => obj[key] !== undefined);
}

function normalizeDrcNode(item: unknown): {
  violations: Array<Record<string, unknown>>;
  aggregates: Array<{ severity: 'error' | 'warning' | 'info'; count: number }>;
} {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj) return { violations: [normalizeDrcViolation(item)], aggregates: [] };

  const children = Array.isArray(obj.list) ? obj.list : [];
  if (children.length > 0) {
    const normalizedChildren = children.map(normalizeDrcNode);
    const violations = normalizedChildren.flatMap((entry) => entry.violations);
    const aggregates = normalizedChildren.flatMap((entry) => entry.aggregates);
    if (violations.length > 0 || aggregates.length > 0) return { violations, aggregates };
  }

  if (hasDrcLeafDetail(obj)) {
    return { violations: [normalizeDrcViolation(obj)], aggregates: [] };
  }
  const aggregate = normalizeDrcAggregate(obj);
  return { violations: [], aggregates: aggregate ? [aggregate] : [] };
}

/**
 * Runs the native SCH_Drc.check/PCB_Drc.check API correctly. EasyEDA has two
 * observed verbose return shapes: flat aggregates (`{type,count}`) and nested
 * UI trees (`{name,count,list:[...]}`). The latter is used by PCB netlist
 * mismatch checks, so the tree must be recursively flattened rather than
 * stringified as one informational item.
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
  const normalized = items.map(normalizeDrcNode);
  const detailedViolations = normalized.flatMap((entry) => entry.violations);
  const aggregates = normalized.flatMap((entry) => entry.aggregates);
  const aggregateViolations = aggregates
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      rule: 'aggregate',
      description:
        `${entry.count} ${entry.severity}(s) reported by EasyEDA's native design/electrical rule ` +
        'check. Per-violation detail is only shown in EasyEDA Pro when the API returns aggregate counts.',
      severity: entry.severity,
    }));
  const violations = [...detailedViolations, ...aggregateViolations];
  const errorCount =
    detailedViolations.filter((entry) => entry.severity === 'error').length +
    aggregates
      .filter((entry) => entry.severity === 'error')
      .reduce((sum, entry) => sum + entry.count, 0);
  const warningCount =
    detailedViolations.filter((entry) => entry.severity === 'warning').length +
    aggregates
      .filter((entry) => entry.severity === 'warning')
      .reduce((sum, entry) => sum + entry.count, 0);
  const totalViolations =
    detailedViolations.length + aggregates.reduce((sum, entry) => sum + entry.count, 0);
  return {
    violations,
    totalViolations,
    errorCount,
    warningCount,
    passed: errorCount === 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run PCB DRC only when a PCB canvas is available, translating EasyEDA's
 * opaque message-bus failure into a stable bridge error. The public MCP tool
 * already maps this error to `not_available: true`; callers of the bridge API
 * now receive an actionable code/suggestion instead of a localized runtime
 * string. */
async function runPcbDrcCheck(): ReturnType<typeof runDrcCheck> {
  try {
    return await runDrcCheck(['PCB_Drc.check']);
  } catch (error) {
    throw newBridgeError(
      'CONTEXT_UNAVAILABLE',
      'PCB DRC is unavailable in the current editor context.',
      'Open and focus a PCB document, then retry design.drc.',
      { cause: errorMessage(error) },
    );
  }
}

/** Generic rule-check chooses the active canvas by trying PCB first and then
 * schematic. EasyEDA exposes both classes globally even when their canvas is
 * not active, so class presence alone is not a reliable context signal. */
async function runRuleCheckForActiveCanvas(): ReturnType<typeof runDrcCheck> {
  let pcbError: unknown;
  try {
    return await runDrcCheck(['PCB_Drc.check']);
  } catch (error) {
    pcbError = error;
    logRecoverableError('design.ruleCheck: PCB DRC unavailable; trying schematic ERC/DRC', error);
  }
  try {
    return await runDrcCheck(['SCH_Drc.check']);
  } catch (schematicError) {
    throw newBridgeError(
      'CONTEXT_UNAVAILABLE',
      'No active PCB or schematic canvas is available for design.ruleCheck.',
      'Open and focus a PCB or schematic document, then retry.',
      { pcbCause: errorMessage(pcbError), schematicCause: errorMessage(schematicError) },
    );
  }
}

/**
 * Find schematic pins whose (designator, pinNumber) does not appear in any
 * inferred net's node list. Shared by schematic.validateNetlist and the ERC
 * enhancement in design.erc — see the comment at validateNetlist's call site
 * for why connectivity is read from listNetsApi()'s authoritative net data
 * rather than by re-reading each pin's OtherProperty.net.
 */
function buildConnectedNodeSet(netlistData: SchematicNetEntry[]): Set<string> {
  const connectedNodes = new Set<string>();
  for (const n of netlistData) {
    for (const node of n.nodes || []) {
      connectedNodes.add(`${node.component} ${node.pin}`);
    }
  }
  return connectedNodes;
}

async function collectFloatingPinsForComponent(
  component: any,
  ref: string,
  primitiveId: string,
  connectedNodes: Set<string>,
): Promise<Array<{ primitiveId: string; designator: string; pinNumber: string }>> {
  const floating: Array<{ primitiveId: string; designator: string; pinNumber: string }> = [];
  try {
    const pins = await component.getAllPins();
    for (const p of pins || []) {
      if (typeof p.getState_PinNumber !== 'function') continue;
      const pinNum = String(p.getState_PinNumber());
      if (!connectedNodes.has(`${ref} ${pinNum}`)) {
        floating.push({ primitiveId: primitiveId || ref, designator: ref, pinNumber: pinNum });
      }
    }
  } catch {
    // skip component
  }
  return floating;
}

async function findFloatingPinsApi(): Promise<{
  floatingPins: Array<{ primitiveId: string; designator: string; pinNumber: string }>;
  partRefs: string[];
}> {
  const netlistData = (await listNetsApi()) as SchematicNetEntry[];
  const connectedNodes = buildConnectedNodeSet(netlistData);
  const floatingPins: Array<{ primitiveId: string; designator: string; pinNumber: string }> = [];
  const partRefs = new Set<string>();
  const schCompClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (!schCompClass || typeof schCompClass.getAll !== 'function') {
    return { floatingPins, partRefs: [] };
  }
  const allComps = (await schCompClass.getAll(undefined, true)) || [];
  for (const c of allComps) {
    const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
    // Skip primitives without a designator (title block, net flags, net
    // ports, net labels): they are not schematic parts and have no pins
    // to treat as floating, and counting them inflated the tally.
    if (!ref || typeof c.getAllPins !== 'function') continue;
    partRefs.add(ref);
    const primitiveId =
      typeof c.getState_PrimitiveId === 'function' ? String(c.getState_PrimitiveId()) : '';
    floatingPins.push(
      ...(await collectFloatingPinsForComponent(c, ref, primitiveId, connectedNodes)),
    );
  }
  return { floatingPins, partRefs: [...partRefs] };
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
      const budget = createNetDetailBudget(netName, params.operationTimeoutMs);
      const allNets = (await listNetsApi(budget)) as Array<{
        netName: string;
        nodes: unknown[];
      }>;
      const match = allNets.find((n) => n.netName === netName);
      if (!match)
        throw newBridgeError(
          'NET_NOT_FOUND',
          `Net "${netName}" not found`,
          'Check net name spelling.',
        );
      return match;
    }
    case 'schematic.getPrimitiveSnapshot':
      return getSchematicPrimitiveSnapshot(
        params.primitiveId as string,
        typeof params.expectedPrimitiveKind === 'string'
          ? (params.expectedPrimitiveKind as SchematicPrimitiveSnapshotKind)
          : undefined,
      );
    case 'schematic.listPrimitiveIds':
      return listSchematicPrimitiveIds(params.primitiveKind);
    case 'schematic.listComponents':
      return listComponentsApi(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'schematic.getSheetInfo':
      return getSchematicSheetInfoApi();
    case 'schematic.primitiveBounds':
      return primitiveBoundsApi(params.primitiveIds);
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
      // subPartName is meant to select a specific sub-part/gate of a multi-part
      // device (e.g. adding a second power-pin sub-part to an existing
      // multi-gate symbol reference). SCH_PrimitiveComponent.create only
      // accepts (deviceItem, x, y) — passing extra arguments causes it to hang
      // or reject (see below) — and no sub-part-selecting follow-up call is
      // known to exist on this runtime surface (SCH_PrimitiveComponent.modify's
      // reverse-engineered field set has no subPart-like property either). This
      // parameter previously reached here and was silently dropped, so every
      // placement request created an independent full component on the
      // default sub-part regardless of what was asked for. Reject up front —
      // before creating anything — rather than placing a component and then
      // reporting an error, which would leave an orphaned, unrequested part
      // behind for a caller who just saw "failed" and might retry.
      if (typeof params.subPartName === 'string' && params.subPartName.length > 0) {
        throw newBridgeError(
          'NOT_IMPLEMENTED',
          `subPartName ("${params.subPartName}") is not supported: this runtime has no way to ` +
            'select a specific sub-part when placing a component — every placement creates an ' +
            'independent component on the default sub-part.',
          'Omit subPartName. If a specific sub-part/gate is needed, place the device as its own ' +
            'component and wire it manually instead of relying on sub-part selection.',
        );
      }
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
        const collidedWith =
          collision.kind === 'wire' ? 'an existing wire' : 'a pin or net flag/port';
        throw newBridgeError(
          'NET_COLLISION',
          `Refusing to draw wire for net "${netName}": point (${collision.x}, ${collision.y}) ` +
            `coincides with ${collidedWith} on net "${collision.foreignNet}". EasyEDA Pro ` +
            'auto-merges primitives that share a coordinate (not just endpoints), which would ' +
            'silently short these two nets together.',
          `Route this wire through coordinates not used by net "${collision.foreignNet}", ` +
            'or call schematic_nets afterward to confirm the intended topology.',
        );
      }

      const pts = rawPoints.flatMap((p) => [p.x, p.y]);
      const wireNetName = (await shouldSuppressDuplicateWireNetName(rawPoints, netName))
        ? undefined
        : netName;
      return callFirst(
        ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
        pts,
        wireNetName,
        params.color,
        params.lineWidth,
        params.lineType,
      );
    }
    case 'schematic.addCircle':
      // SCH_PrimitiveCircle.create's field order was recovered
      // (2026-07-07) by reading the minified source of .modify() via
      // .toString(): create(CenterX, CenterY, Radius, Color, FillColor,
      // LineWidth, LineType, FillStyle) — 8 args, confirmed live via
      // readback (first attempt succeeded with typed values).
      return callFirst(
        ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
        params.centerX,
        params.centerY,
        params.radius,
        params.color ?? '#000000',
        params.fillColor ?? 'none',
        params.lineWidth ?? 1,
        params.lineType ?? 0,
        params.fillStyle ?? 'none',
      );
    case 'schematic.addPolygon':
      // SCH_PrimitivePolygon.create's field order was recovered
      // (2026-07-07) by reading the minified source of .modify() via
      // .toString(): create(Line, Color, FillColor, LineWidth, LineType) —
      // 5 args. `line` is a flat [x1,y1,x2,y2,...] array of vertices (same
      // shape as SCH_PrimitiveWire's `line`), confirmed live via readback.
      return callFirst(
        ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
        (params.points as Array<{ x: number; y: number }>).flatMap((p) => [p.x, p.y]),
        params.color ?? '#000000',
        params.fillColor ?? 'none',
        params.lineWidth ?? 1,
        params.lineType ?? 0,
      );
    case 'schematic.addText': {
      // Official API: create(X, Y, Content, Rotation, TextColor, FontName,
      // FontSize, Bold, Italic, UnderLine, AlignMode). AlignMode is the public
      // ESCH_PrimitiveTextAlignMode enum (1..9); 0 and internal getAll()
      // encodings are not valid modify/create inputs.
      const alignMode =
        params.alignMode === undefined ? undefined : requirePublicTextAlignMode(params.alignMode);
      const result = await callFirst(
        ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
        params.x,
        params.y,
        params.content,
        params.rotation ?? 0,
        params.color ?? '#000000',
        params.fontName ?? 'Arial',
        params.fontSize ?? 20,
        params.bold ?? false,
        params.italic ?? false,
        params.underline ?? false,
        alignMode,
      );
      const primitiveId = extractPrimitiveId(result);
      const resultAlignMode = asPublicTextAlignMode(safeGetState(result, 'AlignMode'));
      if (primitiveId && (resultAlignMode ?? alignMode) !== undefined) {
        textAlignModeCache.set(primitiveId, (resultAlignMode ?? alignMode)!);
      }
      return result;
    }
    case 'schematic.addRectangle':
      // SCH_PrimitiveRectangle.create's field order was recovered
      // (2026-07-07) by reading the minified source of .modify() via
      // .toString() — its setState_* call sequence gives the exact
      // positional order: create(TopLeftX, TopLeftY, Width, Height,
      // CornerRadius, Rotation, Color, FillColor, LineWidth, LineType,
      // FillStyle) — 11 args, confirmed live via readback.
      return callFirst(
        ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
        params.x,
        params.y,
        params.width,
        params.height,
        params.cornerRadius ?? 0,
        params.rotation ?? 0,
        params.color ?? '#000000',
        params.fillColor ?? 'none',
        params.lineWidth ?? 1,
        params.lineType ?? 0,
        params.fillStyle ?? 'none',
      );
    case 'schematic.listRectangles': {
      // Best-effort enumeration for the section-layout overlap check
      // (src/workflows/section-layout.ts). Live-verified (2026-07-09): the
      // plain 'X'/'Y' guess used by SCH_PrimitiveComponent/SCH_PrimitiveText
      // does NOT hold here — a live readback returned width/height/rotation
      // correctly but x/y were undefined. SCH_PrimitiveRectangle.create()'s
      // own positional args are named TopLeftX/TopLeftY (see addRectangle
      // above), and that's the key that actually resolves; X/Y kept as a
      // fallback in case a future runtime version differs. Still degrades to
      // "no overlap data" (not a crash) if both guesses are wrong.
      //
      // Y-sign note (live-verified 2026-07-09): a rectangle created with
      // `y: 5000` reads back TopLeftY: -5000 — an exact sign flip, also
      // observed on SCH_PrimitiveText the same way (created y:6000 -> read
      // back y:-6000). SCH_PrimitiveComponent (pins) and SCH_PrimitiveWire
      // (Line) showed no such flip across multiple live checks — this
      // appears specific to these two annotation-layer primitive types, not
      // a general coordinate-system quirk. Negate on the way out so callers
      // (e.g. findOverlappingRectangles, which compares against pin-derived
      // Y coordinates) see the same sign convention as everything else.
      const schRectClass = readFirstPath<any>(['SCH_PrimitiveRectangle', 'sch_PrimitiveRectangle']);
      if (!schRectClass || typeof schRectClass.getAll !== 'function') {
        return { total: 0, items: [] };
      }
      let all: unknown[] = [];
      try {
        all = (await schRectClass.getAll()) || [];
      } catch (e) {
        logRecoverableError('failed to list rectangles', e);
        all = [];
      }
      const items = all.map((r) => {
        const rawY = safeGetState(r, 'TopLeftY') ?? safeGetState(r, 'Y');
        return {
          primitiveId: extractPrimitiveId(r) || String(safeGetState(r, 'PrimitiveId') ?? ''),
          x: safeGetState(r, 'TopLeftX') ?? safeGetState(r, 'X'),
          y: typeof rawY === 'number' ? -rawY : rawY,
          width: safeGetState(r, 'Width'),
          height: safeGetState(r, 'Height'),
          rotation: safeGetState(r, 'Rotation'),
        };
      });
      return { total: items.length, items };
    }
    case 'schematic.deletePrimitive':
      return deleteSchematicPrimitives(params.primitiveIds);
    case 'schematic.recreatePrimitiveSnapshot':
      return recreateSchematicPrimitiveSnapshot(params.snapshot);
    case 'schematic.restorePrimitiveSnapshot': {
      const snapshot = parseSchematicPrimitiveSnapshot(params.snapshot);
      await dispatch('schematic.modifyPrimitive', {
        primitiveId: snapshot.primitiveId,
        property: snapshot.property,
      });
      return {
        restored: true,
        snapshot: await getSchematicPrimitiveSnapshot(snapshot.primitiveId),
      };
    }
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
      if (
        schCompClass &&
        typeof schCompClass.get === 'function' &&
        typeof schCompClass.modify === 'function'
      ) {
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
          const oldX = safeGetState(current, 'X');
          const oldY = safeGetState(current, 'Y');
          const merged: Record<string, unknown> = {
            x: oldX,
            y: oldY,
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

          // A position change leaves this component's wires behind at their old
          // absolute coordinates unless we explicitly move them too — capture
          // the pins' pre-move coordinates now, before the underlying primitive
          // moves out from under them.
          const movingPosition =
            typeof oldX === 'number' &&
            typeof oldY === 'number' &&
            (typeof property.x === 'number' || typeof property.y === 'number') &&
            (property.x !== oldX || property.y !== oldY);
          const oldPinPoints = movingPosition ? await getComponentPinCoordinates(primitiveId) : [];

          const modifyResult = await schCompClass.modify(primitiveId, merged);

          let followedWireIds: string[] = [];
          let wireFollowFailures: string[] = [];
          if (movingPosition && oldPinPoints.length > 0) {
            const newX = typeof merged.x === 'number' ? merged.x : (oldX as number);
            const newY = typeof merged.y === 'number' ? merged.y : (oldY as number);
            const dx = newX - (oldX as number);
            const dy = newY - (oldY as number);
            const followed = await followConnectedWires(oldPinPoints, dx, dy);
            followedWireIds = followed.movedWireIds;
            wireFollowFailures = followed.failedWireIds;
          }

          return { result: modifyResult, followedWireIds, wireFollowFailures };
        }
      }

      const schWireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
      if (
        schWireClass &&
        typeof schWireClass.get === 'function' &&
        typeof schWireClass.modify === 'function'
      ) {
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

      // Text primitives previously fell through to the generic fallback below,
      // which blindly tries SCH_PrimitiveComponent.modify()/SCH_PrimitiveWire.modify()
      // on a text primitiveId neither class recognizes — surfacing as an
      // upstream API error (or a silent no-op) instead of actually editing the
      // text. Field names (Content, TextColor, FontName, ...) mirror
      // schematic.addText's create() argument order above.
      const schTextClass = readFirstPath<any>(['SCH_PrimitiveText', 'sch_PrimitiveText']);
      if (
        schTextClass &&
        typeof schTextClass.modify === 'function' &&
        (typeof schTextClass.getAll === 'function' || typeof schTextClass.get === 'function')
      ) {
        const text = await readTextPrimitiveFromClass(
          ['SCH_PrimitiveText', 'sch_PrimitiveText'],
          primitiveId,
        );
        if (text) {
          const incoming: Record<string, unknown> = { ...property };
          const requestedAlignMode = Object.prototype.hasOwnProperty.call(incoming, 'alignMode')
            ? requirePublicTextAlignMode(incoming.alignMode)
            : undefined;
          const currentAlignMode = resolvePublicTextAlignMode(text, primitiveId);
          const alignMode = requestedAlignMode ?? currentAlignMode;
          if (alignMode === undefined) {
            throw newBridgeError(
              'UNSUPPORTED_RUNTIME',
              `Text ${primitiveId} did not expose a public alignMode`,
              'Read the text after reloading the document, or provide alignMode explicitly using a value from 1 through 9.',
            );
          }

          if (incoming.color !== undefined) incoming.textColor = incoming.color;
          if (incoming.underline !== undefined) incoming.underLine = incoming.underline;
          delete incoming.color;
          delete incoming.underline;
          incoming.alignMode = alignMode;

          const merged: Record<string, unknown> = {
            x: readTextState(text, 'X'),
            y: readTextState(text, 'Y'),
            content: readTextState(text, 'Content'),
            rotation: readTextState(text, 'Rotation'),
            textColor: readTextState(text, 'TextColor') ?? readTextState(text, 'Color'),
            fontName: readTextState(text, 'FontName'),
            fontSize: readTextState(text, 'FontSize'),
            bold: readTextState(text, 'Bold'),
            italic: readTextState(text, 'Italic'),
            underLine: readTextState(text, 'UnderLine'),
            ...incoming,
          };
          const result = await schTextClass.modify(primitiveId, merged);
          const resultAlignMode = asPublicTextAlignMode(safeGetState(result, 'AlignMode'));
          textAlignModeCache.set(primitiveId, resultAlignMode ?? alignMode);
          return result;
        }
      }

      // Circle/Polygon had the same fall-through-to-wrong-handler gap as Text
      // above. Field names mirror their respective create() argument order
      // (schematic.addCircle/addPolygon), which was itself recovered by
      // reading .modify()'s minified source via .toString() — see the
      // comments on those create() cases.
      const schCircleClass = readFirstPath<any>(['SCH_PrimitiveCircle', 'sch_PrimitiveCircle']);
      if (
        schCircleClass &&
        typeof schCircleClass.get === 'function' &&
        typeof schCircleClass.modify === 'function'
      ) {
        let current: unknown;
        try {
          current = await schCircleClass.get(primitiveId);
        } catch (e) {
          logRecoverableError(`SCH_PrimitiveCircle.get(${primitiveId}) failed`, e);
        }
        if (current) {
          const merged: Record<string, unknown> = {
            centerX: safeGetState(current, 'CenterX'),
            centerY: safeGetState(current, 'CenterY'),
            radius: safeGetState(current, 'Radius'),
            color: safeGetState(current, 'Color'),
            fillColor: safeGetState(current, 'FillColor'),
            lineWidth: safeGetState(current, 'LineWidth'),
            lineType: safeGetState(current, 'LineType'),
            fillStyle: safeGetState(current, 'FillStyle'),
            ...property,
          };
          return schCircleClass.modify(primitiveId, merged);
        }
      }

      const schPolygonClass = readFirstPath<any>(['SCH_PrimitivePolygon', 'sch_PrimitivePolygon']);
      if (
        schPolygonClass &&
        typeof schPolygonClass.get === 'function' &&
        typeof schPolygonClass.modify === 'function'
      ) {
        let current: unknown;
        try {
          current = await schPolygonClass.get(primitiveId);
        } catch (e) {
          logRecoverableError(`SCH_PrimitivePolygon.get(${primitiveId}) failed`, e);
        }
        if (current) {
          const merged: Record<string, unknown> = {
            line: safeGetState(current, 'Line'),
            color: safeGetState(current, 'Color'),
            fillColor: safeGetState(current, 'FillColor'),
            lineWidth: safeGetState(current, 'LineWidth'),
            lineType: safeGetState(current, 'LineType'),
            ...property,
          };
          return schPolygonClass.modify(primitiveId, merged);
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
    case 'schematic.getPinNoConnect':
      return publicPinNoConnectState(
        await resolvePinNoConnectState(params.primitiveId as string, params.pinNumber as string),
      );
    case 'schematic.setPinNoConnect':
      return setPinNoConnectState(
        params.primitiveId as string,
        params.pinNumber as string,
        params.noConnected !== false,
      );
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
      const stubLength = typeof params.stubLength === 'number' ? params.stubLength : undefined;
      const result = await connectPinToNetImpl(
        params.primitiveId as string,
        params.pinNumber as string,
        params.netName as string,
        stubLength,
      );
      return {
        connected: true,
        real: true,
        primitiveId: result.primitiveId,
        endpoint: result.endpoint,
      };
    }
    case 'schematic.connectPinsByNet': {
      const pins = params.pins as Array<{ primitiveId: string; pinNumber: string }>;
      const stubLength = typeof params.stubLength === 'number' ? params.stubLength : undefined;
      const netName = params.netName as string;
      const createdPrimitiveIds: string[] = [];
      const failures: Array<{ primitiveId: string; pinNumber: string; error: string }> = [];
      for (const pin of pins || []) {
        try {
          const result = await connectPinToNetImpl(
            pin.primitiveId,
            pin.pinNumber,
            netName,
            stubLength,
          );
          createdPrimitiveIds.push(result.primitiveId);
        } catch (err) {
          logRecoverableError(
            `connectPinToNet failed for ${pin.primitiveId}/${pin.pinNumber}`,
            err,
          );
          failures.push({
            primitiveId: pin.primitiveId,
            pinNumber: pin.pinNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        count: createdPrimitiveIds.length,
        real: true,
        createdPrimitiveIds,
        failures,
      };
    }
    case 'schematic.setTitleBlock': {
      // DMT_Schematic.modifySchematicPageTitleBlock(showTitleBlock,
      // titleBlockData) live-reverse-engineered (2026-07-07): titleBlockData
      // is a flat map of field name -> {showTitle, showValue, value}.
      //
      // DATA-LOSS INCIDENT (2026-07-07, live-reproduced twice): the first
      // implementation round-tripped getCurrentSchematicPageInfo()'s FULL
      // snapshot (minus "ID") back through this call. That silently wiped
      // Symbol/Border/Title Block/showTitleBlock to empty/"0"/false on a
      // real project and left EasyEDA Pro's own Log panel reporting "Found
      // abnormal data, The Symbol/Device property ... is incorrect" for the
      // title block's internal element — a genuine corruption, not just a
      // stale read. Root-caused by controlled live tests afterward: sending
      // a MINIMAL payload containing only the caller's intended field(s)
      // does NOT corrupt anything (confirmed: showTitleBlock even self-
      // healed back to true), whereas including the read-only cluster
      // (Symbol, Device, Name, Description, Border, Width, Height, Region
      // Start, X/Y Region Count, Blade Width, Color, Title Block Position,
      // Title Block, all "@"-prefixed fields, ID) triggers server-side
      // corruption. Individually, that cluster is either a hard native
      // TypeError (Border: "Cannot set properties of undefined") or a
      // silent no-op (Symbol) — never a real write. CONCLUSION: never
      // round-trip the snapshot. Only ever send the caller's explicit
      // patch, restricted to the confirmed-safe allowlist below.
      //
      // A read immediately after writing can return a stale snapshot — the
      // change is real but eventually consistent, not synchronous.
      const SAFE_TITLE_BLOCK_FIELDS = new Set([
        'Company',
        'Version',
        'Drawn',
        'Reviewed',
        'Page Size',
      ]);
      const fields = (params.fields as Record<string, Record<string, unknown>>) ?? {};
      const unsafeKeys = Object.keys(fields).filter((key) => !SAFE_TITLE_BLOCK_FIELDS.has(key));
      if (unsafeKeys.length > 0) {
        throw newBridgeError(
          'INVALID_PARAMS',
          `schematic.setTitleBlock refuses to write field(s): ${unsafeKeys.join(', ')}. ` +
            'These are read-only through this API (writes either no-op or throw natively) and ' +
            "a past attempt to round-trip them corrupted a real project's title block.",
          `Only these fields are writable: ${[...SAFE_TITLE_BLOCK_FIELDS].join(', ')}.`,
        );
      }
      const pageInfo = await callFirst([
        'DMT_Schematic.getCurrentSchematicPageInfo',
        'dmt_Schematic.getCurrentSchematicPageInfo',
      ]).catch(() => undefined);
      if (!pageInfo) {
        throw newBridgeError(
          'SCHEMATIC_NOT_FOCUSED',
          'schematic.setTitleBlock requires the schematic tab to be the focused/active document.',
          'Click into the schematic document in EasyEDA Pro, then retry.',
        );
      }
      const showTitleBlock =
        typeof params.showTitleBlock === 'boolean' ? params.showTitleBlock : true;
      const result = await callFirst(
        [
          'DMT_Schematic.modifySchematicPageTitleBlock',
          'dmt_Schematic.modifySchematicPageTitleBlock',
        ],
        showTitleBlock,
        fields,
      );
      return { success: result === true };
    }
    case 'schematic.syncToPcb': {
      // Live-verified (2026-07-07): PCB_PrimitiveComponent.create() never
      // resolves — but that's the wrong call entirely. The real EasyEDA
      // workflow is schematic -> sync -> PCB: a part placed in the schematic
      // with addIntoPcb (the default) only reaches pcb.listComponents after
      // SCH_Document.importChanges() is called WITH THE SCHEMATIC DOCUMENT
      // FOCUSED. Calling PCB_Document.importChanges() from the PCB side
      // does NOT do this (tried, returns true, syncs nothing). Once synced,
      // pcb.modifyComponent correctly repositions/rotates the placed part.
      //
      // CAUTION (live-verified): SCH_Document.importChanges() resolves
      // `true` immediately regardless of outcome — it only OPENS a native
      // "Confirm Importing changes information" dialog in EasyEDA Pro's UI.
      // Nothing actually reaches the PCB until a human clicks through that
      // dialog; there is no known headless/scriptable way to confirm it.
      // This is NOT a fire-and-forget automation step.
      const schInfo = await callFirst([
        'DMT_Schematic.getCurrentSchematicInfo',
        'dmt_Schematic.getCurrentSchematicInfo',
      ]).catch(() => undefined);
      if (!schInfo) {
        throw newBridgeError(
          'SCHEMATIC_NOT_FOCUSED',
          'schematic.syncToPcb requires the schematic tab to be the focused/active document in EasyEDA Pro.',
          'Click into the schematic document in EasyEDA Pro, then retry.',
        );
      }
      const result = await callFirst(['SCH_Document.importChanges', 'sch_Document.importChanges']);
      return { synced: result !== false };
    }
    case 'schematic.validateNetlist': {
      const netlistData = (await listNetsApi()) as Array<{
        netName: string;
        nodes: Array<{ component: string; pin: string }>;
      }>;
      const connectedRefs = new Set<string>();
      const connectedPins = new Set<string>();
      const nets = netlistData.map((n) => {
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
      const { floatingPins, partRefs } = await findFloatingPinsApi();
      const warnings: string[] = [];
      // Count only real parts (those with a designator), not net flags/ports/
      // labels or the title block, so the tally is not inflated by non-parts.
      const totalRefs = partRefs.length;
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
      const edaGlobal = tk.getEda() ?? (globalThis as { eda?: unknown }).eda;
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
      const edaObj = tk.getEda();
      const EDAObj = tk.getEDA();
      const apiObj = tk.getApi();
      try {
        globals.typeof_api = typeof (globalThis as any).api;
        globals.typeof_eda = typeof (globalThis as any).eda;
        globals.typeof_EDA = typeof (globalThis as any).EDA;
        globals.typeof_local_api = typeof apiObj;
        globals.typeof_local_eda = typeof edaObj;
        globals.typeof_local_EDA = typeof EDAObj;

        if (edaObj) {
          try {
            globals.eda_keys = Object.getOwnPropertyNames(edaObj);
          } catch (e) {
            globals.eda_keys_err = String(e);
          }
          try {
            const edaKeys: string[] = [];
            for (const key in edaObj as Record<string, unknown>) {
              edaKeys.push(key);
            }
            globals.eda_for_in_keys = edaKeys;
          } catch (e) {
            globals.eda_for_in_keys_err = String(e);
          }

          const collectAllPropertyNames = (obj: any): string[] => {
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
            if ((edaObj as any).sch_PrimitiveComponent) {
              globals.sch_PrimitiveComponent_all_keys = collectAllPropertyNames(
                (edaObj as any).sch_PrimitiveComponent,
              );
            }
          } catch (e) {
            globals.sch_PrimitiveComponent_err = String(e);
          }

          try {
            if ((edaObj as any).sch_Document) {
              globals.sch_Document_all_keys = collectAllPropertyNames((edaObj as any).sch_Document);
            }
          } catch (e) {
            globals.sch_Document_err = String(e);
          }

          try {
            if ((edaObj as any).pcb_Document) {
              globals.pcb_Document_all_keys = collectAllPropertyNames((edaObj as any).pcb_Document);
            }
          } catch (e) {
            globals.pcb_Document_err = String(e);
          }

          try {
            if ((edaObj as any).dmt_Schematic) {
              globals.dmt_Schematic_all_keys = collectAllPropertyNames(
                (edaObj as any).dmt_Schematic,
              );
            }
          } catch (e) {
            globals.dmt_Schematic_err = String(e);
          }

          try {
            if ((edaObj as any).dmt_Project) {
              globals.dmt_Project_all_keys = collectAllPropertyNames((edaObj as any).dmt_Project);
            }
          } catch (e) {
            globals.dmt_Project_err = String(e);
          }

          try {
            if ((edaObj as any).dmt_Pcb) {
              globals.dmt_Pcb_all_keys = collectAllPropertyNames((edaObj as any).dmt_Pcb);
            }
          } catch (e) {
            globals.dmt_Pcb_err = String(e);
          }
        }

        if (EDAObj) {
          try {
            globals.EDA_keys = Object.getOwnPropertyNames(EDAObj as object);
          } catch (e) {
            globals.EDA_keys_err = String(e);
          }
          try {
            const edaKeys: string[] = [];
            for (const key in EDAObj as object) {
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

      const hasDMTLocal = isRecord(edaObj) && 'DMT_Schematic' in edaObj;
      const hasDMTEDA = isRecord(EDAObj) && 'DMT_Schematic' in EDAObj;

      return {
        bridgeVersion: tk.getBridgeVersion(),
        capabilities: [...METHOD_LIST],
        devMode: false,
        globals: globals,
        hasEda: !!edaObj || !!EDAObj,
        hasDMT: 'DMT_Schematic' in globalThis || hasDMTLocal || hasDMTEDA,
        dispatcherBuildId: BUILD_ID,
      };
    }
    case 'bom.generate':
      return generateBomApi(params);
    case 'bom.validate': {
      const comps = ((await listComponentsApi()) as { items: any[] }).items;
      return { totalParts: comps.length, missing: [], obsolete: [], alternates: [] };
    }
    case 'inventory.search':
      return [];
    case 'inventory.getPrice':
      return null;
    case 'design.ruleCheck':
      return runRuleCheckForActiveCanvas();
    case 'design.erc': {
      const result = await runDrcCheck(['SCH_Drc.check']);
      // SCH_Drc.check()'s verbose mode only ever returns per-severity
      // aggregates (confirmed live twice: a schematic with exactly one
      // floating-pin part produced exactly [{type:"warn",count:1}], no
      // location/net/component fields at any depth). Floating pins are the
      // one ERC category our own connectivity inference can locate
      // independently, so surface them as a best-effort supplement —
      // clearly not a full decomposition of the native count, since other
      // ERC categories (short circuits, conflicting pin types, etc.) have
      // no inference-based equivalent.
      try {
        const { floatingPins } = await findFloatingPinsApi();
        return {
          ...result,
          inferredFloatingPins: floatingPins,
          detailSource:
            floatingPins.length > 0
              ? ('inferred_partial' as const)
              : ('native_aggregate_only' as const),
        };
      } catch (e) {
        logRecoverableError('design.erc: floating-pin inference failed', e);
        return { ...result, inferredFloatingPins: [], detailSource: 'native_aggregate_only' };
      }
    }
    case 'design.drc':
      return runPcbDrcCheck();
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
      const { tabId } = params as { tabId?: string };
      const region = normalizeCanvasRegion(params as unknown as CanvasRegion);
      const zoomed = await callFirst(
        ['DMT_EditorControl.zoomToRegion'],
        region.left,
        region.right,
        region.top,
        region.bottom,
        tabId,
      );
      if (zoomed === false) {
        throw newBridgeError(
          'EASYEDA_API_ERROR',
          'EasyEDA could not zoom to the requested capture region.',
          'Verify that the target tab is open and the region uses document/canvas coordinates.',
        );
      }
      await waitForCanvasPaint();
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
    case 'pcb.addTrack': {
      // PCB_PrimitivePolyline.create's real argument order could not be
      // determined live (every points/layer/width/net permutation tried
      // against the runtime rejected with a generic "cannot create polygon
      // primitive" error). PCB_PrimitiveLine.create's signature WAS resolved
      // live by passing 8 distinguishable values and reading back
      // getState_*: create(net, layer, startX, startY, endX, endY,
      // lineWidth, locked) — note net comes FIRST, unlike the previous
      // (points, layer, width, net) call this replaces. A multi-point track
      // is drawn as one PCB_PrimitiveLine segment per consecutive point
      // pair, all sharing netName so they merge into one electrical track
      // (same coordinate-driven merge model as schematic wires).
      const rawPoints: Array<{ x: number; y: number }> = Array.isArray(params.points)
        ? params.points
        : [];
      if (rawPoints.length < 2) {
        throw newBridgeError(
          'INVALID_PARAMS',
          'pcb.addTrack requires at least 2 points',
          'Provide a points array with at least a start and end coordinate.',
        );
      }
      const netName = params.netName as string | undefined;
      const layer = params.layer;
      const width = params.width;
      const createdIds: string[] = [];
      for (let i = 1; i < rawPoints.length; i += 1) {
        const start = rawPoints[i - 1];
        const end = rawPoints[i];
        const created = await callFirst(
          ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
          netName,
          layer,
          start.x,
          start.y,
          end.x,
          end.y,
          width,
          false,
        );
        createdIds.push(extractPrimitiveId(created));
      }
      return { primitiveId: createdIds[0], primitiveIds: createdIds };
    }
    case 'pcb.addText':
      // PCB_PrimitiveString.create's field order was recovered
      // (2026-07-07) by reading the minified source of .modify() via
      // .toString() — its destructured input object gives the exact
      // positional order: create(Layer, X, Y, Text, FontFamily, FontSize,
      // LineWidth, AlignMode, Rotation, Reverse, Expansion, Mirror,
      // PrimitiveLock) — 13 args, confirmed live via readback on the Top
      // Silkscreen layer. fontFamily must be a name the runtime's font
      // list actually contains (validated internally); the default below
      // ("NotoSansMonoCJKsc-Regular") was live-verified to work.
      return callFirst(
        ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
        params.layer,
        params.x,
        params.y,
        params.text,
        params.fontFamily ?? 'NotoSansMonoCJKsc-Regular',
        params.fontSize ?? 1,
        params.lineWidth ?? 0.15,
        params.alignMode ?? 0,
        params.rotation ?? 0,
        params.reverse ?? false,
        params.expansion ?? 0,
        params.mirror ?? false,
        params.locked ?? false,
      );
    case 'pcb.addSilkscreenLine':
      // Reuses PCB_PrimitiveLine.create (the same primitive pcb.addTrack
      // draws copper tracks with) but with an empty net name and a
      // non-copper layer — a purely decorative/organizational line (e.g.
      // silkscreen section dividers) rather than an electrical connection.
      // Signature confirmed live (2026-07-07): create(net, layer, startX,
      // startY, endX, endY, lineWidth, locked).
      return callFirst(
        ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
        '',
        params.layer,
        params.startX,
        params.startY,
        params.endX,
        params.endY,
        params.lineWidth ?? 0.2,
        false,
      );
    case 'pcb.addVia':
      // PCB_PrimitiveVia.create's real argument order was resolved live by
      // passing 9 distinguishable values and reading back getState_*:
      // create(net, x, y, holeDiameter, diameter, viaType,
      // designRuleBlindViaName, locked, solderMaskExpansion) — note net
      // comes FIRST and hole/outer diameter are SWAPPED relative to the
      // previous (x, y, outerDiameter, holeSize, net) call this replaces,
      // which silently wrote garbage (net into X, diameter into Y, etc.)
      // while still reporting success. holeDiameter/diameter are passed
      // through in whatever native unit the caller supplies (unconverted,
      // same as x/y) — the exact real-world unit was not independently
      // cross-checked against a known physical dimension.
      return callFirst(
        ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
        params.netName,
        params.x,
        params.y,
        params.holeSize,
        params.outerDiameter,
        0,
        '',
        false,
        undefined,
      );
    case 'pcb.addZone':
      return callFirst(
        ['PCB_PrimitivePour.create', 'PCB_ComplexPolygon.create', 'pcb_PrimitivePour.create'],
        params.points,
        params.layer,
        params.netName,
        params.clearance,
      );
    case 'pcb.deleteComponent': {
      // Returns full per-id status rather than throwing on partial failure:
      // the bridge transport only preserves an error's message (not its data
      // payload) back to the MCP tool layer, so structured deleted/notFound
      // detail would be lost if this threw instead.
      const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
      const result = await pcbDeletePrimitivesApi(ids);
      return {
        success: result.notFound.length === 0,
        deletedCount: result.deleted.length,
        deleted: result.deleted,
        notFound: result.notFound,
      };
    }
    case 'pcb.modifyComponent':
      return callFirst(
        ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
        params.primitiveId,
        params.property,
      );
    case 'pcb.listComponents':
      return pcbListComponentsApi(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'pcb.listTracks':
      return pcbListTracksApi(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'pcb.listVias':
      return pcbListViasApi(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    default:
      throw newBridgeError(
        'METHOD_NOT_ALLOWED',
        `Unsupported bridge method: ${method}`,
        'Update the extension dispatcher or call a supported method.',
      );
  }
}

export function createDispatcher(toolkit: DispatcherToolkit): Dispatcher {
  tk = toolkit;
  textAlignModeCache.clear();
  log(`dispatcher initialized (build ${BUILD_ID}, ${METHOD_LIST.length} methods)`);
  return {
    dispatch,
    methodList: [...METHOD_LIST],
    buildId: BUILD_ID,
  };
}

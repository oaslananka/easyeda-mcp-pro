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
  'pcb.addTrack',
  'pcb.addVia',
  'pcb.addZone',
  'pcb.deleteComponent',
  'pcb.exportRouteContext',
  'pcb.listComponents',
  'pcb.listTracks',
  'pcb.listVias',
  'pcb.modifyComponent',
  'pcb.placeComponent',
  'project.export',
  'project.open',
  'project.save',
  'schematic.addWire',
  'schematic.connectPinToNet',
  'schematic.connectPinsByNet',
  'schematic.createNetFlag',
  'schematic.createNetPort',
  'schematic.deletePrimitive',
  'schematic.getNetDetail',
  'schematic.getSheetInfo',
  'schematic.listComponents',
  'schematic.listNets',
  'schematic.modifyPrimitive',
  'schematic.placeComponent',
  'schematic.searchDevice',
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
  const total = allComps.length;
  const start = Math.max(0, offset);
  const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
  const comps = allComps.slice(start, end);
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
    const comp = typeof c.getState_Component === 'function' ? c.getState_Component() : undefined;
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
  return { total, items: result };
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
  const globalObj = tk.getGlobal();
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
  const globalObj = tk.getGlobal();
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

  return {
    widthMm: width,
    heightMm: height,
    shape: 'custom',
    mountingHoleCount: mountingHoles,
    areaMm2: width * height,
  };
}

async function getFeaturesApi(): Promise<unknown> {
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
  const state = readMember(pin, 'state');
  const stateRecord = isRecord(state) ? state : undefined;
  const direct = readMember(pin, 'pinNumber') ?? stateRecord?.PinNumber;
  return direct !== undefined && direct !== null ? String(direct) : '';
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
    throw newBridgeError(
      'NET_COLLISION',
      `Refusing to connect pin "${pinNumber}" on "${primitiveId}" to net "${netName}": point ` +
        `(${collision.x}, ${collision.y}) coincides with an existing wire on net ` +
        `"${collision.foreignNet}". EasyEDA Pro auto-merges wires that share a coordinate, ` +
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
          'check. Per-violation detail (affected wire/net/component) is only shown in EasyEDA ' +
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
      return listComponentsApi(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
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
      const connectedNodes = new Set<string>();
      for (const n of netlistData) {
        for (const node of n.nodes || []) {
          connectedNodes.add(`${node.component} ${node.pin}`);
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
              if (!connectedNodes.has(`${ref} ${pinNum}`)) {
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
  log(`dispatcher initialized (build ${BUILD_ID}, ${METHOD_LIST.length} methods)`);
  return {
    dispatch,
    methodList: [...METHOD_LIST],
    buildId: BUILD_ID,
  };
}

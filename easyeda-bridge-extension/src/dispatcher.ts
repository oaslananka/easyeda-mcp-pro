// The hot-swappable dispatcher module: every EasyEDA Pro API interaction lives
// here, behind createDispatcher(toolkit). The loader (index.ts) bakes this
// module in as the fallback dispatcher; in dev mode the MCP server can push a
// freshly built dispatcher bundle over the bridge and swap it in without
// re-importing the .eext. All runtime globals are resolved through the
// injected DispatcherToolkit (see toolkit.ts) so the identical code works both
// baked into the extension script scope and eval'd via AsyncFunction.

import { createApiRuntime, type ApiRuntime } from './api-runtime.js';
import {
  compactPrimitiveSummary,
  normalizeStandalone,
  normalizeValue,
  readMember,
  readStateValue,
} from './api-introspection.js';
import { createBinaryResultNormalizer } from './binary-result-policy.js';
import {
  createBoardInspectionOperations,
  type BoardInspectionOperations,
} from './board-inspection.js';
import { createCanvasOperations, type CanvasOperations } from './canvas-operations.js';
import {
  createDesignRuleCheckOperations,
  type DesignRuleCheckOperations,
} from './design-rule-check-operations.js';
import { createExportOperations, type ExportOperations } from './export-operations.js';
import {
  createPcbMutationOperations,
  type PcbMutationOperations,
} from './pcb-mutation-operations.js';
import { createPcbReadOperations, type PcbReadOperations } from './pcb-read-operations.js';
import { createPcbWriteOperations, type PcbWriteOperations } from './pcb-write-operations.js';
import { createProjectOperations, type ProjectOperations } from './project-operations.js';
import {
  createSchematicComponentInspectionOperations,
  type SchematicComponentInspectionOperations,
} from './schematic-component-inspection.js';
import {
  createSchematicInspectionOperations,
  type SchematicInspectionOperations,
} from './schematic-inspection.js';
import {
  createSchematicTransactionOperations,
  type PublicTextAlignMode,
  type SchematicPrimitiveSnapshotKind,
  type SchematicTransactionOperations,
} from './schematic-transaction-operations.js';
import type { Dispatcher, DispatcherToolkit } from './toolkit.js';
import { isRecord, log, logRecoverableError, type JsonValue } from './utils.js';

// Injected at build time via esbuild --define; identifies this bundle build.
declare const __MCP_DISPATCHER_BUILD_ID__: string | undefined;

const BUILD_ID =
  typeof __MCP_DISPATCHER_BUILD_ID__ !== 'undefined' && __MCP_DISPATCHER_BUILD_ID__
    ? __MCP_DISPATCHER_BUILD_ID__
    : 'baked-dev';

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
let callFirst: ApiRuntime['callFirst'];
let readFirstPath: ApiRuntime['readFirstPath'];
let inspectApiInventory: ApiRuntime['inspectApiInventory'];
let callAllowedApi: ApiRuntime['callAllowedApi'];
let boardInspection: BoardInspectionOperations;
let canvasOperations: CanvasOperations;
let designRuleCheckOperations: DesignRuleCheckOperations;
let exportOperations: ExportOperations;
let pcbMutationOperations: PcbMutationOperations;
let pcbReadOperations: PcbReadOperations;
let pcbWriteOperations: PcbWriteOperations;
let projectOperations: ProjectOperations;
let schematicComponentInspection: SchematicComponentInspectionOperations;
let schematicInspection: SchematicInspectionOperations;
let schematicTransactionOperations: SchematicTransactionOperations;

function newBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  const error = new Error(message);
  Object.assign(error, { code, suggestion, data });
  return error;
}

function nativeScalarString(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

/**
 * Best-effort extraction of a primitive id from a value returned by an EasyEDA
 * Pro create* API. The runtime may return a plain object with primitiveId/uuid,
 * or a primitive wrapper exposing getState_PrimitiveId()/getState().PrimitiveId.
 */
function extractPrimitiveId(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const obj = result as Record<string, unknown>;
  const direct = nativeScalarString(obj.primitiveId ?? obj.uuid);
  if (direct) return direct;
  try {
    const getter = obj.getState_PrimitiveId;
    if (typeof getter === 'function') {
      const id = nativeScalarString((getter as () => unknown).call(obj));
      if (id) return id;
    }
  } catch {
    /* ignore */
  }
  try {
    const getState = obj.getState;
    if (typeof getState === 'function') {
      const state = (getState as () => unknown).call(obj) as Record<string, unknown> | undefined;
      const id = nativeScalarString(state?.PrimitiveId);
      if (id) return id;
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

async function generateBomApi(params: any): Promise<unknown> {
  const comps = ((await schematicComponentInspection.listComponents()) as { items: any[] }).items;
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
  return nativeScalarString(value);
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
  return nativeScalarString(value);
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
  const pinPrimitiveId =
    extractPrimitiveId(pin) || nativeScalarString(safeGetState(pin, 'PrimitiveId'));
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
    await (doneTarget as { done: () => unknown }).done();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Find schematic pins whose (designator, pinNumber) does not appear in any
 * inferred net's node list. Pins are omitted only when EasyEDA's native
 * NoConnected state is read successfully as the strict boolean `true`;
 * missing, malformed, string, and numeric values remain eligible so inference
 * fails conservatively instead of hiding a real floating pin.
 *
 * Shared by schematic.validateNetlist and the ERC enhancement in design.erc —
 * see the comment at validateNetlist's call site for why connectivity is read
 * from listNetsApi()'s authoritative net data rather than by re-reading each
 * pin's OtherProperty.net.
 */
function isConfirmedNativeNoConnect(pin: unknown): boolean {
  return safeGetState(pin, 'NoConnected') === true;
}

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
      if (isConfirmedNativeNoConnect(p)) continue;
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
      return projectOperations.open(params);
    case 'project.save':
      return projectOperations.save(params);
    case 'project.export':
      return projectOperations.export(params);
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
      return schematicTransactionOperations.getPrimitiveSnapshot(
        params.primitiveId as string,
        typeof params.expectedPrimitiveKind === 'string'
          ? (params.expectedPrimitiveKind as SchematicPrimitiveSnapshotKind)
          : undefined,
      );
    case 'schematic.listPrimitiveIds':
      return schematicTransactionOperations.listPrimitiveIds(params.primitiveKind);
    case 'schematic.listComponents':
      return schematicComponentInspection.listComponents(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'schematic.getSheetInfo':
      return schematicInspection.getSheetInfo();
    case 'schematic.primitiveBounds':
      return schematicInspection.primitiveBounds(params.primitiveIds);
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
    case 'schematic.listRectangles':
      return schematicInspection.listRectangles();
    case 'schematic.deletePrimitive':
      return schematicTransactionOperations.deletePrimitives(params.primitiveIds);
    case 'schematic.recreatePrimitiveSnapshot':
      return schematicTransactionOperations.recreatePrimitiveSnapshot(params.snapshot);
    case 'schematic.restorePrimitiveSnapshot':
      return schematicTransactionOperations.restorePrimitiveSnapshot(params.snapshot);
    case 'schematic.modifyPrimitive':
      return schematicTransactionOperations.modifyPrimitive(
        params.primitiveId as string,
        (params.property as Record<string, unknown>) || {},
      );
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
        const drc = await designRuleCheckOperations.runSchematicCheck();
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
      return boardInspection.listLayers();
    case 'board.getStackup':
      return boardInspection.getStackup();
    case 'board.getDimensions':
      return boardInspection.getDimensions();
    case 'board.getFeatures':
      return boardInspection.getFeatures();
    case 'board.exportGerbers':
      return exportOperations.exportGerbers(params);
    case 'pcb.exportRouteContext':
      return exportOperations.exportRouteContext(params);
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
      const comps = ((await schematicComponentInspection.listComponents()) as { items: any[] })
        .items;
      return { totalParts: comps.length, missing: [], obsolete: [], alternates: [] };
    }
    case 'inventory.search':
      return [];
    case 'inventory.getPrice':
      return null;
    case 'design.ruleCheck':
      return designRuleCheckOperations.runRuleCheck();
    case 'design.erc':
      return designRuleCheckOperations.runErc();
    case 'design.drc':
      return designRuleCheckOperations.runDrc();
    case 'export.pickPlace':
      return exportOperations.exportPickPlace(params);
    case 'export.pdf':
      return exportOperations.exportPdf(params);
    case 'export.netlist':
      return exportOperations.exportNetlist(params);
    case 'canvas.capture':
      return canvasOperations.capture(params);
    case 'canvas.captureRegion':
      return canvasOperations.captureRegion(params);
    case 'canvas.locate':
      return canvasOperations.locate(params);
    case 'library.getDeviceByLcscId': {
      const lcscId = String(params.lcscId ?? '');
      const libraryUuid = typeof params.libraryUuid === 'string' ? params.libraryUuid : undefined;
      return callFirst(['LIB_Device.getByLcscIds'], [lcscId], libraryUuid, false);
    }
    case 'pcb.addTrack':
      return pcbWriteOperations.addTrack(params);
    case 'pcb.addText':
      return pcbWriteOperations.addText(params);
    case 'pcb.addSilkscreenLine':
      return pcbWriteOperations.addSilkscreenLine(params);
    case 'pcb.addVia':
      return pcbWriteOperations.addVia(params);
    case 'pcb.addZone':
      return pcbMutationOperations.addZone(params);
    case 'pcb.deleteComponent':
      return pcbMutationOperations.deleteComponents(params);
    case 'pcb.modifyComponent':
      return pcbMutationOperations.modifyComponent(params);
    case 'pcb.listComponents':
      return pcbReadOperations.listComponents(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'pcb.listTracks':
      return pcbReadOperations.listTracks(
        typeof params.limit === 'number' ? params.limit : undefined,
        typeof params.offset === 'number' ? params.offset : 0,
      );
    case 'pcb.listVias':
      return pcbReadOperations.listVias(
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
  ({ callFirst, readFirstPath, inspectApiInventory, callAllowedApi } = createApiRuntime(
    toolkit,
    newBridgeError,
  ));
  boardInspection = createBoardInspectionOperations({
    readFirstPath,
    getGlobal: () => toolkit.getGlobal(),
    createBridgeError: newBridgeError,
  });
  const normalizeBinaryResult = createBinaryResultNormalizer({
    getBridgeMaxPayloadSize: () => toolkit.getBridgeMaxPayloadSize(),
    createBridgeError: newBridgeError,
  });
  canvasOperations = createCanvasOperations({
    callFirst,
    normalizeBinaryResult,
    createBridgeError: newBridgeError,
  });
  designRuleCheckOperations = createDesignRuleCheckOperations({
    callFirst,
    createBridgeError: newBridgeError,
    logRecoverableError,
    errorMessage,
    findFloatingPins: findFloatingPinsApi,
  });
  exportOperations = createExportOperations({ callFirst, normalizeBinaryResult });
  pcbReadOperations = createPcbReadOperations({
    requireActivePcbContext: () => boardInspection.requireActivePcbContext(),
    readFirstPath,
    readState: safeGetState,
  });
  pcbMutationOperations = createPcbMutationOperations({
    callFirst,
    deletePrimitives: (ids) => pcbReadOperations.deletePrimitives(ids),
  });
  pcbWriteOperations = createPcbWriteOperations({
    callFirst,
    extractPrimitiveId,
    createBridgeError: newBridgeError,
  });
  projectOperations = createProjectOperations({ callFirst });
  schematicComponentInspection = createSchematicComponentInspectionOperations({
    readFirstPath,
    readState: safeGetState,
  });
  schematicInspection = createSchematicInspectionOperations({
    callFirst,
    readFirstPath,
    readState: safeGetState,
    extractPrimitiveId,
    createBridgeError: newBridgeError,
  });
  schematicTransactionOperations = createSchematicTransactionOperations({
    callFirst,
    readFirstPath,
    readState: safeGetState,
    extractPrimitiveId,
    readComponentType,
    readPinPoint,
    createBridgeError: newBridgeError,
    logRecoverableError,
    asPublicTextAlignMode,
    requirePublicTextAlignMode,
    getCachedTextAlignMode: (primitiveId) => textAlignModeCache.get(primitiveId),
    setCachedTextAlignMode: (primitiveId, alignMode) =>
      textAlignModeCache.set(primitiveId, alignMode),
    deleteCachedTextAlignMode: (primitiveId) => textAlignModeCache.delete(primitiveId),
  });
  textAlignModeCache.clear();
  log(`dispatcher initialized (build ${BUILD_ID}, ${METHOD_LIST.length} methods)`);
  return {
    dispatch,
    methodList: [...METHOD_LIST],
    buildId: BUILD_ID,
  };
}

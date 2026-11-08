import type { ApiRuntime } from './api-runtime.js';
import { createSchematicSnapshotRecreator } from './schematic-snapshot-recreation.js';
import { isRecord } from './utils.js';

export type PublicTextAlignMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type SchematicPrimitiveSnapshotKind =
  'component' | 'netflag' | 'netport' | 'wire' | 'text' | 'rectangle' | 'circle' | 'polygon';

export interface SchematicPrimitiveSnapshot {
  schemaVersion: 'schematic-primitive-snapshot/v1';
  primitiveId: string;
  primitiveKind: SchematicPrimitiveSnapshotKind;
  componentType?: string;
  property: Record<string, unknown>;
}

export interface SchematicTransactionDependencies {
  callFirst: ApiRuntime['callFirst'];
  readFirstPath: ApiRuntime['readFirstPath'];
  readState(source: unknown, key: string): unknown;
  extractPrimitiveId(source: unknown): string;
  readComponentType(source: unknown): string;
  readPinPoint(source: unknown): { x?: number; y?: number; rotation?: number };
  createBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error;
  logRecoverableError(message: string, error: unknown): void;
  asPublicTextAlignMode(value: unknown): PublicTextAlignMode | undefined;
  requirePublicTextAlignMode(value: unknown, field?: string): PublicTextAlignMode;
  getCachedTextAlignMode(primitiveId: string): PublicTextAlignMode | undefined;
  setCachedTextAlignMode(primitiveId: string, alignMode: PublicTextAlignMode): void;
  deleteCachedTextAlignMode(primitiveId: string): void;
}

export interface SchematicTransactionOperations {
  getPrimitiveSnapshot(
    primitiveId: string,
    expectedPrimitiveKind?: SchematicPrimitiveSnapshotKind,
  ): Promise<SchematicPrimitiveSnapshot>;
  listPrimitiveIds(
    primitiveKind: unknown,
  ): Promise<{ primitiveKind: SchematicPrimitiveSnapshotKind; primitiveIds: string[] }>;
  deletePrimitives(
    primitiveIds: unknown,
  ): Promise<{ success: boolean; deleted: string[]; notFound: string[] }>;
  recreatePrimitiveSnapshot(
    snapshot: unknown,
  ): Promise<{ primitiveId: string; snapshot: SchematicPrimitiveSnapshot }>;
  restorePrimitiveSnapshot(
    snapshot: unknown,
  ): Promise<{ restored: true; snapshot: SchematicPrimitiveSnapshot }>;
  modifyPrimitive(primitiveId: string, property: Record<string, unknown>): Promise<unknown>;
}

interface TextPrimitiveRead {
  publicCurrent?: unknown;
  persistentCurrent?: unknown;
  className: string;
}

type SchematicPoint = { x: number; y: number };

interface TextSnapshotRead {
  candidateFound: boolean;
  snapshot?: SchematicPrimitiveSnapshot;
}

type ModifyAttempt = { handled: false } | { handled: true; value: unknown };

const NOT_HANDLED: ModifyAttempt = { handled: false };

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

function handled(value: unknown): ModifyAttempt {
  return { handled: true, value };
}

/** A pin may touch a wire *between* native vertices (T-junction or stub).
 * Endpoint-only checks can silently treat that connected pin as unwired.
 * Keep this conservative: near-contact or non-finite arithmetic refuses moves.
 */
function pinTouchesSegment(pin: SchematicPoint, a: SchematicPoint, b: SchematicPoint): boolean {
  const x = pin.x - a.x;
  const y = pin.y - a.y;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const cross = x * dy - y * dx;
  const along = x * dx + y * dy;
  // A zero-length segment conservatively matches every pin, refusing the move.
  if (!Number.isFinite(length + cross + along)) return true;
  const edge = 0.001 * length;
  return Math.abs(cross) <= edge && Math.min(along, length * length - along) >= -edge;
}

/** Inspect actual wire geometry without trying to rewrite wires. The native
 * modify API can return success while dropping/merging wire segments (#945).
 * Unknown shapes must not be mistaken for an unconnected schematic. */
function readWirePoints(rawLine: unknown): SchematicPoint[] | undefined {
  if (!Array.isArray(rawLine) || rawLine.length < 2) return undefined;
  const values = Array.isArray(rawLine[0])
    ? rawLine.map((pair: unknown) => (Array.isArray(pair) && pair.length === 2 ? pair : undefined))
    : rawLine.length >= 4 && rawLine.length % 2 === 0
      ? Array.from({ length: rawLine.length / 2 }, (_, i) => [rawLine[i * 2], rawLine[i * 2 + 1]])
      : [];
  if (
    values.length < 2 ||
    values.some((v) => !v || !v.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))
  ) {
    return undefined;
  }
  return (values as number[][]).map(([x, y]) => ({ x, y }));
}

function compactDefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function componentKindFromType(componentType: string): SchematicPrimitiveSnapshotKind {
  if (componentType === 'netflag') return 'netflag';
  if (componentType === 'netport') return 'netport';
  return 'component';
}

function schematicPrimitiveClassPaths(kind: SchematicPrimitiveSnapshotKind): string[] {
  switch (kind) {
    case 'component':
    case 'netflag':
    case 'netport':
      return COMPONENT_CLASS_PATHS;
    case 'wire':
      return WIRE_CLASS_PATHS;
    case 'text':
      return TEXT_CLASS_PATHS;
    case 'rectangle':
      return RECTANGLE_CLASS_PATHS;
    case 'circle':
      return CIRCLE_CLASS_PATHS;
    case 'polygon':
      return POLYGON_CLASS_PATHS;
  }
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

function supportsGetAndModify(primitiveClass: any): boolean {
  return (
    Boolean(primitiveClass) &&
    typeof primitiveClass.get === 'function' &&
    typeof primitiveClass.modify === 'function'
  );
}

function supportsTextModify(primitiveClass: any): boolean {
  return (
    Boolean(primitiveClass) &&
    typeof primitiveClass.modify === 'function' &&
    (typeof primitiveClass.getAll === 'function' || typeof primitiveClass.get === 'function')
  );
}

function componentMoveOrigin(
  oldX: unknown,
  oldY: unknown,
  property: Record<string, unknown>,
): SchematicPoint | undefined {
  const changesCoordinate =
    (typeof property.x === 'number' && property.x !== oldX) ||
    (typeof property.y === 'number' && property.y !== oldY);
  if (typeof oldX === 'number' && typeof oldY === 'number' && changesCoordinate) {
    return { x: oldX, y: oldY };
  }
  return undefined;
}

export function createSchematicTransactionOperations(
  dependencies: SchematicTransactionDependencies,
): SchematicTransactionOperations {
  const {
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
  } = dependencies;
  const snapshotRecreator = createSchematicSnapshotRecreator({
    callFirst,
    createBridgeError: newBridgeError,
    requirePublicTextAlignMode,
  });

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
      dependencies.setCachedTextAlignMode(primitiveId, publicAlignMode);
      return publicAlignMode;
    }
    return dependencies.getCachedTextAlignMode(primitiveId);
  }

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

  async function readPersistentTextPrimitive(
    primitiveClass: any,
    path: string,
    primitiveId: string,
  ) {
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
      const persistentCurrent = await readPersistentTextPrimitive(
        primitiveClass,
        path,
        primitiveId,
      );
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
    const rectangle = await readClassSnapshot(
      primitiveId,
      RECTANGLE_CLASS_PATHS,
      rectangleSnapshot,
    );
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
    if (snapshot === null) {
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
    return snapshot;
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
          primitiveKind === 'component' ||
          primitiveKind === 'netflag' ||
          primitiveKind === 'netport'
            ? (await primitiveClass.getAll(undefined, true)) || []
            : (await primitiveClass.getAll()) || [];
      } catch (error) {
        logRecoverableError(`failed to list ${primitiveKind} primitives`, error);
      }
    }

    if (values.length === 0 && typeof primitiveClass.getAllPrimitiveId === 'function') {
      try {
        const primitiveIds = ((await primitiveClass.getAllPrimitiveId()) || [])
          .filter(
            (value: unknown): value is string => typeof value === 'string' && value.length > 0,
          )
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
      dependencies.deleteCachedTextAlignMode(primitiveId);
      deleted.push(primitiveId);
    }
    return { success: notFound.length === 0, deleted, notFound };
  }

  async function recreateSchematicPrimitiveSnapshot(
    input: unknown,
  ): Promise<{ primitiveId: string; snapshot: SchematicPrimitiveSnapshot }> {
    const snapshot = parseSchematicPrimitiveSnapshot(input);
    const before = new Set((await listSchematicPrimitiveIds(snapshot.primitiveKind)).primitiveIds);
    const result = await snapshotRecreator.create(snapshot);

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

  function failUnverifiedMove(reason: string): never {
    throw newBridgeError(
      'MOVE_CONNECTIVITY_UNVERIFIED',
      reason,
      'Inspect the schematic before moving.',
    );
  }

  /** No mutation starts until the native pin inventory is complete. */
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
    } catch (error) {
      logRecoverableError(`failed to read pins for ${primitiveId}`, error);
      failUnverifiedMove('Cannot verify native pins; move refused.');
    }
    if (!Array.isArray(pins) || pins.length === 0) {
      failUnverifiedMove('Pin inventory incomplete; move refused.');
    }
    const points: SchematicPoint[] = [];
    for (const pin of pins) {
      const point = readPinPoint(pin);
      if (
        typeof point.x !== 'number' ||
        typeof point.y !== 'number' ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      ) {
        failUnverifiedMove('Pin coordinates unknown; move refused.');
      }
      points.push({ x: point.x, y: point.y });
    }
    return points;
  }

  /**
   * Conservative preflight for #945. Native wire.modify reportedly re-routes
   * nets even when it reports success; do not move a connected component and
   * then attempt to repair connections using that API. Refuse before ANY write.
   * Inspect every wire segment, not only vertices: a pin may land at a T-junction.
   * Unwired moves remain possible when pin and wire inventories are complete.
   */
  async function assertSafeUnwiredMove(
    oldPinPoints: SchematicPoint[],
    dx: number,
    dy: number,
  ): Promise<void> {
    const wireApi = readFirstPath<any>(WIRE_CLASS_PATHS);
    if (!wireApi || typeof wireApi.getAll !== 'function') {
      failUnverifiedMove('Native wire API unavailable; move refused.');
    }
    let wires: unknown;
    try {
      wires = await wireApi.getAll();
    } catch (error) {
      logRecoverableError('failed to preflight wires before a component move', error);
      failUnverifiedMove('Wire read failed; move refused.');
    }
    if (!Array.isArray(wires)) {
      failUnverifiedMove('Wire inventory incomplete; move refused.');
    }
    const candidatePinPoints = [
      ...oldPinPoints,
      ...oldPinPoints.map(({ x, y }) => ({ x: x + dx, y: y + dy })),
    ];
    for (const wire of wires) {
      const wirePoints = readWirePoints(safeGetState(wire, 'Line'));
      if (!wirePoints) {
        failUnverifiedMove('Wire geometry unknown; move refused.');
      }
      if (
        candidatePinPoints.some((pin) =>
          wirePoints.some(
            (point, index) => index > 0 && pinTouchesSegment(pin, wirePoints[index - 1], point),
          ),
        )
      ) {
        const wireId = extractPrimitiveId(wire);
        throw newBridgeError(
          'CONNECTED_COMPONENT_MOVE_UNSAFE',
          'Connected move blocked: native wire-follow can corrupt nets.',
          'Place before wiring, or reconnect manually.',
          { wireId: wireId || '<unknown>' },
        );
      }
    }
  }

  async function readModificationCurrent(
    primitiveClass: any,
    primitiveId: string,
    className: string,
  ): Promise<unknown> {
    try {
      return await primitiveClass.get(primitiveId);
    } catch (error) {
      logRecoverableError(`${className}.get(${primitiveId}) failed`, error);
      return undefined;
    }
  }

  function componentModificationProperties(
    current: unknown,
    property: Record<string, unknown>,
  ): { merged: Record<string, unknown>; oldX: unknown; oldY: unknown } {
    const existingOther =
      (safeGetState(current, 'OtherProperty') as Record<string, unknown> | undefined) || {};
    const incomingOther = property.otherProperty as Record<string, unknown> | undefined;
    const oldX = safeGetState(current, 'X');
    const oldY = safeGetState(current, 'Y');
    return {
      oldX,
      oldY,
      merged: {
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
      },
    };
  }

  async function tryModifyComponent(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<ModifyAttempt> {
    const primitiveClass = readFirstPath<any>(COMPONENT_CLASS_PATHS);
    if (!supportsGetAndModify(primitiveClass)) return NOT_HANDLED;

    const current = await readModificationCurrent(
      primitiveClass,
      primitiveId,
      'SCH_PrimitiveComponent',
    );
    if (!current) return NOT_HANDLED;

    const componentType = readComponentType(current);
    if (componentType === 'netflag' || componentType === 'netport') {
      return handled(await applyNetFlagState(current, primitiveId, property));
    }

    const { merged, oldX, oldY } = componentModificationProperties(current, property);
    // Unknown native coordinates must not silently skip the connectivity preflight.
    if (
      (property.x !== undefined || property.y !== undefined) &&
      (!Number.isFinite(oldX) || !Number.isFinite(oldY))
    )
      failUnverifiedMove('Component position or identity unavailable; move refused.');
    const moveOrigin = componentMoveOrigin(oldX, oldY, property);
    if (moveOrigin) {
      const pins = await getComponentPinCoordinates(primitiveId);
      await assertSafeUnwiredMove(
        pins,
        (merged.x as number) - moveOrigin.x,
        (merged.y as number) - moveOrigin.y,
      );
    }
    const result = await primitiveClass.modify(primitiveId, merged);
    return handled({ result, followedWireIds: [], wireFollowFailures: [] });
  }

  async function tryModifyWire(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<ModifyAttempt> {
    const primitiveClass = readFirstPath<any>(WIRE_CLASS_PATHS);
    if (!supportsGetAndModify(primitiveClass)) return NOT_HANDLED;

    const current = await readModificationCurrent(primitiveClass, primitiveId, 'SCH_PrimitiveWire');
    if (!current) return NOT_HANDLED;

    return handled(
      await primitiveClass.modify(primitiveId, {
        line: safeGetState(current, 'Line'),
        net: safeGetState(current, 'Net'),
        color: safeGetState(current, 'Color'),
        lineWidth: safeGetState(current, 'LineWidth'),
        lineType: safeGetState(current, 'LineType'),
        ...property,
      }),
    );
  }

  function textModificationProperties(
    text: TextPrimitiveRead,
    property: Record<string, unknown>,
    alignMode: PublicTextAlignMode,
  ): Record<string, unknown> {
    const incoming: Record<string, unknown> = { ...property };
    if (incoming.color !== undefined) incoming.textColor = incoming.color;
    if (incoming.underline !== undefined) incoming.underLine = incoming.underline;
    delete incoming.color;
    delete incoming.underline;
    incoming.alignMode = alignMode;

    return {
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
  }

  async function tryModifyText(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<ModifyAttempt> {
    const primitiveClass = readFirstPath<any>(TEXT_CLASS_PATHS);
    if (!supportsTextModify(primitiveClass)) return NOT_HANDLED;

    const text = await readTextPrimitiveFromClass(TEXT_CLASS_PATHS, primitiveId);
    if (!text) return NOT_HANDLED;

    let requestedAlignMode: PublicTextAlignMode | undefined;
    if (Object.prototype.hasOwnProperty.call(property, 'alignMode')) {
      requestedAlignMode = requirePublicTextAlignMode(property.alignMode);
    }
    const alignMode = requestedAlignMode ?? resolvePublicTextAlignMode(text, primitiveId);
    if (alignMode === undefined) {
      throw newBridgeError(
        'UNSUPPORTED_RUNTIME',
        `Text ${primitiveId} did not expose a public alignMode`,
        'Read the text after reloading the document, or provide alignMode explicitly using a value from 1 through 9.',
      );
    }

    const result = await primitiveClass.modify(
      primitiveId,
      textModificationProperties(text, property, alignMode),
    );
    const resultAlignMode = asPublicTextAlignMode(safeGetState(result, 'AlignMode'));
    dependencies.setCachedTextAlignMode(primitiveId, resultAlignMode ?? alignMode);
    return handled(result);
  }

  async function tryModifyCircle(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<ModifyAttempt> {
    const primitiveClass = readFirstPath<any>(CIRCLE_CLASS_PATHS);
    if (!supportsGetAndModify(primitiveClass)) return NOT_HANDLED;

    const current = await readModificationCurrent(
      primitiveClass,
      primitiveId,
      'SCH_PrimitiveCircle',
    );
    if (!current) return NOT_HANDLED;

    return handled(
      await primitiveClass.modify(primitiveId, {
        centerX: safeGetState(current, 'CenterX'),
        centerY: safeGetState(current, 'CenterY'),
        radius: safeGetState(current, 'Radius'),
        color: safeGetState(current, 'Color'),
        fillColor: safeGetState(current, 'FillColor'),
        lineWidth: safeGetState(current, 'LineWidth'),
        lineType: safeGetState(current, 'LineType'),
        fillStyle: safeGetState(current, 'FillStyle'),
        ...property,
      }),
    );
  }

  async function tryModifyPolygon(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<ModifyAttempt> {
    const primitiveClass = readFirstPath<any>(POLYGON_CLASS_PATHS);
    if (!supportsGetAndModify(primitiveClass)) return NOT_HANDLED;

    const current = await readModificationCurrent(
      primitiveClass,
      primitiveId,
      'SCH_PrimitivePolygon',
    );
    if (!current) return NOT_HANDLED;

    return handled(
      await primitiveClass.modify(primitiveId, {
        line: safeGetState(current, 'Line'),
        color: safeGetState(current, 'Color'),
        fillColor: safeGetState(current, 'FillColor'),
        lineWidth: safeGetState(current, 'LineWidth'),
        lineType: safeGetState(current, 'LineType'),
        ...property,
      }),
    );
  }

  async function modifyPrimitive(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<unknown> {
    const handlers = [
      tryModifyComponent,
      tryModifyWire,
      tryModifyText,
      tryModifyCircle,
      tryModifyPolygon,
    ];
    for (const handler of handlers) {
      const attempt = await handler(primitiveId, property);
      if (attempt.handled) return attempt.value;
    }

    // Do not bypass the component move guard through the untyped native fallback.
    if (property.x !== undefined || property.y !== undefined)
      failUnverifiedMove('Component position or identity unavailable; move refused.');
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

  async function restorePrimitiveSnapshot(
    input: unknown,
  ): Promise<{ restored: true; snapshot: SchematicPrimitiveSnapshot }> {
    const snapshot = parseSchematicPrimitiveSnapshot(input);
    await modifyPrimitive(snapshot.primitiveId, snapshot.property);
    return {
      restored: true,
      snapshot: await getSchematicPrimitiveSnapshot(snapshot.primitiveId),
    };
  }

  return {
    getPrimitiveSnapshot: getSchematicPrimitiveSnapshot,
    listPrimitiveIds: listSchematicPrimitiveIds,
    deletePrimitives: deleteSchematicPrimitives,
    recreatePrimitiveSnapshot: recreateSchematicPrimitiveSnapshot,
    restorePrimitiveSnapshot,
    modifyPrimitive,
  };
}

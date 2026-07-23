import type { ApiRuntime } from './api-runtime.js';
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

  function pointKey(point: SchematicPoint): string {
    return `${Math.round(point.x * 1000) / 1000},${Math.round(point.y * 1000) / 1000}`;
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

  async function primitiveExistsInClass(
    primitiveClass: any,
    primitiveId: string,
  ): Promise<boolean> {
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
      dependencies.deleteCachedTextAlignMode(primitiveId);
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
      case 'component':
      case 'netflag':
      case 'netport':
        throw newBridgeError(
          'UNSUPPORTED_RUNTIME',
          `Delete rollback is not supported for ${snapshot.primitiveKind} primitives`,
          'Use transaction-backed modify, or avoid deleting components/net flags/net ports until a complete creation descriptor is available.',
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

  async function modifyPrimitive(
    primitiveId: string,
    property: Record<string, unknown>,
  ): Promise<unknown> {
    // The native SCH_PrimitiveComponent.modify/SCH_PrimitiveWire.modify APIs
    // reset any property field omitted from the call rather than leaving it
    // unchanged (e.g. passing only `{ designator }` wipes manufacturer/
    // supplier/otherProperty). To make partial updates behave like partial
    // updates, snapshot the primitive's current state first and merge the
    // caller's partial property over it before writing.
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
          const dx = (merged.x as number) - oldX;
          const dy = (merged.y as number) - oldY;
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
        dependencies.setCachedTextAlignMode(primitiveId, resultAlignMode ?? alignMode);
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

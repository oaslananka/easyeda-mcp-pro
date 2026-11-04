import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { DispatcherToolkit } from './toolkit.js';
import {
  isBoardOutlineLayer,
  primitiveIsOnBoardOutline,
  readFiniteNumber,
  readPrimitiveState,
} from './pcb-primitive-state.js';
import { isRecord, logRecoverableError, readPath } from './utils.js';

export interface BoardInspectionDependencies {
  readFirstPath: ApiRuntime['readFirstPath'];
  getGlobal: DispatcherToolkit['getGlobal'];
  createBridgeError: BridgeErrorFactory;
}

export interface BoardInspectionOperations {
  requireActivePcbContext(): Promise<void>;
  listLayers(): Promise<unknown>;
  getStackup(): Promise<unknown>;
  getDesignRules(): Promise<unknown>;
  getDimensions(): Promise<unknown>;
  getFeatures(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PCB_MIL_TO_MM = 0.0254;

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function pcbMilToMm(value: number): number {
  return roundMetric(value * PCB_MIL_TO_MM);
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

function selectPhysicalStackupLayers(physicalStacking: any): any[] {
  if (Array.isArray(physicalStacking?.layers)) return physicalStacking.layers;
  if (Array.isArray(physicalStacking?.stackup)) return physicalStacking.stackup;
  return [];
}

function readBoardThickness(physicalStacking: any): number | undefined {
  if (typeof physicalStacking?.thicknessMm === 'number') return physicalStacking.thicknessMm;
  if (typeof physicalStacking?.thickness === 'number') return physicalStacking.thickness;
  return undefined;
}

function readSafeSpacingValues(ruleConfiguration: unknown): {
  count: number;
  minimumMm?: number;
  matrixNames: string[];
} {
  if (!isRecord(ruleConfiguration)) return { count: 0, matrixNames: [] };
  const configuration = isRecord(ruleConfiguration.config)
    ? ruleConfiguration.config
    : ruleConfiguration;
  const spacing = isRecord(configuration.Spacing) ? configuration.Spacing : undefined;
  const safeSpacing =
    spacing && isRecord(spacing['Safe Spacing']) ? spacing['Safe Spacing'] : undefined;
  if (!safeSpacing) return { count: 0, matrixNames: [] };

  const activeMatrices = Object.entries(safeSpacing).filter(
    (entry): entry is [string, Record<string, unknown>] => {
      const value = entry[1];
      return isRecord(value) && value.isSetDefault === true && Array.isArray(value.table);
    },
  );
  const values = activeMatrices.flatMap(([, matrix]) =>
    (matrix.table as unknown[]).flatMap((row) =>
      Array.isArray(row)
        ? row.filter(
            (value): value is number =>
              typeof value === 'number' && Number.isFinite(value) && value >= 0,
          )
        : [],
    ),
  );
  return {
    count: values.length,
    minimumMm: values.length > 0 ? Math.min(...values) : undefined,
    matrixNames: activeMatrices.map(([name]) => name),
  };
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function createEmptyBoundingBox(): BoundingBox {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
}

function updateBoundingBox(bounds: BoundingBox, x: unknown, y: unknown): void {
  const finiteX = readFiniteNumber(x);
  const finiteY = readFiniteNumber(y);
  if (finiteX === undefined || finiteY === undefined) return;
  if (finiteX < bounds.minX) bounds.minX = finiteX;
  if (finiteX > bounds.maxX) bounds.maxX = finiteX;
  if (finiteY < bounds.minY) bounds.minY = finiteY;
  if (finiteY > bounds.maxY) bounds.maxY = finiteY;
}

async function readPrimitiveStateResolved(value: unknown, key: string): Promise<unknown> {
  try {
    return await readPrimitiveState(value, key);
  } catch (error) {
    logRecoverableError(`failed to read primitive state ${key}`, error);
    return undefined;
  }
}

async function primitiveIsOnBoardOutlineResolved(value: unknown): Promise<boolean> {
  if (primitiveIsOnBoardOutline(value)) return true;
  if (isBoardOutlineLayer(await readPrimitiveStateResolved(value, 'Layer'))) return true;

  for (const key of ['LayerName', 'PrimitiveType', 'Type', 'ObjectType']) {
    if (isBoardOutlineLayer(await readPrimitiveStateResolved(value, key))) return true;
  }
  return false;
}

async function readPointCoordinate(point: unknown, key: 'X' | 'Y'): Promise<unknown> {
  const state = await readPrimitiveStateResolved(point, key);
  if (state !== undefined) return state;
  if (!isRecord(point)) return undefined;
  return await point[key.toLowerCase()];
}

async function addPoint(bounds: BoundingBox, point: unknown): Promise<void> {
  if (Array.isArray(point)) {
    updateBoundingBox(bounds, point[0], point[1]);
    return;
  }
  updateBoundingBox(
    bounds,
    await readPointCoordinate(point, 'X'),
    await readPointCoordinate(point, 'Y'),
  );
}

async function addPoints(bounds: BoundingBox, points: unknown): Promise<boolean> {
  if (!Array.isArray(points)) return false;
  for (const point of points) await addPoint(bounds, point);
  return points.length > 0;
}

async function readPolygonSource(polygon: Record<string, unknown>): Promise<unknown[] | undefined> {
  if (typeof polygon.getSource === 'function') {
    try {
      const source = await polygon.getSource();
      if (Array.isArray(source)) return source;
    } catch (error) {
      logRecoverableError('failed to read board outline polygon source', error);
    }
  }

  const direct = await polygon.polygon;
  return Array.isArray(direct) ? direct : undefined;
}

function readFiniteSourceNumbers(
  source: readonly unknown[],
  startIndex: number,
  count: number,
): number[] | undefined {
  const values = source.slice(startIndex, startIndex + count).map(readFiniteNumber);
  return values.every((value): value is number => value !== undefined) ? values : undefined;
}

function addRectangleSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source.length !== 7) return false;
  const values = readFiniteSourceNumbers(source, 1, 6);
  if (!values) return false;

  const [x, y, width, height, rotation, round] = values;
  if (width < 0 || height < 0 || round < 0 || rotation % 360 !== 0) return false;

  updateBoundingBox(bounds, x, y);
  updateBoundingBox(bounds, x + width, y + height);
  return true;
}

function addCircleSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source.length !== 4) return false;
  const values = readFiniteSourceNumbers(source, 1, 3);
  if (!values) return false;

  const [centerX, centerY, radius] = values;
  if (radius < 0) return false;

  updateBoundingBox(bounds, centerX - radius, centerY - radius);
  updateBoundingBox(bounds, centerX + radius, centerY + radius);
  return true;
}

function addLinePolylineSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  const start = readFiniteSourceNumbers(source, 0, 2);
  if (!start || source[2] !== 'L') return false;

  const coordinates = readFiniteSourceNumbers(source, 3, source.length - 3);
  if (!coordinates || coordinates.length < 2 || coordinates.length % 2 !== 0) return false;

  updateBoundingBox(bounds, start[0], start[1]);
  for (let index = 0; index < coordinates.length; index += 2) {
    updateBoundingBox(bounds, coordinates[index], coordinates[index + 1]);
  }
  return true;
}

function addRawPolygonSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source[0] === 'R') return addRectangleSourceBounds(bounds, source);
  if (source[0] === 'CIRCLE') return addCircleSourceBounds(bounds, source);
  if (readFiniteNumber(source[0]) !== undefined) return addLinePolylineSourceBounds(bounds, source);
  return false;
}

interface DiscretizationAttempt {
  added: boolean;
  error?: unknown;
}

async function tryDiscretize(
  bounds: BoundingBox,
  discretize: (() => unknown) | undefined,
): Promise<DiscretizationAttempt> {
  if (!discretize) return { added: false };
  try {
    return { added: await addPoints(bounds, await discretize()) };
  } catch (error) {
    return { added: false, error };
  }
}

function logPolygonFallbackFailures(
  instanceError: unknown,
  staticError: unknown,
  source: readonly unknown[] | undefined,
): void {
  if (instanceError !== undefined) {
    logRecoverableError('failed to discretize board outline polygon', instanceError);
  }
  if (staticError !== undefined) {
    logRecoverableError(
      'failed to discretize board outline polygon with PCB_MathPolygon',
      staticError,
    );
  }
  if (source) {
    logRecoverableError(
      'unsupported board outline polygon source',
      new Error(`Unsupported or malformed polygon source mode: ${String(source[0])}`),
    );
  }
}

async function addPolygonPoints(
  bounds: BoundingBox,
  polygonValue: unknown,
  pcbMathPolygonClass: any,
): Promise<void> {
  const polygon = await polygonValue;
  if (!isRecord(polygon)) return;

  const instanceDiscretize = polygon.discretize;
  const instance = await tryDiscretize(
    bounds,
    typeof instanceDiscretize === 'function' ? () => instanceDiscretize.call(polygon) : undefined,
  );
  if (instance.added) return;

  const source = await readPolygonSource(polygon);
  const staticDiscretize = pcbMathPolygonClass?.discretize;
  const staticAttempt = await tryDiscretize(
    bounds,
    typeof staticDiscretize === 'function'
      ? () => staticDiscretize.call(pcbMathPolygonClass, source ?? polygon)
      : undefined,
  );
  if (staticAttempt.added) return;
  if (source && addRawPolygonSourceBounds(bounds, source)) return;

  logPolygonFallbackFailures(instance.error, staticAttempt.error, source);
}

async function addPrimitivePoints(
  bounds: BoundingBox,
  primitive: unknown,
  pcbMathPolygonClass: any,
): Promise<void> {
  await addPoints(bounds, await readPrimitiveStateResolved(primitive, 'Points'));
  await addPolygonPoints(
    bounds,
    readPrimitiveStateResolved(primitive, 'Polygon'),
    pcbMathPolygonClass,
  );

  updateBoundingBox(
    bounds,
    await readPrimitiveStateResolved(primitive, 'StartX'),
    await readPrimitiveStateResolved(primitive, 'StartY'),
  );
  updateBoundingBox(
    bounds,
    await readPrimitiveStateResolved(primitive, 'EndX'),
    await readPrimitiveStateResolved(primitive, 'EndY'),
  );
}

async function addOutlinePrimitiveBounds(
  primitiveClass: any,
  bounds: BoundingBox,
  description: string,
  pcbMathPolygonClass: any,
): Promise<void> {
  if (!primitiveClass || typeof primitiveClass.getAll !== 'function') return;
  const primitives = await primitiveClass.getAll();
  if (!Array.isArray(primitives)) throw new Error(`Invalid board outline ${description} inventory`);
  try {
    for (const primitive of primitives) {
      if (!(await primitiveIsOnBoardOutlineResolved(primitive))) continue;
      await addPrimitivePoints(bounds, primitive, pcbMathPolygonClass);
    }
  } catch (error) {
    logRecoverableError(`failed to read board outline ${description}`, error);
  }
}

async function countPrimitiveCollection(
  pcbClass: any,
  description: string,
): Promise<number | undefined> {
  if (!pcbClass || typeof pcbClass.getAll !== 'function') return undefined;
  try {
    const primitives = await pcbClass.getAll();
    return Array.isArray(primitives) ? primitives.length : undefined;
  } catch (error) {
    logRecoverableError(`failed to count ${description}`, error);
    return undefined;
  }
}

interface DrillSummary {
  drilledPadCount?: number;
  platedDrillPadCount?: number;
  unplatedDrillPadCount?: number;
  minDrillMm?: number;
  unknownFields: Array<
    'drilledPadCount' | 'platedDrillPadCount' | 'unplatedDrillPadCount' | 'minDrillMm'
  >;
}

interface DrillAccumulator {
  drilledPadCount: number;
  platedDrillPadCount: number;
  unplatedDrillPadCount: number;
  minDrillMil: number;
  drillCountKnown: boolean;
  metallizationKnown: boolean;
}

type PadDrillState =
  | { status: 'none' }
  | { status: 'unknown' }
  | { status: 'drilled'; diameterMil: number; metallization?: boolean };

function createUnknownDrillSummary(): DrillSummary {
  return {
    drilledPadCount: undefined,
    platedDrillPadCount: undefined,
    unplatedDrillPadCount: undefined,
    minDrillMm: undefined,
    unknownFields: [
      'drilledPadCount',
      'platedDrillPadCount',
      'unplatedDrillPadCount',
      'minDrillMm',
    ],
  };
}

async function readPadDrillState(pad: unknown): Promise<PadDrillState> {
  const hole = await readPrimitiveStateResolved(pad, 'Hole');
  if (hole === null) return { status: 'none' };
  if (!Array.isArray(hole) || (hole[0] !== 'ROUND' && hole[0] !== 'SLOT')) {
    return { status: 'unknown' };
  }

  const diameterMil = readFiniteNumber(hole[1]);
  if (diameterMil === undefined || diameterMil <= 0) return { status: 'unknown' };

  const metallization = await readPrimitiveStateResolved(pad, 'Metallization');
  return {
    status: 'drilled',
    diameterMil,
    metallization: typeof metallization === 'boolean' ? metallization : undefined,
  };
}

function addPadDrillState(summary: DrillAccumulator, drill: PadDrillState): void {
  if (drill.status === 'none') return;
  if (drill.status === 'unknown') {
    summary.drillCountKnown = false;
    summary.metallizationKnown = false;
    return;
  }

  summary.drilledPadCount++;
  summary.minDrillMil = Math.min(summary.minDrillMil, drill.diameterMil);
  if (drill.metallization === undefined) {
    summary.metallizationKnown = false;
  } else if (drill.metallization) {
    summary.platedDrillPadCount++;
  } else {
    summary.unplatedDrillPadCount++;
  }
}

function finalizeDrillSummary(summary: DrillAccumulator): DrillSummary {
  const unknownFields: DrillSummary['unknownFields'] = [];
  if (!summary.drillCountKnown) unknownFields.push('drilledPadCount');
  if (!summary.metallizationKnown) {
    unknownFields.push('platedDrillPadCount', 'unplatedDrillPadCount');
  }
  if (!summary.drillCountKnown) unknownFields.push('minDrillMm');
  return {
    drilledPadCount: summary.drillCountKnown ? summary.drilledPadCount : undefined,
    platedDrillPadCount: summary.metallizationKnown ? summary.platedDrillPadCount : undefined,
    unplatedDrillPadCount: summary.metallizationKnown ? summary.unplatedDrillPadCount : undefined,
    minDrillMm:
      summary.drillCountKnown && Number.isFinite(summary.minDrillMil)
        ? pcbMilToMm(summary.minDrillMil)
        : undefined,
    unknownFields,
  };
}

async function readDrillSummary(pcbPadClass: any): Promise<DrillSummary> {
  if (typeof pcbPadClass?.getAll !== 'function') return createUnknownDrillSummary();

  try {
    const pads = await pcbPadClass.getAll();
    if (!Array.isArray(pads)) return createUnknownDrillSummary();

    const summary: DrillAccumulator = {
      drilledPadCount: 0,
      platedDrillPadCount: 0,
      unplatedDrillPadCount: 0,
      minDrillMil: Infinity,
      drillCountKnown: true,
      metallizationKnown: true,
    };
    for (const pad of pads) addPadDrillState(summary, await readPadDrillState(pad));
    return finalizeDrillSummary(summary);
  } catch (error) {
    logRecoverableError('failed to read PCB pad drill metadata', error);
    return createUnknownDrillSummary();
  }
}

export function createBoardInspectionOperations({
  readFirstPath,
  getGlobal,
  createBridgeError,
}: BoardInspectionDependencies): BoardInspectionOperations {
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
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'PCB data is unavailable in the current editor context.',
        'Open and focus a PCB document, then retry.',
        { cause: errorMessage(error) },
      );
    }
    if (!currentPcb) {
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No active PCB document is focused.',
        'Open and focus a PCB document, then retry.',
      );
    }
  }

  async function listLayers(): Promise<unknown> {
    await requireActivePcbContext();
    const pcbLayerClass = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
    if (!pcbLayerClass || typeof pcbLayerClass.getAllLayers !== 'function') {
      throw new Error('pcb_Layer class or getAllLayers method not found');
    }
    const copperLayerCount = await readCopperLayerCount(pcbLayerClass);
    const rawLayers = await pcbLayerClass.getAllLayers();
    if (!Array.isArray(rawLayers)) {
      throw new Error('PCB_Layer.getAllLayers returned a non-array collection');
    }
    if (rawLayers.some((layer: unknown) => !isRecord(layer))) {
      throw new Error('PCB_Layer.getAllLayers returned a malformed layer record');
    }
    const layers = rawLayers;
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

  async function getStackup(): Promise<unknown> {
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

    const rawLayers = selectPhysicalStackupLayers(physicalStacking);
    const layers = (rawLayers.every(isRecord) ? rawLayers : []).map((layer: any) => ({
      name: layer.name || '',
      type: layer.type || '',
      thicknessMm: typeof layer.thicknessMm === 'number' ? layer.thicknessMm : layer.thickness,
      material: layer.material || '',
      dielectricConstant:
        typeof layer.dielectricConstant === 'number' ? layer.dielectricConstant : layer.dielectric,
      copperWeightOz:
        typeof layer.copperWeightOz === 'number' ? layer.copperWeightOz : layer.copperWeight,
    }));
    const available = layers.length > 0;

    return {
      totalLayers: totalCopper,
      boardThicknessMm: available ? readBoardThickness(physicalStacking) : undefined,
      layers,
      available,
      source: available ? 'physical_stackup' : 'copper_layer_count_only',
    };
  }

  async function getDesignRules(): Promise<unknown> {
    await requireActivePcbContext();
    const drc = readPath<any>(getGlobal(), 'pcb_Drc');
    if (
      typeof drc?.getCurrentRuleConfigurationName !== 'function' ||
      typeof drc?.getRuleConfiguration !== 'function'
    ) {
      return { available: false, source: 'active_rule_configuration' };
    }

    try {
      const configurationName = await drc.getCurrentRuleConfigurationName();
      if (typeof configurationName !== 'string' || configurationName.trim().length === 0) {
        return { available: false, source: 'active_rule_configuration' };
      }
      const configuration = await drc.getRuleConfiguration(configurationName);
      if (!isRecord(configuration)) {
        return {
          available: false,
          activeRuleConfigurationName: configurationName,
          source: 'active_rule_configuration',
        };
      }
      const spacing = readSafeSpacingValues(configuration);
      return {
        available: true,
        activeRuleConfigurationName: configurationName,
        hasClearanceRules: spacing.count > 0 ? true : undefined,
        minimumClearanceMm: spacing.minimumMm,
        clearanceRuleCount: spacing.count > 0 ? spacing.count : undefined,
        activeSpacingMatrices: spacing.matrixNames,
        source: 'active_rule_configuration',
      };
    } catch (error) {
      logRecoverableError('failed to read active PCB design rules', error);
      return { available: false, source: 'active_rule_configuration' };
    }
  }

  async function getDimensions(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
    const pcbLineClass = readPath<any>(globalObj, 'pcb_PrimitiveLine');
    const pcbArcClass = readPath<any>(globalObj, 'pcb_PrimitiveArc');
    const pcbPolylineClass = readPath<any>(globalObj, 'pcb_PrimitivePolyline');
    const pcbPadClass = readPath<any>(globalObj, 'pcb_PrimitivePad');
    const pcbMathPolygonClass = readFirstPath<any>(['PCB_MathPolygon', 'pcb_MathPolygon']);
    const bounds = createEmptyBoundingBox();

    await addOutlinePrimitiveBounds(pcbLineClass, bounds, 'lines', pcbMathPolygonClass);
    await addOutlinePrimitiveBounds(pcbArcClass, bounds, 'arcs', pcbMathPolygonClass);
    await addOutlinePrimitiveBounds(pcbPolylineClass, bounds, 'polylines', pcbMathPolygonClass);

    const widthMil = bounds.maxX > bounds.minX ? bounds.maxX - bounds.minX : 0;
    const heightMil = bounds.maxY > bounds.minY ? bounds.maxY - bounds.minY : 0;
    const width = pcbMilToMm(widthMil);
    const height = pcbMilToMm(heightMil);
    const drillSummary = await readDrillSummary(pcbPadClass);
    const hasOutline = width > 0 && height > 0;

    return {
      widthMm: width,
      heightMm: height,
      shape: hasOutline ? 'custom' : undefined,
      mountingHoleCount: undefined,
      drilledPadCount: drillSummary.drilledPadCount,
      platedDrillPadCount: drillSummary.platedDrillPadCount,
      unplatedDrillPadCount: drillSummary.unplatedDrillPadCount,
      minDrillMm: drillSummary.minDrillMm,
      unknownFields: drillSummary.unknownFields,
      areaMm2: roundMetric(width * height),
      hasOutline,
    };
  }

  async function getFeatures(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
    const counts = await Promise.all(
      [
        ['pcb_PrimitiveVia', 'vias'],
        ['pcb_PrimitiveLine', 'tracks'],
        ['pcb_PrimitivePour', 'zones'],
        ['pcb_PrimitiveFill', 'fills'],
        ['pcb_PrimitiveRegion', 'regions'],
        ['pcb_PrimitivePad', 'pads'],
        ['pcb_PrimitiveComponent', 'PCB components'],
      ].map(([path, description]) =>
        countPrimitiveCollection(readPath<any>(globalObj, path), description),
      ),
    );
    const featureNames = [
      'vias',
      'tracks',
      'zones',
      'fills',
      'regions',
      'pads',
      'components',
    ] as const;
    return {
      vias: counts[0],
      tracks: counts[1],
      zones: counts[2],
      fills: counts[3],
      regions: counts[4],
      pads: counts[5],
      components: counts[6],
      unknownFeatures: featureNames.filter((_, index) => counts[index] === undefined),
    };
  }

  return {
    requireActivePcbContext,
    listLayers,
    getStackup,
    getDesignRules,
    getDimensions,
    getFeatures,
  };
}

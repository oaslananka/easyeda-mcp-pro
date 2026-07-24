import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { DispatcherToolkit } from './toolkit.js';
import {
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
  getDimensions(): Promise<unknown>;
  getFeatures(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function readPointCoordinate(point: unknown, key: 'X' | 'Y'): unknown {
  const state = readPrimitiveState(point, key);
  if (state !== undefined) return state;
  if (!isRecord(point)) return undefined;
  return point[key.toLowerCase()];
}

function addPoint(bounds: BoundingBox, point: unknown): void {
  if (Array.isArray(point)) {
    updateBoundingBox(bounds, point[0], point[1]);
    return;
  }
  updateBoundingBox(bounds, readPointCoordinate(point, 'X'), readPointCoordinate(point, 'Y'));
}

function addPrimitivePoints(bounds: BoundingBox, primitive: unknown): void {
  const points = readPrimitiveState(primitive, 'Points');
  if (Array.isArray(points)) {
    for (const point of points) addPoint(bounds, point);
  }

  updateBoundingBox(
    bounds,
    readPrimitiveState(primitive, 'StartX'),
    readPrimitiveState(primitive, 'StartY'),
  );
  updateBoundingBox(
    bounds,
    readPrimitiveState(primitive, 'EndX'),
    readPrimitiveState(primitive, 'EndY'),
  );
}

async function addOutlinePrimitiveBounds(
  primitiveClass: any,
  bounds: BoundingBox,
  description: string,
): Promise<void> {
  if (!primitiveClass || typeof primitiveClass.getAll !== 'function') return;
  try {
    const primitives = await primitiveClass.getAll();
    for (const primitive of primitives || []) {
      if (!primitiveIsOnBoardOutline(primitive)) continue;
      addPrimitivePoints(bounds, primitive);
    }
  } catch (error) {
    logRecoverableError(`failed to read board outline ${description}`, error);
  }
}

async function countMountingHoles(pcbPadClass: any): Promise<number> {
  if (!pcbPadClass || typeof pcbPadClass.getAll !== 'function') return 0;
  try {
    let mountingHoles = 0;
    const pads = await pcbPadClass.getAll();
    for (const pad of pads || []) {
      const holeType = readPrimitiveState(pad, 'HoleType');
      const holeSize = readFiniteNumber(readPrimitiveState(pad, 'HoleSize')) ?? 0;
      if (holeType === 'MountingHole' || holeSize > 2) mountingHoles++;
    }
    return mountingHoles;
  } catch (error) {
    logRecoverableError('failed to read mounting-hole pads', error);
    return 0;
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
    const layers = rawLayers.map((layer: any) => ({
      name: layer?.name || '',
      type: layer?.type || '',
      thicknessMm: typeof layer?.thicknessMm === 'number' ? layer.thicknessMm : layer?.thickness,
      material: layer?.material || '',
      dielectricConstant:
        typeof layer?.dielectricConstant === 'number'
          ? layer.dielectricConstant
          : layer?.dielectric,
      copperWeightOz:
        typeof layer?.copperWeightOz === 'number' ? layer.copperWeightOz : layer?.copperWeight,
    }));
    const boardThickness = readBoardThickness(physicalStacking);
    const available = Boolean(physicalStacking && layers.length > 0);

    return {
      totalLayers: totalCopper,
      boardThicknessMm: boardThickness,
      layers,
      available,
      source: available ? 'physical_stackup' : 'copper_layer_count_only',
    };
  }

  async function getDimensions(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
    const pcbLineClass = readPath<any>(globalObj, 'pcb_PrimitiveLine');
    const pcbArcClass = readPath<any>(globalObj, 'pcb_PrimitiveArc');
    const pcbPadClass = readPath<any>(globalObj, 'pcb_PrimitivePad');
    const bounds = createEmptyBoundingBox();

    await addOutlinePrimitiveBounds(pcbLineClass, bounds, 'lines');
    await addOutlinePrimitiveBounds(pcbArcClass, bounds, 'arcs');

    const width = bounds.maxX > bounds.minX ? bounds.maxX - bounds.minX : 0;
    const height = bounds.maxY > bounds.minY ? bounds.maxY - bounds.minY : 0;
    const mountingHoles = await countMountingHoles(pcbPadClass);
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

  async function getFeatures(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
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
    } catch (error) {
      logRecoverableError('failed to count vias', error);
    }

    try {
      if (pcbTrackClass && typeof pcbTrackClass.getAll === 'function') {
        tracksCount = (await pcbTrackClass.getAll())?.length || 0;
      }
    } catch (error) {
      logRecoverableError('failed to count tracks', error);
    }

    try {
      if (pcbPadClass && typeof pcbPadClass.getAll === 'function') {
        padsCount = (await pcbPadClass.getAll())?.length || 0;
      }
    } catch (error) {
      logRecoverableError('failed to count pads', error);
    }

    try {
      if (pcbPourClass && typeof pcbPourClass.getAll === 'function') {
        zonesCount = (await pcbPourClass.getAll())?.length || 0;
      }
    } catch (error) {
      logRecoverableError('failed to count zones', error);
    }

    try {
      if (pcbCompClass && typeof pcbCompClass.getAll === 'function') {
        compsCount = (await pcbCompClass.getAll())?.length || 0;
      }
    } catch (error) {
      logRecoverableError('failed to count PCB components', error);
    }

    return {
      vias: viasCount,
      tracks: tracksCount,
      zones: zonesCount,
      pads: padsCount,
      components: compsCount,
    };
  }

  return {
    requireActivePcbContext,
    listLayers,
    getStackup,
    getDimensions,
    getFeatures,
  };
}

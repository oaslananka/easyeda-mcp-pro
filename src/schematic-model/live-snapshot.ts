import { type ToolContext } from '../tools/types.js';
import { fetchComponentPins } from '../tools/schematic-helpers.js';
import type {
  Point,
  RawComponentInput,
  RawNetInput,
  RawSchematicSnapshot,
  RawWireInput,
} from './geometry-model.js';

interface BridgeComponentItem {
  primitiveId?: string;
  reference?: string;
  deviceUuid?: string;
  deviceLibraryUuid?: string;
  deviceName?: string;
  symbolName?: string;
  x?: number;
  y?: number;
  rotation?: number;
}

interface BridgeComponentPage {
  total?: number;
  items?: BridgeComponentItem[];
}

interface BridgeNetNode {
  component?: string;
  pin?: string;
}

interface BridgeNet {
  netName?: string;
  nodes?: BridgeNetNode[];
}

interface BridgeWireSample {
  primitiveId?: string;
  line?: number[];
  net?: string;
}

interface BridgeWirePage {
  total?: number;
  samples?: BridgeWireSample[];
}

/** `system.inspectWires` returns a flat [x1,y1,x2,y2,...] polyline per wire. */
function wirePointsFromLine(line: number[] | undefined): Point[] {
  const points: Point[] = [];
  if (!line) return points;
  for (let i = 0; i + 1 < line.length; i += 2) {
    const x = line[i];
    const y = line[i + 1];
    if (x === undefined || y === undefined) continue;
    points.push({ x, y });
  }
  return points;
}

export interface GatherLiveSchematicSnapshotOptions {
  /** Page size used when paging schematic.listComponents. */
  pageSize?: number;
}

/**
 * Reads every component (with per-component pins) and net from the live bridge and
 * assembles a RawSchematicSnapshot suitable for buildSchematicModel.
 *
 * There is no bulk pins-for-all-components bridge method, so this issues one
 * `api.call SCH_PrimitiveComponent.getAllPinsByPrimitiveId` round-trip per component
 * (via fetchComponentPins) -- the same sequential pattern already used in production
 * by scanSheetForPinCollisions (src/workflows/collision.ts) for the same reason.
 */
export async function gatherLiveSchematicSnapshot(
  ctx: ToolContext,
  projectId: string,
  options: GatherLiveSchematicSnapshotOptions = {},
): Promise<RawSchematicSnapshot> {
  const pageSize = options.pageSize ?? 500;
  const componentItems: BridgeComponentItem[] = [];
  let offset = 0;
  for (;;) {
    const page = await ctx.bridge.call<
      { projectId: string; limit: number; offset: number },
      BridgeComponentPage
    >('schematic.listComponents', { projectId, limit: pageSize, offset });
    const items = page?.items ?? [];
    componentItems.push(...items);
    const total = page?.total ?? items.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }

  const components: RawComponentInput[] = [];
  for (const item of componentItems) {
    if (!item.primitiveId) continue;
    const pins = await fetchComponentPins(ctx, item.primitiveId);
    components.push({
      runtimePrimitiveId: item.primitiveId,
      reference: item.reference,
      deviceName: item.deviceName,
      symbolName: item.symbolName,
      position: item.x !== undefined && item.y !== undefined ? { x: item.x, y: item.y } : undefined,
      pins: pins.map((pin) => ({
        number: pin.pinNumber,
        name: pin.pinName,
        electricalType: pin.pinType,
        position: { x: pin.x, y: pin.y },
        raw: { rotation: pin.rotation, pinLength: pin.pinLength },
      })),
      raw: {
        rotation: item.rotation,
        deviceUuid: item.deviceUuid,
        deviceLibraryUuid: item.deviceLibraryUuid,
      },
    });
  }

  const rawNets = await ctx.bridge.call<{ projectId: string }, BridgeNet[]>('schematic.listNets', {
    projectId,
  });

  const nets: RawNetInput[] = (rawNets ?? []).map((net) => ({
    name: net.netName,
    nodes: (net.nodes ?? []).map((node) => ({
      componentReference: node.component,
      pinNumber: node.pin,
    })),
  }));

  const wireSamples: BridgeWireSample[] = [];
  const wirePageSize = 50;
  let wireOffset = 0;
  for (;;) {
    const page = await ctx.bridge.call<{ limit: number; offset: number }, BridgeWirePage>(
      'system.inspectWires',
      { limit: wirePageSize, offset: wireOffset },
    );
    const samples = page?.samples ?? [];
    wireSamples.push(...samples);
    const total = page?.total ?? samples.length;
    wireOffset += samples.length;
    if (samples.length === 0 || wireOffset >= total) break;
  }

  const wires: RawWireInput[] = wireSamples
    .filter((wire): wire is BridgeWireSample & { primitiveId: string } => !!wire.primitiveId)
    .map((wire) => ({
      runtimePrimitiveId: wire.primitiveId,
      netName: wire.net || undefined,
      points: wirePointsFromLine(wire.line),
    }));

  return {
    document: { projectId },
    components,
    nets,
    wires,
  };
}

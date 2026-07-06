/**
 * Floorplan stage: translate CircuitIR physical constraints into a
 * `planComponentGroupPlacement`-compatible plan.
 *
 * CircuitIR devices are deliberately abstract (no physical footprint dimensions —
 * see `src/circuit/circuit-ir.ts`), so this module requires the caller to supply
 * each device's width/height alongside the CircuitIR itself; it does not guess
 * dimensions from a package name string.
 *
 * Devices are grouped into up to three placement passes, each a separate call to
 * `planComponentGroupPlacement` (which only accepts one `layer` per call):
 *   - `connector`  — devices with role "connector" (see `component-planning.ts`),
 *     hugging one board edge (mechanical/cable-access requirement).
 *   - `bottom`     — devices whose CircuitIR physical constraint requests
 *     `PlacementSide.Bottom`, placed on `bottomLayer`.
 *   - `top`        — everything else, placed on `topLayer`.
 * Top and bottom passes intentionally share the same board area (a real board has
 * both sides available at the same X/Y) — collision checks are per-pass only, so
 * top/bottom overlaps are not flagged; see `floorplanNotes` for this and other
 * simplifications made explicit rather than silently assumed.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { PlacementSide } from '../circuit/types.js';
import type { CircuitIR, Device } from '../circuit/circuit-ir.js';
import { getDeviceRole } from '../circuit/component-planning.js';
import { planComponentGroupPlacement } from './planner.js';
import type {
  BoardBox,
  ComponentGroupPlacementPlan,
  LayoutExecutionMode,
  PointMm,
  RectMm,
} from './types.js';

export type FloorplanEdge = 'top' | 'bottom' | 'left' | 'right';

export interface FloorplanDeviceInput {
  /** Must match a `Device.id` in the supplied CircuitIR. */
  deviceId: string;
  ref: string;
  widthMm: number;
  heightMm: number;
  rotation?: number;
  primitiveId?: string;
  footprint?: string;
}

export interface FloorplanInput {
  circuitIR: CircuitIR;
  /** Physical dimensions for each device to place — CircuitIR itself carries none. */
  devices: FloorplanDeviceInput[];
  projectId?: string;
  mode?: LayoutExecutionMode;
  board: BoardBox;
  anchor: PointMm;
  columns?: number;
  spacingMm?: number;
  minSpacingMm?: number;
  topLayer?: number;
  bottomLayer?: number;
  connectorEdge?: FloorplanEdge;
  connectorEdgeMarginMm?: number;
  /** Extra minimum spacing applied to a pass containing a "hot" device. */
  thermalSpacingBoostMm?: number;
  /** A device at or above this estimated dissipation is treated as "hot". */
  thermalDissipationThresholdWatts?: number;
}

export interface FloorplanPlan extends ComponentGroupPlacementPlan {
  /** Notes on constraint interpretation and known simplifications for this plan. */
  floorplanNotes: string[];
}

interface KeepoutAreaLike {
  outline: Array<{ x: number; y: number }>;
  description?: string;
}

function keepoutAreaToRect(area: KeepoutAreaLike): RectMm {
  const xs = area.outline.map((point) => point.x);
  const ys = area.outline.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    name: area.description,
  };
}

function isHotDevice(device: Device, circuitIR: CircuitIR, thresholdWatts: number): boolean {
  if ((device.estimatedDissipationWatts ?? 0) >= thresholdWatts) return true;
  return circuitIR.physicalConstraints.some(
    (constraint) => constraint.type === 'thermal' && constraint.targetRef === device.id,
  );
}

function preferredSideFor(device: Device, circuitIR: CircuitIR): PlacementSide | undefined {
  const constraint = circuitIR.physicalConstraints.find(
    (entry) =>
      entry.type === 'placement' && entry.targetType === 'device' && entry.targetRef === device.id,
  );
  return constraint?.preferredSide;
}

type Bucket = 'connector' | 'top' | 'bottom';

function bucketFor(device: Device, circuitIR: CircuitIR): Bucket {
  if (getDeviceRole(device) === 'connector') return 'connector';
  return preferredSideFor(device, circuitIR) === PlacementSide.Bottom ? 'bottom' : 'top';
}

function edgeAnchor(
  edge: FloorplanEdge,
  board: BoardBox,
  marginMm: number,
  fallback: PointMm,
): PointMm {
  switch (edge) {
    case 'top':
      return { x: fallback.x, y: marginMm };
    case 'bottom':
      return { x: fallback.x, y: board.heightMm - marginMm };
    case 'left':
      return { x: marginMm, y: fallback.y };
    case 'right':
      return { x: board.widthMm - marginMm, y: fallback.y };
  }
}

/** Build a floorplan-aware component group placement plan from a CircuitIR. */
export function planFloorplan(input: FloorplanInput): FloorplanPlan {
  const { circuitIR } = input;
  const floorplanNotes: string[] = [
    'Top and bottom passes share the same board area and are collision-checked ' +
      'independently — cross-side overlaps are not flagged, review manually.',
    'Keepout areas are approximated by their axis-aligned bounding box, not their exact polygon.',
    'Keepouts apply to every pass regardless of layer (no per-layer keepout filtering).',
  ];

  const dimsByDeviceId = new Map(input.devices.map((entry) => [entry.deviceId, entry]));
  const skipped: string[] = [];
  const buckets: Record<Bucket, Device[]> = { connector: [], top: [], bottom: [] };

  // Order devices by blockRef so devices in the same CircuitIR block land in adjacent
  // grid cells within their bucket (a simple, honest reading of "block-level placement").
  const orderedDevices = [...circuitIR.devices].sort((a, b) =>
    (a.blockRef ?? '').localeCompare(b.blockRef ?? ''),
  );

  for (const device of orderedDevices) {
    if (!dimsByDeviceId.has(device.id)) {
      skipped.push(device.id);
      continue;
    }
    buckets[bucketFor(device, circuitIR)].push(device);
  }
  if (skipped.length > 0) {
    floorplanNotes.push(
      `${skipped.length} device(s) had no supplied physical dimensions and were skipped: ${skipped.join(', ')}.`,
    );
  }

  const keepouts = (circuitIR.pcb.keepoutAreas ?? []).map(keepoutAreaToRect);
  const thermalThreshold = input.thermalDissipationThresholdWatts ?? 0.5;
  const thermalBoost = input.thermalSpacingBoostMm ?? 2;
  const baseMinSpacing = input.minSpacingMm ?? 0.25;
  const connectorEdge = input.connectorEdge ?? 'bottom';
  const connectorMargin = input.connectorEdgeMarginMm ?? 5;

  const subPlans: ComponentGroupPlacementPlan[] = [];

  function runBucket(bucket: Bucket, devices: Device[], layer: number, anchor: PointMm): void {
    if (devices.length === 0) return;
    const hasHotDevice = devices.some((device) => isHotDevice(device, circuitIR, thermalThreshold));
    const components = devices.map((device) => {
      const dims = dimsByDeviceId.get(device.id);
      if (!dims) throw new Error(`Missing physical dimensions for device "${device.id}"`);
      return {
        ref: dims.ref,
        primitiveId: dims.primitiveId,
        footprint: dims.footprint,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        rotation: dims.rotation,
      };
    });
    const columns = bucket === 'connector' ? 1 : input.columns;
    subPlans.push(
      planComponentGroupPlacement({
        projectId: input.projectId,
        mode: input.mode,
        board: input.board,
        anchor,
        columns,
        spacingMm: input.spacingMm,
        layer,
        minSpacingMm: hasHotDevice ? baseMinSpacing + thermalBoost : baseMinSpacing,
        components,
        keepouts,
      }),
    );
    if (hasHotDevice) {
      floorplanNotes.push(
        `Bucket "${bucket}" contains a device at/above ${thermalThreshold}W estimated dissipation — ` +
          `minimum spacing boosted by ${thermalBoost}mm.`,
      );
    }
  }

  runBucket('top', buckets.top, input.topLayer ?? 1, input.anchor);
  runBucket('bottom', buckets.bottom, input.bottomLayer ?? 2, input.anchor);
  runBucket(
    'connector',
    buckets.connector,
    input.topLayer ?? 1,
    edgeAnchor(connectorEdge, input.board, connectorMargin, input.anchor),
  );

  const placements = subPlans.flatMap((plan) => plan.placements);
  const operations = subPlans.flatMap((plan) => plan.operations);
  const issues = subPlans.flatMap((plan) => plan.issues);
  const blocked = subPlans.some((plan) => plan.blocked);
  const mode = input.mode ?? 'preview';

  const transactionId = `floorplan_${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;

  return {
    transactionId,
    projectId: input.projectId ?? '',
    mode,
    applied: false,
    blocked,
    placements,
    operations,
    issues,
    summary: blocked
      ? `Floorplan blocked by ${issues.filter((entry) => entry.severity === 'error').length} error(s) across ${subPlans.length} pass(es).`
      : `Floorplan ready: ${placements.length} component(s) across ${subPlans.length} pass(es) ` +
        `(${buckets.top.length} top, ${buckets.bottom.length} bottom, ${buckets.connector.length} connector).`,
    floorplanNotes,
  };
}

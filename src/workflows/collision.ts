/**
 * Pin-coordinate collision detection for schematic component placement.
 *
 * EasyEDA merges any two primitives that land on the exact same (x,y) canvas point,
 * regardless of net name, the moment either one is wired — so a newly-placed component
 * whose pin coincides with an unrelated component's pin is a silent-short risk even
 * before any wire is drawn. The bridge's own `NET_COLLISION` guard only catches this for
 * pins that are already part of a net (see `easyeda-bridge-extension/src/dispatcher.ts`'s
 * `collectPinCoordinateNets`) — a virgin, never-wired pin is invisible to it. This module
 * closes that gap by reading every placed component's real pin coordinates directly
 * (`SCH_PrimitiveComponent.getAllPinsByPrimitiveId` via `fetchComponentPins`), independent
 * of net membership.
 *
 * @module
 */

import { type ToolContext } from '../tools/types.js';
import { fetchComponentPins } from '../tools/schematic-helpers.js';

export interface CollisionPinRef {
  primitiveId: string;
  pinNumber: string;
  pinName: string;
}

export interface PinCollision {
  x: number;
  y: number;
  pins: CollisionPinRef[];
}

interface SheetComponentRef {
  primitiveId: string;
}

export interface CollisionScanFailure {
  primitiveId: string;
  error: string;
}

export interface CollisionScanDiagnostics {
  stage: 'complete' | 'component_enumeration' | 'pin_lookup';
  componentCount: number;
  componentsScanned: number;
  failedComponents: CollisionScanFailure[];
  durationMs: number;
  componentEnumerationMs: number;
  pinLookupMs: number;
  concurrency: number;
  perCallTimeoutMs: number;
  overallTimeoutMs: number;
  stageError?: string;
}

export interface CollisionScanResult {
  collisions: PinCollision[];
  diagnostics: CollisionScanDiagnostics;
}

interface CollisionScanBudget {
  startedAt: number;
  deadlineAt: number;
  concurrency: number;
  perCallTimeoutMs: number;
  overallTimeoutMs: number;
}

interface PointBucket {
  x: number;
  y: number;
  pins: CollisionPinRef[];
}

interface PinMapBuildResult {
  map: Map<string, PointBucket>;
  componentsScanned: number;
  failedComponents: CollisionScanFailure[];
}

export const COLLISION_SCAN_CONCURRENCY = 4;
export const COLLISION_PIN_LOOKUP_TIMEOUT_MS = 5_000;
export const COLLISION_SCAN_TIMEOUT_MS = 20_000;

/** Round to the same precision the bridge's own coordinate-key helper uses. */
function pointKey(x: number, y: number): string {
  return `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;
}

function createScanBudget(): CollisionScanBudget {
  const startedAt = Date.now();
  return {
    startedAt,
    deadlineAt: startedAt + COLLISION_SCAN_TIMEOUT_MS,
    concurrency: COLLISION_SCAN_CONCURRENCY,
    perCallTimeoutMs: COLLISION_PIN_LOOKUP_TIMEOUT_MS,
    overallTimeoutMs: COLLISION_SCAN_TIMEOUT_MS,
  };
}

function remainingCallTimeoutMs(budget: CollisionScanBudget): number {
  const remainingMs = budget.deadlineAt - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.min(budget.perCallTimeoutMs, remainingMs));
}

function overallDeadlineError(stage: string, budget: CollisionScanBudget): string {
  return `Collision scan overall deadline of ${budget.overallTimeoutMs}ms expired during ${stage}`;
}

/** Page through `schematic.listComponents` and return every component's primitiveId. */
async function listAllComponentIds(
  ctx: ToolContext,
  projectId: string,
  budget: CollisionScanBudget,
): Promise<SheetComponentRef[]> {
  const pageSize = 500;
  const all: SheetComponentRef[] = [];
  let offset = 0;
  for (;;) {
    const timeoutMs = remainingCallTimeoutMs(budget);
    if (timeoutMs === 0) throw new Error(overallDeadlineError('component enumeration', budget));
    const result = await ctx.bridge.call<
      { projectId: string; limit: number; offset: number },
      { total?: number; items?: Array<{ primitiveId?: string }> }
    >('schematic.listComponents', { projectId, limit: pageSize, offset }, { timeoutMs });
    const items = result?.items ?? [];
    for (const item of items) {
      if (item.primitiveId) all.push({ primitiveId: item.primitiveId });
    }
    const total = result?.total ?? items.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }
  return all;
}

/**
 * Build a coordinate -> pins map with a bounded worker pool. Each component lookup receives
 * an explicit bridge deadline and failures are retained so callers can return partial,
 * actionable diagnostics instead of abandoning the entire scan at the first stalled RPC.
 */
async function buildPinCoordinateMap(
  ctx: ToolContext,
  components: SheetComponentRef[],
  budget: CollisionScanBudget,
): Promise<PinMapBuildResult> {
  const map = new Map<string, PointBucket>();
  const failedComponents: CollisionScanFailure[] = [];
  let componentsScanned = 0;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= components.length) return;

      const component = components[index];
      if (!component) return;
      const timeoutMs = remainingCallTimeoutMs(budget);
      if (timeoutMs === 0) {
        failedComponents.push({
          primitiveId: component.primitiveId,
          error: overallDeadlineError('pin lookup', budget),
        });
        continue;
      }

      try {
        const pins = await fetchComponentPins(ctx, component.primitiveId, { timeoutMs });
        componentsScanned += 1;
        for (const pin of pins) {
          const key = pointKey(pin.x, pin.y);
          const bucket = map.get(key) ?? { x: pin.x, y: pin.y, pins: [] };
          bucket.pins.push({
            primitiveId: component.primitiveId,
            pinNumber: pin.pinNumber,
            pinName: pin.pinName,
          });
          map.set(key, bucket);
        }
      } catch (error) {
        failedComponents.push({
          primitiveId: component.primitiveId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const workerCount = Math.min(budget.concurrency, components.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const componentOrder = new Map(
    components.map((component, index) => [component.primitiveId, index] as const),
  );
  failedComponents.sort(
    (a, b) =>
      (componentOrder.get(a.primitiveId) ?? Number.MAX_SAFE_INTEGER) -
      (componentOrder.get(b.primitiveId) ?? Number.MAX_SAFE_INTEGER),
  );

  return { map, componentsScanned, failedComponents };
}

function collisionsFromMap(
  map: Map<string, PointBucket>,
  onlyInvolving?: Set<string>,
): PinCollision[] {
  const collisions: PinCollision[] = [];
  for (const bucket of map.values()) {
    const distinctPrimitives = new Set(bucket.pins.map((p) => p.primitiveId));
    if (distinctPrimitives.size < 2) continue;
    if (onlyInvolving && ![...distinctPrimitives].some((id) => onlyInvolving.has(id))) continue;
    collisions.push({ x: bucket.x, y: bucket.y, pins: bucket.pins });
  }
  return collisions;
}

export function collisionScanErrorMessage(diagnostics: CollisionScanDiagnostics): string {
  if (diagnostics.stage === 'component_enumeration') {
    return `Collision scan incomplete during component enumeration: ${diagnostics.stageError ?? 'unknown bridge error'}.`;
  }
  const failedIds = diagnostics.failedComponents.map((failure) => failure.primitiveId).join(', ');
  return (
    `Collision scan incomplete: ${diagnostics.failedComponents.length}/${diagnostics.componentCount} ` +
    `component pin lookups failed${failedIds ? ` (${failedIds})` : ''}. Partial collision results are included.`
  );
}

/**
 * Full-sheet pin-coordinate collision scan with timing and failure diagnostics.
 * Successful pin lookups are still analyzed when another component stalls.
 */
export async function scanSheetForPinCollisionsDetailed(
  ctx: ToolContext,
  projectId: string,
): Promise<CollisionScanResult> {
  const budget = createScanBudget();
  const enumerationStartedAt = Date.now();
  let components: SheetComponentRef[];

  try {
    components = await listAllComponentIds(ctx, projectId, budget);
  } catch (error) {
    const now = Date.now();
    return {
      collisions: [],
      diagnostics: {
        stage: 'component_enumeration',
        componentCount: 0,
        componentsScanned: 0,
        failedComponents: [],
        durationMs: now - budget.startedAt,
        componentEnumerationMs: now - enumerationStartedAt,
        pinLookupMs: 0,
        concurrency: budget.concurrency,
        perCallTimeoutMs: budget.perCallTimeoutMs,
        overallTimeoutMs: budget.overallTimeoutMs,
        stageError: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const enumerationFinishedAt = Date.now();
  const pinLookupStartedAt = enumerationFinishedAt;
  const pinMap = await buildPinCoordinateMap(ctx, components, budget);
  const finishedAt = Date.now();
  const complete = pinMap.failedComponents.length === 0;

  return {
    collisions: collisionsFromMap(pinMap.map),
    diagnostics: {
      stage: complete ? 'complete' : 'pin_lookup',
      componentCount: components.length,
      componentsScanned: pinMap.componentsScanned,
      failedComponents: pinMap.failedComponents,
      durationMs: finishedAt - budget.startedAt,
      componentEnumerationMs: enumerationFinishedAt - enumerationStartedAt,
      pinLookupMs: finishedAt - pinLookupStartedAt,
      concurrency: budget.concurrency,
      perCallTimeoutMs: budget.perCallTimeoutMs,
      overallTimeoutMs: budget.overallTimeoutMs,
    },
  };
}

/**
 * Strict compatibility wrapper used by safety-sensitive workflows. Standalone tooling uses
 * the detailed variant so it can expose partial results, while placement reconciliation must
 * fail closed when any component was not inspected.
 */
export async function scanSheetForPinCollisions(
  ctx: ToolContext,
  projectId: string,
): Promise<PinCollision[]> {
  const result = await scanSheetForPinCollisionsDetailed(ctx, projectId);
  if (result.diagnostics.stage !== 'complete') {
    throw new Error(collisionScanErrorMessage(result.diagnostics));
  }
  return result.collisions;
}

export interface ReconcilePlacementResult {
  /** Collisions that could not be resolved by nudging — caller should block/report these. */
  unresolvedCollisions: PinCollision[];
  /** primitiveId -> final {x, y} for every candidate that was moved during reconcile. */
  movedComponents: Map<string, { x: number; y: number }>;
}

const NUDGE_ATTEMPTS = 3;
const NUDGE_STEP = 30;

/**
 * Post-placement reconcile: check the newly-placed `candidatePrimitiveIds` for pin-coordinate
 * collisions against every other component on the sheet, and nudge (re-`modifyPrimitive`) any
 * offender by a fixed offset up to `NUDGE_ATTEMPTS` times. Safe to call only *before* any wires
 * are connected to the candidates — moving a component after it's wired does not move its wires
 * (see the dispatcher's `modifyPrimitive` limitation) and would itself create the exact hazard
 * this function exists to prevent.
 */
export async function reconcilePlacementCollisions(
  ctx: ToolContext,
  projectId: string,
  candidatePrimitiveIds: string[],
  candidatePositions: Map<string, { x: number; y: number }>,
): Promise<ReconcilePlacementResult> {
  const candidateSet = new Set(candidatePrimitiveIds);
  const movedComponents = new Map<string, { x: number; y: number }>();
  if (candidateSet.size === 0) {
    return { unresolvedCollisions: [], movedComponents };
  }

  const enumerationBudget = createScanBudget();
  const components = await listAllComponentIds(ctx, projectId, enumerationBudget);

  for (let attempt = 0; attempt <= NUDGE_ATTEMPTS; attempt += 1) {
    const pinMap = await buildPinCoordinateMap(ctx, components, createScanBudget());
    if (pinMap.failedComponents.length > 0) {
      throw new Error(
        collisionScanErrorMessage({
          stage: 'pin_lookup',
          componentCount: components.length,
          componentsScanned: pinMap.componentsScanned,
          failedComponents: pinMap.failedComponents,
          durationMs: 0,
          componentEnumerationMs: 0,
          pinLookupMs: 0,
          concurrency: COLLISION_SCAN_CONCURRENCY,
          perCallTimeoutMs: COLLISION_PIN_LOOKUP_TIMEOUT_MS,
          overallTimeoutMs: COLLISION_SCAN_TIMEOUT_MS,
        }),
      );
    }
    const collisions = collisionsFromMap(pinMap.map, candidateSet);
    if (collisions.length === 0) {
      return { unresolvedCollisions: [], movedComponents };
    }
    if (attempt === NUDGE_ATTEMPTS) {
      return { unresolvedCollisions: collisions, movedComponents };
    }

    const offendingCandidates = new Set(
      collisions.flatMap((collision) =>
        collision.pins.map((p) => p.primitiveId).filter((id) => candidateSet.has(id)),
      ),
    );
    for (const primitiveId of offendingCandidates) {
      const current = candidatePositions.get(primitiveId);
      if (!current) continue;
      const nudged = {
        x: current.x + NUDGE_STEP * (attempt + 1),
        y: current.y + NUDGE_STEP * (attempt + 1),
      };
      await ctx.bridge.call('schematic.modifyPrimitive', {
        primitiveId,
        property: { x: nudged.x, y: nudged.y },
      });
      candidatePositions.set(primitiveId, nudged);
      movedComponents.set(primitiveId, nudged);
    }
  }

  return { unresolvedCollisions: [], movedComponents };
}

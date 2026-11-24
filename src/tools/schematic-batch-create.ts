import type { ToolContext } from './types.js';
import type { NativeSchematicScope } from '../transactions/model.js';
import {
  deletePrimitiveExact,
  getGlobalTransactionManager,
  getScopedDrawingSnapshot,
  primitiveExists,
  TransactionError,
} from '../transactions/index.js';
import type { PrimitiveSnapshotResult } from '../transactions/easyeda.js';
import {
  assertFocusedSchematicScope,
  nativeSchematicTarget,
} from '../transactions/schematic-scope.js';
import { normalizeUndirectedTwoPointWire, stableHash } from '../transactions/stable.js';

const drawingMethods = {
  wire: 'schematic.addWire',
  text: 'schematic.addText',
  rectangle: 'schematic.addRectangle',
  circle: 'schematic.addCircle',
  polygon: 'schematic.addPolygon',
} as const;

type DrawingKind = keyof typeof drawingMethods;
type BatchCreate = { operationId: string; action: 'create'; primitiveKind: string };

function isDrawingKind(value: string): value is DrawingKind {
  return Object.hasOwn(drawingMethods, value);
}

function refusal(message: string): never {
  throw new TransactionError('TRANSACTION_INVALID_STATE', message);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function assertSupportedBatchCreate(operation: BatchCreate): void {
  if (!isDrawingKind(operation.primitiveKind)) {
    refusal(
      'Atomic batch create ownership is not verified for ' +
        operation.primitiveKind +
        '. Use an independently verified standalone placement or inspect the intended schematic.',
    );
  }
}

export async function prepareBatchCreateScope(
  ctx: ToolContext,
  projectId: string,
  expectedPage?: string,
) {
  if (!ctx.bridge.connected || ctx.bridge.registryMismatch || ctx.bridge.extensionVersionMismatch)
    refusal('Connect a compatible bridge before atomic drawing creation.');
  const status = record(await ctx.bridge.call('system.getStatus', {}));
  if (
    status.documentTargetGuard !== true ||
    status.documentProjectGuard !== true ||
    status.verifiedDrawingCreate !== true
  )
    refusal('Atomic drawing creation requires extension verified drawing and target guards.');
  return assertFocusedSchematicScope(ctx.bridge, projectId, expectedPage);
}

async function assertScope(ctx: ToolContext, scope: NativeSchematicScope) {
  await assertFocusedSchematicScope(ctx.bridge, scope.projectId, scope.documentId);
}

async function strictIds(
  ctx: ToolContext,
  scope: NativeSchematicScope,
  kind: DrawingKind,
): Promise<Set<string>> {
  await assertScope(ctx, scope);
  const result = record(
    await ctx.bridge.call('schematic.listPrimitiveIds', {
      primitiveKind: kind,
      requireVerifiedInventory: true,
      ...nativeSchematicTarget(scope),
    }),
  );
  await assertScope(ctx, scope);
  const ids = result.primitiveIds;
  if (
    result.primitiveKind !== kind ||
    result.inventoryVerified !== true ||
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !id || id.trim() !== id) ||
    new Set(ids).size !== ids.length
  )
    refusal('Native drawing inventory is not complete and verified.');
  return new Set(ids as string[]);
}

function nativeReturnedId(result: unknown, scope: NativeSchematicScope): string {
  const response = record(result);
  const target = record(response.targetDocument);
  if (
    response.success === false ||
    response.verifiedDrawingCreate !== true ||
    typeof response.primitiveId !== 'string' ||
    !response.primitiveId ||
    response.primitiveId.trim() !== response.primitiveId ||
    target.uuid !== scope.documentId ||
    target.projectUuid !== scope.projectId ||
    target.documentType !== 'schematic'
  )
    refusal('Native create identity is unverified. Inspect the intended page before retrying.');
  return response.primitiveId;
}

function requestedDrawingProperties(kind: DrawingKind, params: Record<string, unknown>) {
  const expected: Record<string, unknown> = { ...params };
  if (kind === 'wire' || kind === 'polygon') {
    const points = params.points as Array<{ x: number; y: number }>;
    expected.line = points.flatMap(({ x, y }) => [x, y]);
    delete expected.points;
  }
  if (kind === 'wire') {
    expected.net = expected.netName;
    delete expected.netName;
  }
  return expected;
}

function matchesRequestedDrawing(
  snapshot: PrimitiveSnapshotResult,
  id: string,
  kind: DrawingKind,
  expected: Record<string, unknown>,
) {
  if (
    snapshot.schemaVersion !== 'schematic-primitive-snapshot/v1' ||
    snapshot.primitiveId !== id ||
    snapshot.primitiveKind !== kind ||
    !snapshot.property
  )
    return false;
  const actual = normalizeUndirectedTwoPointWire({
    primitiveKind: kind,
    property: snapshot.property,
  }).property as Record<string, unknown>;
  const requested = normalizeUndirectedTwoPointWire({ primitiveKind: kind, property: expected })
    .property as Record<string, unknown>;
  return Object.entries(requested).every(
    ([key, value]) =>
      value === undefined ||
      (Object.hasOwn(actual, key) && stableHash(actual[key]) === stableHash(value)),
  );
}

async function verifiedCreatedDrawing(
  ctx: ToolContext,
  scope: NativeSchematicScope,
  kind: DrawingKind,
  before: ReadonlySet<string>,
  id: string,
  expected: Record<string, unknown>,
): Promise<PrimitiveSnapshotResult> {
  // Only wait for the acknowledged ID, never substitute a different new ID.
  for (let attempt = 0; attempt < 30; attempt++) {
    const after = await strictIds(ctx, scope, kind);
    const added = [...after].filter((candidate) => !before.has(candidate));
    if (
      [...before].some((candidate) => !after.has(candidate)) ||
      added.some((candidate) => candidate !== id)
    )
      refusal('Native drawing inventory changed unexpectedly; create ownership unresolved.');
    if (added.length === 1) {
      const snapshot = await getScopedDrawingSnapshot(ctx.bridge, id, kind, scope);
      await assertScope(ctx, scope);
      if (!matchesRequestedDrawing(snapshot, id, kind, expected))
        refusal('Native drawing does not match the requested creation descriptor.');
      return structuredClone(snapshot);
    }
    if (attempt < 29) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return refusal('Acknowledged drawing is not visible in verified native inventory.');
}

export async function executeVerifiedBatchCreate(
  ctx: ToolContext,
  transactionId: string,
  scope: NativeSchematicScope,
  operation: BatchCreate,
) {
  const { operationId, action: _action, primitiveKind: kind, ...params } = operation;
  if (!isDrawingKind(kind)) return refusal('Unsupported verified batch create kind: ' + kind);
  const expected = requestedDrawingProperties(kind, params);
  const before = await strictIds(ctx, scope, kind);
  let witness: PrimitiveSnapshotResult | undefined;
  const freshWitness = async (id: string) => {
    await assertScope(ctx, scope);
    const snapshot = await getScopedDrawingSnapshot(ctx.bridge, id, kind, scope);
    await assertScope(ctx, scope);
    if (
      !witness ||
      !matchesRequestedDrawing(snapshot, id, kind, expected) ||
      stableHash(snapshot) !== stableHash(witness)
    )
      refusal('Owned drawing changed or cannot be verified; no compensation.');
    return snapshot;
  };
  return getGlobalTransactionManager().runCreate(transactionId, operationId, {
    nativeSchematicScope: scope,
    apply: async () => {
      await assertScope(ctx, scope);
      const result = await ctx.bridge.call(drawingMethods[kind], {
        ...params,
        ...nativeSchematicTarget(scope),
        verifiedDrawingCreate: true,
      });
      const id = nativeReturnedId(result, scope);
      if (before.has(id)) refusal('Native create returned a pre-existing primitive ID.');
      witness = await verifiedCreatedDrawing(ctx, scope, kind, before, id, expected);
      return { result, targetId: id };
    },
    getSnapshot: freshWitness,
    remove: async (id) => {
      const snapshot = await freshWitness(id);
      await deletePrimitiveExact(ctx.bridge, id, scope, snapshot);
      await assertScope(ctx, scope);
    },
    exists: async (id) => {
      await assertScope(ctx, scope);
      const exists = await primitiveExists(ctx.bridge, id, kind);
      await assertScope(ctx, scope);
      return exists;
    },
    // Timeout or ambiguous native response may still have a late side effect.
    // Never attribute an inventory delta to our request on failure.
    reconcile: async () => ({ status: 'ambiguous' as const }),
  });
}

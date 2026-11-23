import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import {
  assertFocusedSchematicScope,
  nativeSchematicTarget,
} from '../transactions/schematic-scope.js';
import {
  deletePrimitiveExact,
  getGlobalTransactionManager,
  getPrimitiveSnapshot,
  listPrimitiveIds,
  primitiveExists,
  recreatePrimitiveSnapshot,
  TransactionError,
} from '../transactions/index.js';

const deviceItemSchema = z
  .object({
    libraryUuid: z.string(),
    uuid: z.string(),
  })
  .passthrough();

type SchematicComponentSnapshot = Record<string, unknown>;

type PlacementGuardResult = {
  collision_checked: boolean;
  collision_radius: number;
  warnings: string[];
  nearby_components: SchematicComponentSnapshot[];
};

function schematicWriteNumberField(
  item: SchematicComponentSnapshot,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function schematicWriteComponentPoint(
  item: SchematicComponentSnapshot,
): { x: number; y: number } | undefined {
  const directX = schematicWriteNumberField(item, ['x', 'X', 'canvasX', 'positionX']);
  const directY = schematicWriteNumberField(item, ['y', 'Y', 'canvasY', 'positionY']);
  if (directX !== undefined && directY !== undefined) return { x: directX, y: directY };

  const position = item.position;
  if (position && typeof position === 'object' && !Array.isArray(position)) {
    const pos = position as SchematicComponentSnapshot;
    const x = schematicWriteNumberField(pos, ['x', 'X']);
    const y = schematicWriteNumberField(pos, ['y', 'Y']);
    if (x !== undefined && y !== undefined) return { x, y };
  }

  const bbox = item.bbox ?? item.boundingBox;
  if (bbox && typeof bbox === 'object' && !Array.isArray(bbox)) {
    const box = bbox as SchematicComponentSnapshot;
    const x1 = schematicWriteNumberField(box, ['x', 'left', 'minX']);
    const y1 = schematicWriteNumberField(box, ['y', 'top', 'minY']);
    const x2 = schematicWriteNumberField(box, ['x2', 'right', 'maxX']);
    const y2 = schematicWriteNumberField(box, ['y2', 'bottom', 'maxY']);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
  }

  return undefined;
}

function schematicWritePlacementGuard(
  components: SchematicComponentSnapshot[] | undefined,
  x: number,
  y: number,
  collisionRadius: number,
): PlacementGuardResult {
  const nearby: SchematicComponentSnapshot[] = [];
  for (const component of components ?? []) {
    const point = schematicWriteComponentPoint(component);
    if (!point) continue;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= collisionRadius) nearby.push({ ...component, distance });
  }

  return {
    collision_checked: true,
    collision_radius: collisionRadius,
    warnings:
      nearby.length > 0
        ? [
            `Placement is within ${collisionRadius} schematic units of ${nearby.length} existing component(s). Review before applying.`,
          ]
        : [],
    nearby_components: nearby,
  };
}

async function readSchematicComponentsForVerification(
  ctx: ToolContext,
): Promise<SchematicComponentSnapshot[] | undefined> {
  try {
    const result = await ctx.bridge.call<
      { allPages: boolean; limit: number; offset: number },
      { total?: number; items?: SchematicComponentSnapshot[] } | SchematicComponentSnapshot[]
    >('schematic.listComponents', {
      allPages: false,
      limit: 500,
      offset: 0,
    });
    // The bridge returns { total, items }, not a bare array — accept both
    // shapes defensively (a bare-array response previously made this always
    // return undefined, silently disabling the collision guard and the
    // before/after component-count diff in verifyAfterWrite).
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.items)) {
      // A paginated/incomplete native collection is not a valid baseline
      // for collision detection or recovery of an uncertain write.
      if (
        result.total !== undefined &&
        (!Number.isSafeInteger(result.total) || result.total !== result.items.length)
      )
        return undefined;
      return result.items;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Loose match for "was this placement attempted right before the bridge call failed" —
 *  used only to decide whether a timeout/error is worth reconciling against real state. */
function looksLikeTimeoutOrUnconfirmed(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /timed out|timeout/i.test(err.message);
}

/**
 * EasyEDA uses a project-local device UUID for an installed part, which can
 * differ from the original library-device UUID used for placement. A direct
 * match is usable; otherwise require independently reported library, device
 * and (when supplied) symbol/footprint metadata. Never equate a name alone
 * with original library provenance.
 */
function matchingPlacedDevice(
  component: SchematicComponentSnapshot,
  deviceItem: PlaceComponentParams['deviceItem'],
): boolean {
  if (
    component.deviceLibraryUuid !== undefined &&
    component.deviceLibraryUuid !== deviceItem.libraryUuid
  )
    return false;
  if (component.deviceUuid === deviceItem.uuid) return true;
  if (
    typeof deviceItem.name !== 'string' ||
    !deviceItem.name ||
    component.deviceLibraryUuid !== deviceItem.libraryUuid ||
    component.deviceName !== deviceItem.name
  )
    return false;
  if (typeof deviceItem.symbolName === 'string' && component.symbolName !== deviceItem.symbolName)
    return false;
  if (
    typeof deviceItem.footprintName === 'string' &&
    component.footprint !== deviceItem.footprintName
  )
    return false;
  return true;
}

function completeInventoryIds(components: SchematicComponentSnapshot[]): Set<string> | undefined {
  const ids = components.map((component) => component.primitiveId);
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) return undefined;
  const unique = new Set(ids as string[]);
  return unique.size === ids.length ? unique : undefined;
}

/**
 * A placement timeout is NOT proof of success or failure. Reconcile only
 * exactly one newly observed native ID absent from a complete pre-write
 * inventory. A pre-existing colocated component or ambiguous new matches
 * must never turn a failed bridge call into false success.
 */
function findMatchingPlacedComponent(
  before: SchematicComponentSnapshot[] | undefined,
  after: SchematicComponentSnapshot[] | undefined,
  p: PlaceComponentParams,
): SchematicComponentSnapshot | undefined {
  if (!before || !after) return undefined;
  const beforeIds = completeInventoryIds(before);
  const afterIds = completeInventoryIds(after);
  if (!beforeIds || !afterIds) return undefined;
  const radius = p.collisionRadius ?? 25;
  const matches = after.filter((component) => {
    const id = component.primitiveId as string;
    if (beforeIds.has(id) || !matchingPlacedDevice(component, p.deviceItem)) return false;
    if (p.designator !== undefined && component.reference !== p.designator) return false;
    if (p.uniqueId !== undefined && component.uniqueId !== p.uniqueId) return false;
    if (p.subPartName !== undefined && component.subPartName !== p.subPartName) return false;
    const point = schematicWriteComponentPoint(component);
    return point !== undefined && Math.hypot(point.x - p.x, point.y - p.y) <= radius;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

const STANDALONE_CREATE_RECONCILE_ATTEMPTS = 30;
const STANDALONE_CREATE_RECONCILE_DELAY_MS = 100;
const RECREATABLE_TRANSACTION_DELETE_KINDS = new Set([
  'wire',
  'text',
  'rectangle',
  'circle',
  'polygon',
]);

const projectTransactionInputFields = {
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe('Required when transactionId is supplied; must match the transaction document.'),
  transactionId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional snapshot-backed project transaction ID.'),
};

type ProjectTransactionInput = {
  projectId?: string;
  transactionId?: string;
};

function requireProjectIdForTransaction(
  value: ProjectTransactionInput,
  context: z.RefinementCtx<ProjectTransactionInput>,
) {
  if (value.transactionId && !value.projectId) {
    context.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'projectId is required when transactionId is supplied',
      input: value,
    });
  }
}

const transactionOperationStateSchema = z.enum([
  'pending',
  'applied',
  'rolled-back',
  'cancelled',
  'failed',
]);

function transactionFailure(err: unknown) {
  const transactionError = err instanceof TransactionError ? err : undefined;
  return {
    success: false as const,
    error_code: transactionError?.code,
    error: err instanceof Error ? err.message : String(err),
    details: transactionError?.details,
  };
}

function isConfirmedNativeSchematicDeletion(response: unknown, requestedIds: string[]): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  const native = response as { success?: unknown; deleted?: unknown; notFound?: unknown };
  if (native.success !== true || !Array.isArray(native.deleted) || !Array.isArray(native.notFound))
    return false;
  const deleted = native.deleted;
  if (native.notFound.length > 0 || deleted.length !== requestedIds.length) return false;
  return (
    new Set(deleted).size === requestedIds.length &&
    requestedIds.every((id) => deleted.includes(id))
  );
}

function bridgeFailure(err: unknown) {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const data =
    record?.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  return {
    success: false as const,
    error_code: typeof record?.code === 'string' ? record.code : undefined,
    error: err instanceof Error ? err.message : String(err),
    details: data,
  };
}

function transactionManagerForProject(transactionId: string, projectId: string | undefined) {
  const manager = getGlobalTransactionManager();
  const transaction = manager.get(transactionId);
  if (transaction.documentId !== projectId) {
    throw new TransactionError(
      'TRANSACTION_INVALID_STATE',
      `Transaction ${transactionId} belongs to ${transaction.documentId}, not ${projectId}`,
      { transactionDocumentId: transaction.documentId, requestedProjectId: projectId },
    );
  }
  return manager;
}

async function pollStandaloneAddedPrimitiveIds(
  ctx: ToolContext,
  primitiveKind: string,
  beforeIds: ReadonlySet<string>,
  attempts: number,
): Promise<string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const afterIds = await listPrimitiveIds(ctx.bridge, primitiveKind);
    const added = afterIds.filter((id) => !beforeIds.has(id));
    if (added.length > 0) return added;
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STANDALONE_CREATE_RECONCILE_DELAY_MS),
      );
    }
  }
  return [];
}

/**
 * A transaction-local component ID is not provenance. The editor may have
 * concurrently placed a different primitive, including on another tab.
 * Require a full native inventory and exact placement/library identity before
 * using the ID in transaction rollback or automatic compensation.
 */
async function verifiedTransactionalPlacementId(
  ctx: ToolContext,
  p: PlaceComponentParams,
  beforeIds: ReadonlySet<string>,
  observedIds: string[],
): Promise<string> {
  const after = await readSchematicComponentsForVerification(ctx);
  if (!after) throw new Error('Native transaction component inventory is incomplete');
  const allIds = completeInventoryIds(after);
  if (!allIds) throw new Error('Native transaction component inventory IDs are invalid');
  if ([...beforeIds].some((id) => !allIds.has(id))) {
    throw new Error('Existing native components changed during transaction placement');
  }
  const newIds = [...allIds].filter((id) => !beforeIds.has(id));
  const onlyNewId = newIds[0];
  if (
    !onlyNewId ||
    newIds.length !== 1 ||
    observedIds.length !== 1 ||
    observedIds[0] !== onlyNewId
  ) {
    throw new Error('Transactional placement is ambiguous: exactly one new primitive required');
  }
  const reference = [...beforeIds].map((primitiveId) => ({ primitiveId }));
  const match = findMatchingPlacedComponent(reference, after, p);
  if (!match || match.primitiveId !== onlyNewId) {
    throw new Error('Transactional component library, group or position is not verified');
  }
  return onlyNewId;
}

async function placeComponentInTransaction(
  ctx: ToolContext,
  p: z.infer<typeof placeComponentInputSchema>,
) {
  const { transactionId, projectId } = p;
  if (!transactionId || !projectId) throw new Error('Transactional placement requires IDs');
  const manager = transactionManagerForProject(transactionId, projectId);
  const scope = await assertFocusedSchematicScope(ctx.bridge, projectId);
  const before = await readSchematicComponentsForVerification(ctx);
  const beforeIds = before && completeInventoryIds(before);
  if (!beforeIds) {
    throw new TransactionError(
      'TRANSACTION_INVALID_STATE',
      'Native component inventory unavailable before transactional placement',
    );
  }
  await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
  return manager.runCreate(transactionId, `component:${p.deviceItem.uuid}`, {
    nativeSchematicScope: scope,
    apply: async () => {
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      const result = await ctx.bridge.call('schematic.placeComponent', {
        deviceItem: p.deviceItem,
        x: p.x,
        y: p.y,
        subPartName: p.subPartName,
        designator: p.designator,
        uniqueId: p.uniqueId,
        rotation: p.rotation,
        mirror: p.mirror,
        addIntoBom: p.addIntoBom,
        addIntoPcb: p.addIntoPcb,
        ...nativeSchematicTarget(scope),
      });
      const added = await pollStandaloneAddedPrimitiveIds(
        ctx,
        'component',
        beforeIds,
        STANDALONE_CREATE_RECONCILE_ATTEMPTS,
      );
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      const targetId = await verifiedTransactionalPlacementId(ctx, p, beforeIds, added);
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      // Native responses may omit an addressable ID; when they provide one,
      // it must not contradict the independently verified new native ID.
      const resultRecord =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : undefined;
      const responseId = resultRecord?.primitiveId ?? resultRecord?.componentId;
      if (responseId !== undefined && responseId !== targetId) {
        throw new Error('Native create response disagrees with verified component ID');
      }
      return { result, targetId };
    },
    getSnapshot: async (targetId) => {
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      const snapshot = await getPrimitiveSnapshot(ctx.bridge, targetId, 'component');
      if (snapshot.primitiveId !== targetId || snapshot.primitiveKind !== 'component') {
        throw new Error('Native created component snapshot ID or kind is not verified');
      }
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      return snapshot;
    },
    remove: async (targetId) => {
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      const post = await readSchematicComponentsForVerification(ctx);
      if (
        !post ||
        findMatchingPlacedComponent(
          [...beforeIds].map((primitiveId) => ({ primitiveId })),
          post,
          p,
        )?.primitiveId !== targetId
      ) {
        throw new Error('Native compensation target is not independently verified');
      }
      const snapshot = await getPrimitiveSnapshot(ctx.bridge, targetId, 'component');
      if (snapshot.primitiveId !== targetId || snapshot.primitiveKind !== 'component') {
        throw new Error('Native compensation component type or identity changed');
      }
      await assertFocusedSchematicScope(ctx.bridge, projectId, scope.documentId);
      return deletePrimitiveExact(ctx.bridge, targetId, scope, snapshot);
    },
    exists: async (targetId) => primitiveExists(ctx.bridge, targetId, 'component'),
    // A timed-out native create can still arrive late. A newly visible ID
    // is not ownership proof, and compensating it could delete another
    // editor's component. Keep the transaction unresolved instead.
    reconcile: async () => ({ status: 'ambiguous' as const }),
  });
}

const placeComponentInputSchema = z
  .object({
    deviceItem: deviceItemSchema,
    x: z.number(),
    y: z.number(),
    subPartName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Exact native device unit name. Requires matching designator and uniqueId for all units.',
      ),
    designator: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,8}[1-9][0-9]*$/)
      .optional()
      .describe('Shared reference for units of one physical component.'),
    uniqueId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional()
      .describe('Shared native physical identity for units of one component.'),
    rotation: z.number().optional(),
    mirror: z.boolean().optional(),
    addIntoBom: z.boolean().optional(),
    addIntoPcb: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    verifyAfterWrite: z.boolean().optional(),
    checkPlacementCollision: z.boolean().optional(),
    collisionRadius: z.number().positive().optional(),
    ...projectTransactionInputFields,
    confirmWrite: z
      .literal(true)
      .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
  })
  .superRefine(requireProjectIdForTransaction);

type PlaceComponentParams = z.infer<typeof placeComponentInputSchema>;

async function applyPlaceComponentWrite(ctx: ToolContext, p: PlaceComponentParams) {
  if (p.transactionId && p.projectId) {
    const applied = await placeComponentInTransaction(ctx, p);
    return {
      result: applied.result,
      transaction: {
        id: p.transactionId,
        operation_id: applied.operation.id,
        operation_state: applied.operation.state,
        target_id: applied.targetId,
        before_hash: applied.operation.beforeHash,
        after_hash: applied.operation.afterHash,
      },
    };
  }

  const result = await ctx.bridge.call('schematic.placeComponent', {
    deviceItem: p.deviceItem,
    x: p.x,
    y: p.y,
    subPartName: p.subPartName,
    designator: p.designator,
    uniqueId: p.uniqueId,
    rotation: p.rotation,
    mirror: p.mirror,
    addIntoBom: p.addIntoBom,
    addIntoPcb: p.addIntoPcb,
  });
  return { result, transaction: undefined };
}

async function handlePlaceComponentError(
  ctx: ToolContext,
  p: PlaceComponentParams,
  err: unknown,
  beforeComponents?: SchematicComponentSnapshot[],
) {
  if (err instanceof TransactionError) return transactionFailure(err);
  if (!looksLikeTimeoutOrUnconfirmed(err)) return bridgeFailure(err);

  const afterComponents = await readSchematicComponentsForVerification(ctx);
  const match = findMatchingPlacedComponent(beforeComponents, afterComponents, p);
  if (match) {
    return {
      success: true,
      component: match,
      reconciled: true,
      warning:
        `Bridge call errored ("${err instanceof Error ? err.message : String(err)}") but ` +
        `a matching component (primitiveId "${String(match.primitiveId ?? '')}") was found ` +
        'on the sheet afterward — the placement likely succeeded despite the error. Do not retry this placement.',
    };
  }
  return {
    success: false,
    unconfirmed: true,
    error: err instanceof Error ? err.message : String(err),
    warning:
      'This looks like a timeout, not a confirmed failure. No matching component was ' +
      'found on re-check, but the write may still be landing. Verify with ' +
      'schematic_components/schematic_nets before retrying — retrying an unconfirmed ' +
      'placement risks creating a duplicate.',
  };
}

const setPinNoConnectInputSchema = z.object({
  projectId: z.string().min(1).describe('The project/schematic ID'),
  primitiveId: z.string().min(1).describe('The component primitive ID'),
  pinNumber: z.string().min(1).describe('The exact component pin number'),
  noConnected: z
    .boolean()
    .default(true)
    .describe('true places the native No Connect marker; false removes it'),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addWireInputSchema = z.object({
  points: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
    }),
  ),
  netName: z.string().optional(),
  color: z.string().optional(),
  lineWidth: z.number().optional(),
  lineType: z.string().optional(),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const textAlignModeSchema = z.number().int().min(1).max(9);

const addTextInputSchema = z.object({
  x: z.number(),
  y: z.number(),
  content: z.string().min(1),
  rotation: z.number().optional(),
  color: z.string().optional(),
  fontName: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  alignMode: textAlignModeSchema.optional(),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addRectangleInputSchema = z.object({
  x: z.number().describe('Top-left X coordinate'),
  y: z.number().describe('Top-left Y coordinate'),
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative().optional(),
  rotation: z.number().optional(),
  color: z.string().optional().describe('Border/line color, hex string (e.g. "#FF0000")'),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addCircleInputSchema = z.object({
  centerX: z.number(),
  centerY: z.number(),
  radius: z.number().positive(),
  color: z.string().optional(),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addPolygonInputSchema = z.object({
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
  color: z.string().optional(),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const deletePrimitiveInputSchema = z
  .object({
    primitiveIds: z.array(z.string().min(1)).min(1),
    ...projectTransactionInputFields,
    confirmWrite: z
      .literal(true)
      .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
  })
  .superRefine(requireProjectIdForTransaction);

const modifyPrimitiveInputSchema = z
  .object({
    primitiveId: z.string(),
    property: z.record(z.string(), z.unknown()),
    ...projectTransactionInputFields,
    confirmWrite: z
      .literal(true)
      .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
  })
  .superRefine((value, context) => {
    requireProjectIdForTransaction(value, context);
    if (
      Object.hasOwn(value.property, 'alignMode') &&
      !textAlignModeSchema.safeParse(value.property.alignMode).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['property', 'alignMode'],
        message: 'alignMode must be an integer from 1 through 9',
      });
    }
  });

async function deletePrimitivesInTransaction(
  ctx: ToolContext,
  projectId: string,
  transactionId: string,
  primitiveIds: string[],
) {
  const manager = transactionManagerForProject(transactionId, projectId);
  const snapshots = new Map<string, Awaited<ReturnType<typeof getPrimitiveSnapshot>>>();
  for (const primitiveId of primitiveIds) {
    const snapshot = await getPrimitiveSnapshot(ctx.bridge, primitiveId);
    const primitiveKind = snapshot.primitiveKind;
    if (
      typeof primitiveKind !== 'string' ||
      !RECREATABLE_TRANSACTION_DELETE_KINDS.has(primitiveKind)
    ) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transactional delete rollback is not supported for ${String(primitiveKind)} primitive ${primitiveId}`,
        {
          primitiveId,
          primitiveKind,
          supportedKinds: Array.from(RECREATABLE_TRANSACTION_DELETE_KINDS),
        },
      );
    }
    snapshots.set(primitiveId, snapshot);
  }

  const operations = [];
  for (const primitiveId of primitiveIds) {
    const snapshot = snapshots.get(primitiveId);
    if (!snapshot) throw new Error(`Missing preflight snapshot for ${primitiveId}`);
    const primitiveKind = snapshot.primitiveKind as string;
    const applied = await manager.runDelete(transactionId, primitiveId, {
      getSnapshot: async () => structuredClone(snapshot),
      apply: async () => deletePrimitiveExact(ctx.bridge, primitiveId),
      exists: async () => primitiveExists(ctx.bridge, primitiveId, primitiveKind),
      recreate: async (beforeSnapshot) => {
        const recreated = await recreatePrimitiveSnapshot(ctx.bridge, beforeSnapshot);
        return { targetId: recreated.primitiveId, snapshot: recreated.snapshot };
      },
    });
    operations.push(applied.operation);
  }
  return operations;
}

function subpartPlacementGuard(p: PlaceComponentParams) {
  if (p.subPartName && (!p.designator || !p.uniqueId)) {
    return {
      success: false,
      error_code: 'SUBPART_LINK_REQUIRED',
      error:
        'A multi-unit subPartName requires both designator and uniqueId. Use identical values for every unit of the same physical component.',
    };
  }
  if (!p.subPartName && (p.designator || p.uniqueId)) {
    return {
      success: false,
      error_code: 'SUBPART_LINK_REQUIRED',
      error: 'Shared designator and uniqueId require an exact subPartName.',
    };
  }
  return undefined;
}

function placementMatchesSchematicReadback(
  p: PlaceComponentParams,
  result: unknown,
  before: SchematicComponentSnapshot[],
  after: SchematicComponentSnapshot[],
): boolean {
  const id =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).primitiveId
      : undefined;
  if (p.subPartName && (typeof id !== 'string' || !id)) return false;
  if (typeof id !== 'string' || !id) return true; // Legacy native results may omit an ID.
  if (before.some((item) => item.primitiveId === id)) return false;
  const component = after.find((item) => item.primitiveId === id);
  if (!component) return false;
  if (!p.subPartName) return true;
  return (
    component.reference === p.designator &&
    component.uniqueId === p.uniqueId &&
    component.subPartName === p.subPartName &&
    component.x === p.x &&
    component.y === p.y
  );
}

async function verifiedPlaceComponentOutcome(
  ctx: ToolContext,
  p: PlaceComponentParams,
  before: SchematicComponentSnapshot[],
  result: unknown,
  transaction: unknown,
  placementGuard: PlacementGuardResult | undefined,
) {
  const after = await readSchematicComponentsForVerification(ctx);
  const countDelta = after ? after.length - before.length : undefined;
  const identityConfirmed = Boolean(
    after && countDelta === 1 && placementMatchesSchematicReadback(p, result, before, after),
  );
  const verification = {
    applied: true,
    before_component_count: before.length,
    after_component_count: after?.length,
    component_count_delta: countDelta,
    readback_available: Boolean(after),
    identity_confirmed: identityConfirmed,
  };
  if (!identityConfirmed) {
    return {
      success: false,
      unconfirmed: true,
      component: result,
      transaction,
      placement_guard: placementGuard,
      verification,
      error_code: 'POST_WRITE_READBACK_UNCONFIRMED',
      error:
        'Native placement returned, but the focused schematic did not confirm exactly one matching new component.',
      warning:
        'The write may already have landed. Inspect native component state before retrying; never blindly repeat.',
    };
  }
  return {
    success: true,
    component: result,
    transaction,
    placement_guard: placementGuard,
    verification,
  };
}

function registerSchematicWriteTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_schematic_place_component',
    title: 'Place schematic component',
    description:
      'Place device from schematic_search_device (project-local IDs invalid). ' +
      'For multi-unit parts provide exact subPartName + shared designator and uniqueId; ' +
      'native readback checks linkage. On timeout inspect before retry. ' +
      'projectId + transactionId enables rollback; without transactionId the write is standalone.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: placeComponentInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      component: z.unknown().optional(),
      dry_run: z.boolean().optional(),
      placement_guard: z.unknown().optional(),
      verification: z.unknown().optional(),
      /** True when a bridge error (typically a timeout) was reconciled by finding a matching
       *  component already on the sheet — the placement likely succeeded despite the error. */
      reconciled: z.boolean().optional(),
      /** True when an error looked like a timeout but no matching component was found on
       *  re-check — genuinely unknown whether the write landed; do not assume either way. */
      unconfirmed: z.boolean().optional(),
      transaction: z
        .object({
          id: z.string(),
          operation_id: z.string(),
          operation_state: transactionOperationStateSchema,
          target_id: z.string(),
          before_hash: z.string().optional(),
          after_hash: z.string().optional(),
        })
        .optional(),
      warning: z.string().optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = placeComponentInputSchema.parse(params);
      let beforeComponents: SchematicComponentSnapshot[] | undefined;
      try {
        const subpartGuard = subpartPlacementGuard(p);
        if (subpartGuard) return subpartGuard;
        const shouldReadBefore = [p.dryRun, p.verifyAfterWrite, p.checkPlacementCollision].some(
          Boolean,
        );
        beforeComponents = shouldReadBefore
          ? await readSchematicComponentsForVerification(ctx)
          : undefined;
        if ((p.verifyAfterWrite || p.checkPlacementCollision) && !beforeComponents) {
          return {
            success: false,
            error_code: 'SCHEMATIC_READBACK_UNAVAILABLE',
            error:
              'Cannot inspect the focused schematic for requested verification or collision checks; no write was attempted.',
          };
        }
        const collisionRadius = p.collisionRadius ?? 25;
        const placementGuard = p.checkPlacementCollision
          ? schematicWritePlacementGuard(beforeComponents, p.x, p.y, collisionRadius)
          : undefined;

        if (p.dryRun) {
          return {
            success: true,
            dry_run: true,
            placement_guard: placementGuard,
            verification: {
              applied: false,
              before_component_count: beforeComponents?.length,
              requested: {
                deviceItem: p.deviceItem,
                x: p.x,
                y: p.y,
                rotation: p.rotation,
                mirror: p.mirror,
                subPartName: p.subPartName,
                designator: p.designator,
                uniqueId: p.uniqueId,
              },
            },
          };
        }

        const { result, transaction } = await applyPlaceComponentWrite(ctx, p);

        if (!p.verifyAfterWrite && !placementGuard) {
          return {
            success: true,
            component: result,
            transaction,
          };
        }

        if (p.verifyAfterWrite && beforeComponents) {
          return verifiedPlaceComponentOutcome(
            ctx,
            p,
            beforeComponents,
            result,
            transaction,
            placementGuard,
          );
        }
        return {
          success: true,
          component: result,
          transaction,
          placement_guard: placementGuard,
        };
      } catch (err) {
        return handlePlaceComponentError(ctx, p, err, beforeComponents);
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_wire',
    title: 'Add schematic wire',
    description:
      'Add a wire connecting schematic coordinates/pins — real native connectivity. Same ' +
      '`netName` connects pins globally: separate stubs sharing one name merge into one net (no ' +
      "label needed). NET_COLLISION guards touched points against a foreign net's wire, pin, or " +
      'flag/port — not mid-segment crossings.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addWireInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      wire: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addWireInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addWire', {
          points: p.points,
          netName: p.netName,
          color: p.color,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
        });
        return {
          success: true,
          wire: result,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_text',
    title: 'Add schematic text label',
    description:
      'Place free-standing text on the schematic sheet (section headers, notes, block labels) — ' +
      'cosmetic/organizational, not a net label. color must be a hex string and fontName a real ' +
      'font (e.g. "Arial") — untyped placeholders create nothing despite returning ok.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addTextInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      text: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addTextInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addText', {
          x: p.x,
          y: p.y,
          content: p.content,
          rotation: p.rotation,
          color: p.color,
          fontName: p.fontName,
          fontSize: p.fontSize,
          bold: p.bold,
          italic: p.italic,
          underline: p.underline,
          alignMode: p.alignMode,
        });
        return { success: true, text: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_rectangle',
    title: 'Add schematic rectangle',
    description:
      'Draw a rectangle on the schematic sheet — section dividers/grouping boxes for organizing ' +
      'a busy schematic into labeled functional blocks (pair with add_text for the title). ' +
      'Cosmetic only. x/y is the top-left corner; fillColor "none" leaves it unfilled.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addRectangleInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      rectangle: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addRectangleInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addRectangle', {
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          cornerRadius: p.cornerRadius,
          rotation: p.rotation,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
          fillStyle: p.fillStyle,
        });
        return { success: true, rectangle: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_circle',
    title: 'Add schematic circle',
    description:
      'Draw a circle on the schematic sheet — decorative marker or custom symbol element. ' +
      'Cosmetic only, no electrical meaning. fillColor "none" leaves it unfilled.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addCircleInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      circle: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addCircleInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addCircle', {
          centerX: p.centerX,
          centerY: p.centerY,
          radius: p.radius,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
          fillStyle: p.fillStyle,
        });
        return { success: true, circle: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_polygon',
    title: 'Add schematic polygon',
    description:
      'Draw a closed polygon on the schematic sheet from 3+ vertices — custom decorative shapes, ' +
      'callout arrows, or block diagram elements. Cosmetic only, no electrical meaning.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addPolygonInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      polygon: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addPolygonInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addPolygon', {
          points: p.points,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
        });
        return { success: true, polygon: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_delete_primitive',
    title: 'Delete schematic primitives',
    description:
      'Delete primitives by UUID. Single text deletion is supported only on EasyEDA Pro 4.1.105; ' +
      'unknown versions and mixed batches fail closed. Native success does not prove persistence: ' +
      'cold reopen to verify. Use projectId + transactionId for rollback-backed deletion. ' +
      'Without transactionId, deletion is standalone.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: deletePrimitiveInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      persistence_verified: z.boolean().optional(),
      transaction: z
        .object({
          id: z.string(),
          operations: z.array(
            z.object({
              operation_id: z.string(),
              operation_state: transactionOperationStateSchema,
              target_id: z.string(),
              before_hash: z.string().optional(),
              after_hash: z.string().optional(),
            }),
          ),
        })
        .optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveIds, projectId, transactionId } = deletePrimitiveInputSchema.parse(params);
      try {
        if (!transactionId || !projectId) {
          const response = await ctx.bridge.call('schematic.deletePrimitive', { primitiveIds });
          if (!isConfirmedNativeSchematicDeletion(response, primitiveIds)) {
            return {
              success: false,
              error_code: 'NATIVE_DELETE_UNVERIFIED',
              error:
                'Native delete did not verify every requested primitive. Inspect the sheet before retrying.',
            };
          }
          return { success: true, persistence_verified: false };
        }

        const operations = await deletePrimitivesInTransaction(
          ctx,
          projectId,
          transactionId,
          primitiveIds,
        );
        return {
          success: true,
          persistence_verified: false,
          transaction: {
            id: transactionId,
            operations: operations.map((operation) => ({
              operation_id: operation.id,
              operation_state: operation.state,
              target_id: operation.target.id,
              before_hash: operation.beforeHash,
              after_hash: operation.afterHash,
            })),
          },
        };
      } catch (err) {
        return transactionFailure(err);
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_modify_primitive',
    title: 'Modify schematic primitive',
    description:
      'Modify a schematic primitive while preserving omitted fields. With transactionId and projectId, ' +
      'snapshot and restore after failed writes/read-back. Connected or unverified component moves ' +
      'fail closed before mutation.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: modifyPrimitiveInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      result: z.unknown().optional(),
      transaction: z
        .object({
          id: z.string(),
          operation_id: z.string(),
          operation_state: transactionOperationStateSchema,
          before_hash: z.string(),
          after_hash: z.string().optional(),
        })
        .optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveId, property, projectId, transactionId } =
        modifyPrimitiveInputSchema.parse(params);
      try {
        if (!transactionId) {
          const result = await ctx.bridge.call('schematic.modifyPrimitive', {
            primitiveId,
            property,
          });
          return { success: true, result };
        }

        const manager = transactionManagerForProject(transactionId, projectId);
        const applied = await manager.runModify(transactionId, primitiveId, {
          getSnapshot: async () =>
            ctx.bridge.call('schematic.getPrimitiveSnapshot', { primitiveId }),
          apply: async () =>
            ctx.bridge.call('schematic.modifyPrimitive', {
              primitiveId,
              property,
            }),
          restore: async (snapshot) =>
            ctx.bridge.call('schematic.restorePrimitiveSnapshot', { snapshot }),
        });
        return {
          success: true,
          result: applied.result,
          transaction: {
            id: transactionId,
            operation_id: applied.operation.id,
            operation_state: applied.operation.state,
            before_hash: applied.operation.beforeHash,
            after_hash: applied.operation.afterHash,
          },
        };
      } catch (err) {
        return transactionFailure(err);
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_set_pin_no_connect',
    title: 'Set native pin No Connect state',
    description:
      "Set or clear EasyEDA Pro's native No Connect marker on one exact component pin. " +
      'This changes the component pin noConnected state; it does not create a net, label, ' +
      'power flag, or short-circuit flag. The bridge rejects missing/ambiguous pins and ' +
      'verifies the native readback after the write.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
    },
    inputSchema: setPinNoConnectInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      component_primitive_id: z.string(),
      pin_primitive_id: z.string().optional(),
      pin_number: z.string(),
      previous_no_connected: z.boolean().optional(),
      no_connected: z.boolean().optional(),
      changed: z.boolean().optional(),
      verified: z.boolean().optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = setPinNoConnectInputSchema.parse(params);
      try {
        const result = (await ctx.bridge.call('schematic.setPinNoConnect', {
          projectId: p.projectId,
          primitiveId: p.primitiveId,
          pinNumber: p.pinNumber,
          noConnected: p.noConnected,
        })) as {
          componentPrimitiveId?: string;
          pinPrimitiveId?: string;
          pinNumber?: string;
          previousNoConnected?: boolean;
          noConnected?: boolean;
          changed?: boolean;
          verified?: boolean;
        };
        return {
          success: true,
          project_id: p.projectId,
          component_primitive_id: result.componentPrimitiveId ?? p.primitiveId,
          pin_primitive_id: result.pinPrimitiveId,
          pin_number: result.pinNumber ?? p.pinNumber,
          previous_no_connected: result.previousNoConnected,
          no_connected: result.noConnected,
          changed: result.changed,
          verified: result.verified,
        };
      } catch (err) {
        const record =
          err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
        return {
          success: false,
          project_id: p.projectId,
          component_primitive_id: p.primitiveId,
          pin_number: p.pinNumber,
          error_code: typeof record?.code === 'string' ? record.code : undefined,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_create_net_flag',
    title: 'Create net flag',
    description:
      'Create a named net flag/label. With `identification` (Power/Ground/AnalogGround/' +
      'ProtectGround) it places a power-flag symbol binding to a coincident pin (use for ' +
      'VCC/GND). Without it, a generic net label — cosmetic only; connect pins with add_wire ' +
      'stubs sharing one netName.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name to assign (e.g. VCC, GND, TEST_NET)'),
      x: z.number().describe('X coordinate on the schematic canvas'),
      y: z.number().describe('Y coordinate on the schematic canvas'),
      rotation: z.number().optional().describe('Rotation in degrees (0, 90, 180, 270)'),
      identification: z
        .enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
        .optional()
        .describe(
          'Power-flag identification. When set, places an EasyEDA power/ground flag symbol of this type. ' +
            'When omitted, places a generic named net label instead.',
        ),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      netFlag: z
        .object({
          primitiveId: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        x: number;
        y: number;
        rotation?: number;
        identification?: string;
      };
      try {
        const result = await ctx.bridge.call('schematic.createNetFlag', {
          projectId: p.projectId,
          netName: p.netName,
          x: p.x,
          y: p.y,
          rotation: p.rotation,
          identification: p.identification,
        });
        const data = result as { primitiveId?: string; netName?: string };
        return {
          success: true,
          netFlag: {
            primitiveId: data.primitiveId ?? '',
            netName: data.netName ?? p.netName,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_create_net_port',
    title: 'Create net port',
    description:
      'Place a hierarchical net port (off-sheet connector) on the schematic. ' +
      'Net ports create named connections that span multiple schematic sheets, ' +
      'appearing as real SCH_Net entries in the netlist.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name for the port (e.g. VCC, GND, DATA_BUS)'),
      x: z.number().describe('X coordinate on the schematic canvas'),
      y: z.number().describe('Y coordinate on the schematic canvas'),
      portType: z
        .enum(['input', 'output', 'bidirectional', 'triState', 'passive'])
        .optional()
        .describe('Electrical type of the port'),
      rotation: z.number().optional().describe('Rotation in degrees (0, 90, 180, 270)'),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      netPort: z
        .object({
          primitiveId: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        x: number;
        y: number;
        portType?: string;
        rotation?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.createNetPort', {
          projectId: p.projectId,
          netName: p.netName,
          x: p.x,
          y: p.y,
          portType: p.portType,
          rotation: p.rotation,
        });
        const data = result as { primitiveId?: string; netName?: string };
        return {
          success: true,
          netPort: {
            primitiveId: data.primitiveId ?? '',
            netName: data.netName ?? p.netName,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_connect_pin_to_net',
    title: 'Connect pin to net',
    description:
      'Create real EasyEDA connectivity for a pin: draws a short wire stub from its exact ' +
      'coordinate, tagged with netName. Same-netName wires merge globally, so this joins the pin ' +
      'to everything else on that net — visible to ERC, ratsnest, and autorouting.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      primitiveId: z.string().describe('The primitive ID of the component'),
      pinNumber: z
        .string()
        .describe('The pin number or pin name on the component (e.g. "1", "VCC", "GND")'),
      netName: z
        .string()
        .min(1)
        .describe('The net name to connect the pin to (e.g. VCC, GND, DATA0)'),
      stubLength: z
        .number()
        .positive()
        .optional()
        .describe('Length of the wire stub drawn outward from the pin. Defaults to 10.'),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      real: z.boolean().optional(),
      created_primitive_id: z.string().optional(),
      endpoint: z.object({ x: z.number(), y: z.number() }).optional(),
      connection: z
        .object({
          primitiveId: z.string(),
          pinNumber: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        primitiveId: string;
        pinNumber: string;
        netName: string;
        stubLength?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinToNet', {
          projectId: p.projectId,
          primitiveId: p.primitiveId,
          pinNumber: p.pinNumber,
          netName: p.netName,
          stubLength: p.stubLength,
        });
        const data = result as {
          connected?: boolean;
          real?: boolean;
          primitiveId?: string;
          endpoint?: { x: number; y: number };
        };
        return {
          success: data?.connected !== false,
          real: data?.real,
          created_primitive_id: data?.primitiveId,
          endpoint: data?.endpoint,
          connection: {
            primitiveId: p.primitiveId,
            pinNumber: p.pinNumber,
            netName: p.netName,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_connect_pins_by_net',
    title: 'Connect pins by net',
    description:
      'Bulk variant of connect_pin_to_net: draws a real wire stub from each pin, tagged with ' +
      'netName, so all listed pins (and anything else already on that net) merge into one net. ' +
      'Visible to ERC, ratsnest, and autorouting. A pin that fails (e.g. collision) is reported ' +
      'in failures rather than aborting the batch.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name to assign pins to'),
      pins: z
        .array(
          z.object({
            primitiveId: z.string().describe('The primitive ID of the component'),
            pinNumber: z.string().describe('The pin number or name'),
          }),
        )
        .min(1)
        .max(500)
        .describe('List of component pins to connect to the net'),
      stubLength: z
        .number()
        .positive()
        .optional()
        .describe('Length of the wire stub drawn outward from each pin. Defaults to 10.'),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      real: z.boolean().optional(),
      created_primitive_ids: z.array(z.string()).optional(),
      failures: z
        .array(
          z.object({
            primitiveId: z.string(),
            pinNumber: z.string(),
            error: z.string(),
          }),
        )
        .optional(),
      connections: z
        .array(
          z.object({
            primitiveId: z.string(),
            pinNumber: z.string(),
            netName: z.string(),
          }),
        )
        .optional(),
      count: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        pins: Array<{ primitiveId: string; pinNumber: string }>;
        stubLength?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinsByNet', {
          projectId: p.projectId,
          netName: p.netName,
          pins: p.pins,
          stubLength: p.stubLength,
        });
        const data = result as {
          count?: number;
          real?: boolean;
          createdPrimitiveIds?: string[];
          failures?: Array<{ primitiveId: string; pinNumber: string; error: string }>;
        };
        const count = data?.count ?? p.pins.length;

        return {
          success: true,
          real: data?.real,
          created_primitive_ids: data?.createdPrimitiveIds,
          failures: data?.failures,
          connections: p.pins.map((pin) => ({
            primitiveId: pin.primitiveId,
            pinNumber: pin.pinNumber,
            netName: p.netName,
          })),
          count,
        };
      } catch (err) {
        return {
          success: false,
          count: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_project_save',
    title: 'Save project',
    description:
      'Save only the exact focused EasyEDA project/document. Native acknowledgment is ' +
      'NOT durable persistence: success=false until verified after cold reopen. ' +
      'On Pro 3.2.209, use GUI Ctrl+S then reopen the document to verify. ' +
      'Never blindly retry unverified writes.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID to save'),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      persistence_verified: z.boolean(),
      native_acknowledged: z.boolean(),
      status: z.string(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('project.save', {
          projectId,
          confirmWrite: true,
        });
        const data =
          result && typeof result === 'object'
            ? (result as { success?: unknown; status?: unknown })
            : null;
        const acknowledged =
          data?.success === true &&
          data?.status === 'native_save_acknowledged_persistence_unverified';
        if (!acknowledged) {
          return {
            success: false,
            project_id: projectId,
            persistence_verified: false,
            native_acknowledged: false,
            status: typeof data?.status === 'string' ? data.status : 'native_save_unconfirmed',
            error:
              'Native save did not confirm success; project persistence is unverified. ' +
              'Use EasyEDA GUI Ctrl+S, then close and reopen the exact document to verify. ' +
              'Do not retry the MCP write blindly.',
          };
        }
        return {
          success: false,
          project_id: projectId,
          persistence_verified: false,
          native_acknowledged: true,
          status: 'persistence_unverified',
          error:
            'EasyEDA acknowledged the save, but disk persistence is not verified. ' +
            'Do not retry blindly; use the EasyEDA GUI Ctrl+S, then close and reopen ' +
            'the exact project to verify the change.',
        };
      } catch {
        return {
          success: false,
          project_id: projectId,
          persistence_verified: false,
          native_acknowledged: false,
          status: 'native_outcome_unknown',
          error: 'Native save outcome is unknown; inspect the exact project before retrying.',
        };
      }
    },
  });

  const titleBlockFieldSchema = z.object({
    showTitle: z.boolean().optional(),
    showValue: z.boolean().optional(),
    value: z.union([z.string(), z.number()]).optional(),
  });

  registry.register({
    name: 'easyeda_schematic_set_title_block',
    title: 'Set schematic title block fields',
    description:
      'Update schematic title block text fields (Company, Version, Drawn, Reviewed, Page Size). ' +
      'Only these 5 are exposed — writing Symbol/Border/Device/etc once corrupted a real title ' +
      'block; those are read-only natively and must be fixed via the EasyEDA Pro UI.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      fields: z
        .strictObject({
          Company: titleBlockFieldSchema.optional(),
          Version: titleBlockFieldSchema.optional(),
          Drawn: titleBlockFieldSchema.optional(),
          Reviewed: titleBlockFieldSchema.optional(),
          'Page Size': titleBlockFieldSchema.optional(),
        })
        .describe(
          'Map of title block field name to the sub-fields to change, e.g. { "Company": { "value": "ACME", "showValue": true } }',
        ),
      showTitleBlock: z.boolean().optional().describe('Show/hide the whole title block'),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        fields: Record<
          string,
          { showTitle?: boolean; showValue?: boolean; value?: string | number }
        >;
        showTitleBlock?: boolean;
      };
      try {
        const result = await ctx.bridge.call('schematic.setTitleBlock', {
          fields: p.fields,
          showTitleBlock: p.showTitleBlock,
        });
        const data = result as { success?: boolean };
        return { success: data?.success ?? false };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_sync_to_pcb',
    title: 'Request schematic-to-PCB sync (needs human approval)',
    description:
      'Request a schematic-to-PCB sync (SCH_Document.importChanges). CAUTION (live-verified): ' +
      "opens a confirmation dialog in EasyEDA Pro's UI a HUMAN must approve — success here only " +
      'means the request was sent, not that components appeared. Ask the user to approve the ' +
      'dialog, then verify with pcb_components.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      confirmWrite: z
        .literal(true)
        .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      requested: z.boolean().optional(),
      note: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId?: string };
      try {
        if (projectId !== undefined) {
          // The scoped native read rejects a mismatched project or focused page
          // before requesting any PCB import dialog.
          const focused = await ctx.bridge.call('schematic.listComponents', {
            projectId,
            limit: 1,
            offset: 0,
            scope: 'focused',
          });
          if (
            !focused ||
            typeof focused !== 'object' ||
            !Array.isArray((focused as { items?: unknown }).items)
          ) {
            throw new Error('Unable to verify the active schematic project before PCB sync.');
          }
        }
        const result = await ctx.bridge.call('schematic.syncToPcb', { projectId });
        const data = result as { synced?: boolean } | null;
        if (data?.synced !== true) {
          return {
            success: false,
            requested: false,
            error:
              'EasyEDA did not confirm the import request. Inspect the native dialog and PCB state before retrying; synchronization is not verified.',
          };
        }
        return {
          success: true,
          requested: true,
          note: 'EasyEDA opened a confirmation dialog in its UI — ask the user to approve it, then verify with pcb_components before assuming the sync completed.',
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerSchematicWriteTools };

import {
  boundsInside,
  boundsOverlap,
  combineBounds,
  inflateBounds,
  translateBounds,
  type SchematicBounds,
  type SchematicPoint,
  type SchematicSheetGeometry,
} from '../schematic-engine/geometry.js';
import {
  compareConnectivityFingerprints,
  type ConnectivityFingerprint,
  type ConnectivityFingerprintDiff,
} from '../schematic-model/connectivity-fingerprint.js';
import { readStable, type StableReadOptions } from '../live/readback.js';
import { operationId, type SchematicOperation } from '../transactions/operation-log.js';
import {
  getPrimitiveSnapshot,
  rollbackEasyedaTransaction,
  type TransactionBridgeCaller,
} from '../transactions/easyeda.js';
import type { TransactionManager } from '../transactions/manager.js';
import type { TransactionRecord } from '../transactions/model.js';
import { checkPlacement, type PlacementConstraintRegion } from './placement.js';

export type AutofixPrimitiveType =
  | 'component'
  | 'text'
  | 'label'
  | 'annotation'
  | 'section-box'
  | 'section-title'
  | 'wire'
  | 'power-symbol'
  | 'no-connect';

export type AutofixCosmeticProperty = 'position' | 'bounds';

export interface LayoutAutofixPrimitive {
  id: string;
  primitiveType: AutofixPrimitiveType;
  origin: SchematicPoint;
  combinedBounds: SchematicBounds;
  sectionId?: string;
  locked?: boolean;
}

export type LayoutAutofixViolationCode =
  | 'TITLE_BLOCK_OVERLAP'
  | 'PAGE_BOUNDARY_OVERFLOW'
  | 'COMPONENT_OVERLAP'
  | 'TEXT_OVERLAP'
  | 'SECTION_BOX_TOO_SMALL';

export interface LayoutAutofixViolation {
  id: string;
  code: LayoutAutofixViolationCode;
  primitiveIds: string[];
  message: string;
}

export interface LayoutAutofixAllowlist {
  primitiveTypes: readonly AutofixPrimitiveType[];
  properties: readonly AutofixCosmeticProperty[];
}

export interface LayoutAutofixMove {
  id: string;
  primitiveId: string;
  primitiveType: AutofixPrimitiveType;
  property: AutofixCosmeticProperty;
  from: SchematicPoint | SchematicBounds;
  to: SchematicPoint | SchematicBounds;
  reason: string;
  expectedQaImprovement: string;
  resolvesViolationIds: string[];
}

export interface LayoutAutofixPreviewInput {
  sheet: SchematicSheetGeometry;
  primitives: readonly LayoutAutofixPrimitive[];
  allowlist: LayoutAutofixAllowlist;
  hardKeepouts?: readonly PlacementConstraintRegion[];
  callerReservedRegions?: readonly PlacementConstraintRegion[];
  minimumClearance?: number;
  maxMoves?: number;
}

export interface LayoutAutofixReport {
  fixed: string[];
  skipped: Array<{ violationId: string; reason: string }>;
  remaining: string[];
}

export interface LayoutAutofixPreview {
  mode: 'preview';
  requiresConfirmWrite: true;
  violations: LayoutAutofixViolation[];
  moves: LayoutAutofixMove[];
  report: LayoutAutofixReport;
  allowlist: LayoutAutofixAllowlist;
}

export interface ApplyLayoutAutofixOptions {
  confirmWrite: boolean;
  documentId: string;
  transactionManager: TransactionManager;
  bridge: TransactionBridgeCaller;
  readConnectivity: () => Promise<ConnectivityFingerprint>;
  operationFactory?: (move: LayoutAutofixMove, index: number) => SchematicOperation;
  batchSize?: number;
  stableRead?: StableReadOptions<ConnectivityFingerprint>;
}

export interface LayoutAutofixApplyResult {
  applied: boolean;
  transaction?: TransactionRecord;
  preview: LayoutAutofixPreview;
  beforeFingerprint?: ConnectivityFingerprint;
  afterFingerprint?: ConnectivityFingerprint;
  connectivityDiff?: ConnectivityFingerprintDiff;
  batchesVerified: number;
  actualStateReadAfterFailure: boolean;
  report: LayoutAutofixReport;
}

export class LayoutAutofixConnectivityError extends Error {
  constructor(
    message: string,
    readonly result: LayoutAutofixApplyResult,
  ) {
    super(message);
    this.name = 'LayoutAutofixConnectivityError';
  }
}

const TEXT_TYPES = new Set<AutofixPrimitiveType>(['text', 'label', 'annotation', 'section-title']);
const ELECTRICAL_TYPES = new Set<AutofixPrimitiveType>(['wire', 'power-symbol', 'no-connect']);

function violation(
  code: LayoutAutofixViolationCode,
  primitiveIds: readonly string[],
  message: string,
): LayoutAutofixViolation {
  const sortedIds = [...primitiveIds].sort((a, b) => a.localeCompare(b));
  return { id: `${code}:${sortedIds.join(':')}`, code, primitiveIds: sortedIds, message };
}

function detectViolations(input: LayoutAutofixPreviewInput): LayoutAutofixViolation[] {
  const result: LayoutAutofixViolation[] = [];
  const ordered = [...input.primitives].sort((a, b) => a.id.localeCompare(b.id));
  for (const primitive of ordered) {
    if (!boundsInside(primitive.combinedBounds, input.sheet.drawableBounds)) {
      result.push(
        violation(
          'PAGE_BOUNDARY_OVERFLOW',
          [primitive.id],
          `Primitive "${primitive.id}" extends beyond drawable sheet bounds.`,
        ),
      );
    }
    if (
      input.sheet.titleBlockBounds &&
      boundsOverlap(primitive.combinedBounds, input.sheet.titleBlockBounds)
    ) {
      result.push(
        violation(
          'TITLE_BLOCK_OVERLAP',
          [primitive.id],
          `Primitive "${primitive.id}" intersects the title block.`,
        ),
      );
    }
  }
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex];
    if (!left || left.primitiveType === 'section-box') continue;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex];
      if (!right || right.primitiveType === 'section-box') continue;
      if (!boundsOverlap(left.combinedBounds, right.combinedBounds)) continue;
      const isText = TEXT_TYPES.has(left.primitiveType) || TEXT_TYPES.has(right.primitiveType);
      result.push(
        violation(
          isText ? 'TEXT_OVERLAP' : 'COMPONENT_OVERLAP',
          [left.id, right.id],
          `Primitives "${left.id}" and "${right.id}" overlap.`,
        ),
      );
    }
  }
  for (const sectionBox of ordered.filter((item) => item.primitiveType === 'section-box')) {
    const children = ordered.filter(
      (item) => item.sectionId === sectionBox.sectionId && item.id !== sectionBox.id,
    );
    const childBounds = combineBounds(children.map((child) => child.combinedBounds));
    if (childBounds && !boundsInside(childBounds, sectionBox.combinedBounds)) {
      result.push(
        violation(
          'SECTION_BOX_TOO_SMALL',
          [sectionBox.id, ...children.map((child) => child.id)],
          `Section box "${sectionBox.id}" does not enclose all section content.`,
        ),
      );
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function propertyAllowed(
  primitive: LayoutAutofixPrimitive,
  property: AutofixCosmeticProperty,
  allowlist: LayoutAutofixAllowlist,
): boolean {
  if (primitive.locked || ELECTRICAL_TYPES.has(primitive.primitiveType)) return false;
  if (!allowlist.primitiveTypes.includes(primitive.primitiveType)) return false;
  if (!allowlist.properties.includes(property)) return false;
  if (property === 'bounds') return primitive.primitiveType === 'section-box';
  return primitive.primitiveType !== 'section-box';
}

function primitiveRegions(
  primitives: readonly LayoutAutofixPrimitive[],
  excludedIds: ReadonlySet<string>,
): PlacementConstraintRegion[] {
  return primitives
    .filter((primitive) => !excludedIds.has(primitive.id))
    .map((primitive) => ({
      id: `primitive:${primitive.id}`,
      kind: 'existing-object' as const,
      primitiveId: primitive.id,
      bounds: primitive.combinedBounds,
    }));
}

function moveForViolation(
  input: LayoutAutofixPreviewInput,
  target: LayoutAutofixPrimitive,
  issue: LayoutAutofixViolation,
): LayoutAutofixMove | undefined {
  const check = checkPlacement({
    sheet: input.sheet,
    candidate: {
      origin: target.origin,
      rotation: 0,
      combinedBounds: target.combinedBounds,
    },
    hardKeepouts: input.hardKeepouts,
    reservedRegions: input.callerReservedRegions,
    occupiedRegions: primitiveRegions(input.primitives, new Set([target.id])),
    minimumClearance: input.minimumClearance,
    maxAlternatives: 1,
    searchPreference: 'upper-left',
  });
  const alternative = check.suggestedAlternatives[0];
  if (!alternative) return undefined;
  return {
    id: `autofix:${issue.id}:${target.id}`,
    primitiveId: target.id,
    primitiveType: target.primitiveType,
    property: 'position',
    from: target.origin,
    to: alternative.origin,
    reason: issue.message,
    expectedQaImprovement: `Resolve ${issue.code} while preserving rendered clearance constraints.`,
    resolvesViolationIds: [issue.id],
  };
}

function resizeSectionBox(
  input: LayoutAutofixPreviewInput,
  target: LayoutAutofixPrimitive,
  issue: LayoutAutofixViolation,
): LayoutAutofixMove | undefined {
  const children = input.primitives.filter(
    (item) => item.sectionId === target.sectionId && item.id !== target.id,
  );
  const childBounds = combineBounds(children.map((child) => child.combinedBounds));
  if (!childBounds) return undefined;
  const proposed = inflateBounds(
    childBounds,
    Math.max(0, input.minimumClearance ?? input.sheet.grid),
  );
  if (!boundsInside(proposed, input.sheet.drawableBounds)) return undefined;
  if (input.sheet.titleBlockBounds && boundsOverlap(proposed, input.sheet.titleBlockBounds))
    return undefined;
  return {
    id: `autofix:${issue.id}:${target.id}`,
    primitiveId: target.id,
    primitiveType: target.primitiveType,
    property: 'bounds',
    from: target.combinedBounds,
    to: proposed,
    reason: issue.message,
    expectedQaImprovement: 'Resize the cosmetic section box to enclose its section content.',
    resolvesViolationIds: [issue.id],
  };
}

function moveTarget(
  issue: LayoutAutofixViolation,
  primitives: ReadonlyMap<string, LayoutAutofixPrimitive>,
  allowlist: LayoutAutofixAllowlist,
): LayoutAutofixPrimitive | undefined {
  const candidates = issue.primitiveIds
    .map((id) => primitives.get(id))
    .filter((item): item is LayoutAutofixPrimitive => item !== undefined)
    .filter((item) => propertyAllowed(item, 'position', allowlist));
  return candidates.sort((a, b) => {
    const aText = TEXT_TYPES.has(a.primitiveType) ? 0 : 1;
    const bText = TEXT_TYPES.has(b.primitiveType) ? 0 : 1;
    return aText - bText || b.id.localeCompare(a.id);
  })[0];
}

export function previewLayoutAutofix(input: LayoutAutofixPreviewInput): LayoutAutofixPreview {
  const violations = detectViolations(input);
  const byId = new Map(input.primitives.map((primitive) => [primitive.id, primitive]));
  const moves: LayoutAutofixMove[] = [];
  const skipped: LayoutAutofixReport['skipped'] = [];
  const maxMoves = Math.max(0, input.maxMoves ?? 100);
  const movedIds = new Set<string>();
  for (const issue of violations) {
    if (moves.length >= maxMoves) {
      skipped.push({
        violationId: issue.id,
        reason: 'The configured autofix move limit was reached.',
      });
      continue;
    }
    const sectionBox =
      issue.code === 'SECTION_BOX_TOO_SMALL'
        ? issue.primitiveIds
            .map((id) => byId.get(id))
            .find((item) => item?.primitiveType === 'section-box')
        : undefined;
    let move: LayoutAutofixMove | undefined;
    if (sectionBox && propertyAllowed(sectionBox, 'bounds', input.allowlist)) {
      move = resizeSectionBox(input, sectionBox, issue);
    } else {
      const target = moveTarget(issue, byId, input.allowlist);
      if (target && !movedIds.has(target.id)) move = moveForViolation(input, target, issue);
    }
    if (move) {
      moves.push(move);
      movedIds.add(move.primitiveId);
    } else {
      skipped.push({
        violationId: issue.id,
        reason: 'No explicitly allowed cosmetic change can resolve this violation safely.',
      });
    }
  }
  const proposed = new Set(moves.flatMap((move) => move.resolvesViolationIds));
  return {
    mode: 'preview',
    requiresConfirmWrite: true,
    violations,
    moves,
    report: {
      fixed: [],
      skipped,
      remaining: violations.filter((issue) => !proposed.has(issue.id)).map((issue) => issue.id),
    },
    allowlist: {
      primitiveTypes: [...input.allowlist.primitiveTypes],
      properties: [...input.allowlist.properties],
    },
  };
}

function defaultOperationFactory(move: LayoutAutofixMove, index: number): SchematicOperation {
  const input: Readonly<Record<string, unknown>> = {
    primitiveId: move.primitiveId,
    cosmeticOnly: true,
    changes: move.property === 'position' ? { position: move.to } : { bounds: move.to },
  };
  return {
    operationId: operationId('modifyComponent', input, index),
    kind: 'modifyComponent',
    input,
    targetPrimitiveIds: [move.primitiveId],
    order: index,
  };
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function appliedReport(preview: LayoutAutofixPreview): LayoutAutofixReport {
  const fixed = [...new Set(preview.moves.flatMap((move) => move.resolvesViolationIds))].sort(
    (a, b) => a.localeCompare(b),
  );
  return {
    fixed,
    skipped: preview.report.skipped,
    remaining: preview.violations
      .filter((issue) => !fixed.includes(issue.id))
      .map((issue) => issue.id),
  };
}

async function stableConnectivityRead(
  reader: () => Promise<ConnectivityFingerprint>,
  options: StableReadOptions<ConnectivityFingerprint> | undefined,
): Promise<ConnectivityFingerprint> {
  const read = await readStable(reader, {
    ...options,
    fingerprint: options?.fingerprint ?? ((value) => value.hash),
  });
  if (!read.stable) throw new Error('Connectivity readback did not stabilize.');
  return read.value;
}

export async function applyLayoutAutofix(
  preview: LayoutAutofixPreview,
  options: ApplyLayoutAutofixOptions,
): Promise<LayoutAutofixApplyResult> {
  if (!options.confirmWrite) {
    return {
      applied: false,
      preview,
      batchesVerified: 0,
      actualStateReadAfterFailure: false,
      report: preview.report,
    };
  }
  const beforeFingerprint = await stableConnectivityRead(
    options.readConnectivity,
    options.stableRead,
  );
  if (preview.moves.length === 0) {
    return {
      applied: false,
      preview,
      beforeFingerprint,
      afterFingerprint: beforeFingerprint,
      connectivityDiff: compareConnectivityFingerprints(beforeFingerprint, beforeFingerprint),
      batchesVerified: 0,
      actualStateReadAfterFailure: false,
      report: preview.report,
    };
  }
  const operationFactory = options.operationFactory ?? defaultOperationFactory;
  const operations = preview.moves.map((move, index) => operationFactory(move, index));
  const operationBatches = batches(operations, Math.max(1, options.batchSize ?? 20));
  const started = options.transactionManager.begin({
    documentId: options.documentId,
    label: 'schematic-layout-autofix',
  });
  const bridge = options.bridge;
  let verified = 0;
  let lastFingerprint = beforeFingerprint;
  try {
    for (const batch of operationBatches) {
      for (const operation of batch) {
        const targetId = operation.targetPrimitiveIds?.[0];
        if (!targetId) {
          throw new Error(`Operation ${operation.operationId} has no target primitive.`);
        }
        const changes = (operation.input as { changes?: unknown }).changes;
        await options.transactionManager.runModify(started.id, targetId, {
          getSnapshot: () => getPrimitiveSnapshot(bridge, targetId),
          apply: () =>
            bridge.call('schematic.modifyPrimitive', { primitiveId: targetId, property: changes }),
          restore: (snapshot) => bridge.call('schematic.restorePrimitiveSnapshot', { snapshot }),
        });
      }
      lastFingerprint = await stableConnectivityRead(options.readConnectivity, options.stableRead);
      const diff = compareConnectivityFingerprints(beforeFingerprint, lastFingerprint);
      if (!diff.equal) {
        await rollbackEasyedaTransaction(options.transactionManager, started.id, bridge);
        const result: LayoutAutofixApplyResult = {
          applied: false,
          transaction: options.transactionManager.get(started.id),
          preview,
          beforeFingerprint,
          afterFingerprint: lastFingerprint,
          connectivityDiff: diff,
          batchesVerified: verified,
          actualStateReadAfterFailure: true,
          report: preview.report,
        };
        throw new LayoutAutofixConnectivityError(
          'Layout autofix changed electrical connectivity; the transaction was rolled back.',
          result,
        );
      }
      verified += 1;
    }
    await options.transactionManager.validate(started.id, []);
    const transaction = options.transactionManager.commit(started.id);
    const diff = compareConnectivityFingerprints(beforeFingerprint, lastFingerprint);
    return {
      applied: true,
      transaction,
      preview,
      beforeFingerprint,
      afterFingerprint: lastFingerprint,
      connectivityDiff: diff,
      batchesVerified: verified,
      actualStateReadAfterFailure: false,
      report: appliedReport(preview),
    };
  } catch (error) {
    if (error instanceof LayoutAutofixConnectivityError) throw error;
    let actualStateReadAfterFailure = false;
    let afterFingerprint = lastFingerprint;
    try {
      afterFingerprint = await options.readConnectivity();
      actualStateReadAfterFailure = true;
    } catch {
      // Preserve the original write/transaction failure when readback is also unavailable.
    }
    try {
      await rollbackEasyedaTransaction(options.transactionManager, started.id, bridge);
    } catch {
      // The manager may already have rolled back after an apply timeout or adapter failure.
    }
    const diff = compareConnectivityFingerprints(beforeFingerprint, afterFingerprint);
    const result: LayoutAutofixApplyResult = {
      applied: false,
      transaction: options.transactionManager.get(started.id),
      preview,
      beforeFingerprint,
      afterFingerprint,
      connectivityDiff: diff,
      batchesVerified: verified,
      actualStateReadAfterFailure,
      report: preview.report,
    };
    throw new LayoutAutofixConnectivityError(
      error instanceof Error ? error.message : 'Layout autofix failed.',
      result,
    );
  }
}

export function applyPreviewMovesToGeometry(
  primitives: readonly LayoutAutofixPrimitive[],
  preview: LayoutAutofixPreview,
): LayoutAutofixPrimitive[] {
  const moveById = new Map(preview.moves.map((move) => [move.primitiveId, move]));
  return primitives.map((primitive) => {
    const move = moveById.get(primitive.id);
    if (!move)
      return {
        ...primitive,
        origin: { ...primitive.origin },
        combinedBounds: { ...primitive.combinedBounds },
      };
    if (move.property === 'bounds') {
      const bounds = move.to as SchematicBounds;
      return { ...primitive, origin: { x: bounds.x, y: bounds.y }, combinedBounds: { ...bounds } };
    }
    const origin = move.to as SchematicPoint;
    return {
      ...primitive,
      origin: { ...origin },
      combinedBounds: translateBounds(primitive.combinedBounds, {
        x: origin.x - primitive.origin.x,
        y: origin.y - primitive.origin.y,
      }),
    };
  });
}

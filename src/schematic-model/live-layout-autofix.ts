import { type ToolContext } from '../tools/types.js';
import { gatherLivePrimitiveBounds } from './live-primitive-bounds.js';
import { buildEngineSheetGeometry } from './live-functional-layout.js';
import { gatherLiveSchematicSnapshot } from './live-snapshot.js';
import { buildSchematicModel } from './model-builder.js';
import {
  createConnectivityFingerprint,
  type ConnectivityFingerprint,
  type ConnectivityFingerprintDiff,
} from './connectivity-fingerprint.js';
import {
  applyLayoutAutofix,
  previewLayoutAutofix,
  LayoutAutofixConnectivityError,
  type LayoutAutofixAllowlist,
  type LayoutAutofixApplyResult,
  type LayoutAutofixPreview,
  type LayoutAutofixPrimitive,
  type LayoutAutofixReport,
} from '../layout/autofix.js';
import type { PlacementConstraintRegion } from '../layout/placement.js';
import { getGlobalTransactionManager } from '../transactions/manager.js';

export interface GatherLiveLayoutAutofixPreviewOptions {
  allowlist?: Partial<LayoutAutofixAllowlist>;
  hardKeepouts?: readonly PlacementConstraintRegion[];
  callerReservedRegions?: readonly PlacementConstraintRegion[];
  minimumClearance?: number;
  maxMoves?: number;
}

export interface LiveLayoutAutofixPreviewResult {
  preview: LayoutAutofixPreview;
  primitiveCount: number;
  unavailablePrimitiveIds: string[];
}

const DEFAULT_ALLOWLIST: LayoutAutofixAllowlist = {
  primitiveTypes: ['component'],
  properties: ['position'],
};

/**
 * Reads live sheet geometry and every component's real rendered bounds, then
 * runs the pure `previewLayoutAutofix` engine against them -- read-only, no
 * writes. `schematic.listComponents` is the only bridge source available for
 * primitive identity, so every live primitive here is typed 'component';
 * text/label/annotation/section-box primitives (and therefore TEXT_OVERLAP /
 * SECTION_BOX_TOO_SMALL violations) are out of reach until the bridge exposes
 * them independently -- same limitation already documented on
 * easyeda_schematic_primitive_bounds.
 */
export async function gatherLiveLayoutAutofixPreview(
  ctx: ToolContext,
  projectId: string,
  options: GatherLiveLayoutAutofixPreviewOptions = {},
): Promise<LiveLayoutAutofixPreviewResult> {
  const sheetInfoResult = await ctx.bridge.call<{ projectId: string }, unknown>(
    'schematic.getSheetInfo',
    { projectId },
  );
  const sheet = buildEngineSheetGeometry(sheetInfoResult);

  const boundsBatch = await gatherLivePrimitiveBounds(ctx, projectId);
  const primitives: LayoutAutofixPrimitive[] = [];
  const unavailablePrimitiveIds: string[] = [];
  for (const item of boundsBatch.items) {
    if (!item.combinedBounds) {
      unavailablePrimitiveIds.push(item.id);
      continue;
    }
    primitives.push({
      id: item.id,
      primitiveType: 'component',
      origin: item.origin,
      combinedBounds: item.combinedBounds,
      locked: false,
    });
  }

  const allowlist: LayoutAutofixAllowlist = {
    primitiveTypes: options.allowlist?.primitiveTypes ?? DEFAULT_ALLOWLIST.primitiveTypes,
    properties: options.allowlist?.properties ?? DEFAULT_ALLOWLIST.properties,
  };

  const preview = previewLayoutAutofix({
    sheet,
    primitives,
    allowlist,
    hardKeepouts: options.hardKeepouts,
    callerReservedRegions: options.callerReservedRegions,
    minimumClearance: options.minimumClearance,
    maxMoves: options.maxMoves,
  });

  return { preview, primitiveCount: primitives.length, unavailablePrimitiveIds };
}

export interface ApplyLiveLayoutAutofixOptions extends GatherLiveLayoutAutofixPreviewOptions {
  /** Compute and return the preview only -- never opens a transaction or writes. */
  dryRun?: boolean;
  batchSize?: number;
}

export interface ApplyLiveLayoutAutofixResult {
  preview: LayoutAutofixPreview;
  primitiveCount: number;
  unavailablePrimitiveIds: string[];
  applied: boolean;
  batchesVerified: number;
  actualStateReadAfterFailure: boolean;
  beforeFingerprint?: ConnectivityFingerprint;
  afterFingerprint?: ConnectivityFingerprint;
  connectivityDiff?: ConnectivityFingerprintDiff;
  report: LayoutAutofixReport;
  transactionId?: string;
  transactionState?: string;
  errorCode?: string;
  error?: string;
}

async function readLiveConnectivityFingerprint(
  ctx: ToolContext,
  projectId: string,
): Promise<ConnectivityFingerprint> {
  const snapshot = await gatherLiveSchematicSnapshot(ctx, projectId);
  const model = buildSchematicModel(snapshot);
  return createConnectivityFingerprint(model);
}

function toApplyResult(
  base: Pick<
    ApplyLiveLayoutAutofixResult,
    'preview' | 'primitiveCount' | 'unavailablePrimitiveIds'
  >,
  engineResult: LayoutAutofixApplyResult,
  errorInfo?: { errorCode: string; error: string },
): ApplyLiveLayoutAutofixResult {
  return {
    ...base,
    applied: engineResult.applied,
    batchesVerified: engineResult.batchesVerified,
    actualStateReadAfterFailure: engineResult.actualStateReadAfterFailure,
    ...(engineResult.beforeFingerprint
      ? { beforeFingerprint: engineResult.beforeFingerprint }
      : {}),
    ...(engineResult.afterFingerprint ? { afterFingerprint: engineResult.afterFingerprint } : {}),
    ...(engineResult.connectivityDiff ? { connectivityDiff: engineResult.connectivityDiff } : {}),
    report: engineResult.report,
    ...(engineResult.transaction ? { transactionId: engineResult.transaction.id } : {}),
    ...(engineResult.transaction ? { transactionState: engineResult.transaction.state } : {}),
    ...(errorInfo ?? {}),
  };
}

/**
 * Recomputes the autofix preview against current live state, then -- unless
 * dryRun is set or there are no moves to make -- applies it through the
 * shared global TransactionManager with batch-by-batch connectivity-
 * fingerprint verification (applyLayoutAutofix). Any connectivity change,
 * write failure, or readback instability rolls the whole transaction back;
 * this function never throws for those cases, it reports them in the
 * returned errorCode/error fields instead (mirroring handleSchematicBatchWrite's
 * catch-and-report convention).
 */
export async function applyLiveLayoutAutofix(
  ctx: ToolContext,
  projectId: string,
  options: ApplyLiveLayoutAutofixOptions = {},
): Promise<ApplyLiveLayoutAutofixResult> {
  const { preview, primitiveCount, unavailablePrimitiveIds } = await gatherLiveLayoutAutofixPreview(
    ctx,
    projectId,
    options,
  );

  if (options.dryRun) {
    return {
      preview,
      primitiveCount,
      unavailablePrimitiveIds,
      applied: false,
      batchesVerified: 0,
      actualStateReadAfterFailure: false,
      report: preview.report,
    };
  }

  const base = { preview, primitiveCount, unavailablePrimitiveIds };
  const transactionManager = getGlobalTransactionManager();
  try {
    const result = await applyLayoutAutofix(preview, {
      confirmWrite: true,
      documentId: projectId,
      transactionManager,
      bridge: ctx.bridge,
      readConnectivity: () => readLiveConnectivityFingerprint(ctx, projectId),
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    });
    return toApplyResult(base, result);
  } catch (error) {
    if (error instanceof LayoutAutofixConnectivityError) {
      return toApplyResult(base, error.result, {
        errorCode: 'AUTOFIX_ROLLED_BACK',
        error: error.message,
      });
    }
    return {
      ...base,
      applied: false,
      batchesVerified: 0,
      actualStateReadAfterFailure: false,
      report: preview.report,
      errorCode: 'AUTOFIX_APPLY_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

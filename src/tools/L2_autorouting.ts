import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { planFloorplan, type FloorplanInput } from '../pcb-layout/floorplan.js';
import {
  applyLayoutOperations,
  layoutIssueSchema,
  layoutOperationSchema,
  layoutApplyResultSchema,
} from './L1_pcb_write.js';
import { validateCircuitIR } from '../circuit/circuit-ir.js';
import {
  validatePcbConstraints,
  buildConstraintReport,
  type PcbConstraintInput,
} from '../pcb-constraints/index.js';
import { pcbBoardDataSchema, fetchBoardDataFromBridge } from './L1_pcb_constraints.js';

const pointSchema = z.object({ x: z.number(), y: z.number() });

const floorplanDeviceInputSchema = z.object({
  deviceId: z.string().min(1),
  ref: z.string().min(1),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  rotation: z.number().optional(),
  primitiveId: z.string().optional(),
  footprint: z.string().optional(),
});

// ── easyeda_pcb_floorplan ───────────────────────────────────────────────────

function registerFloorplanTool(registry: { register: (def: ToolDefinition) => void }) {
  registry.register({
    name: 'easyeda_pcb_floorplan',
    title: 'Plan or apply a CircuitIR-driven component floorplan',
    description:
      'Translate CircuitIR physical constraints (keepouts, top/bottom side, connector-edge, ' +
      'thermal spacing) into a component group placement plan, then optionally apply it. ' +
      'CircuitIR devices carry no physical dimensions, so widths/heights must be supplied ' +
      'per device (confirmWrite required).',
    profile: 'full',
    evidence: ['inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      circuitIR: z.unknown(),
      devices: z.array(floorplanDeviceInputSchema).min(1),
      projectId: z.string().optional(),
      mode: z.enum(['preview', 'apply']).default('preview'),
      board: z.object({ widthMm: z.number().positive(), heightMm: z.number().positive() }),
      anchor: pointSchema,
      columns: z.number().int().positive().optional(),
      spacingMm: z.number().nonnegative().optional(),
      minSpacingMm: z.number().nonnegative().optional(),
      topLayer: z.number().int().optional(),
      bottomLayer: z.number().int().optional(),
      connectorEdge: z.enum(['top', 'bottom', 'left', 'right']).optional(),
      connectorEdgeMarginMm: z.number().nonnegative().optional(),
      thermalSpacingBoostMm: z.number().nonnegative().optional(),
      thermalDissipationThresholdWatts: z.number().nonnegative().optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      transaction_id: z.string(),
      mode: z.string(),
      applied: z.boolean(),
      blocked: z.boolean(),
      placements: z.array(
        z.object({
          ref: z.string(),
          primitiveId: z.string().optional(),
          footprint: z.string().optional(),
          x: z.number(),
          y: z.number(),
          rotation: z.number(),
          layer: z.number(),
          widthMm: z.number(),
          heightMm: z.number(),
        }),
      ),
      operations: z.array(layoutOperationSchema),
      apply_results: z.array(layoutApplyResultSchema).optional(),
      issues: z.array(layoutIssueSchema),
      floorplan_notes: z.array(z.string()),
      summary: z.string(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as Omit<FloorplanInput, 'circuitIR'> & {
        circuitIR: unknown;
        confirmWrite?: boolean;
      };

      let circuitIR;
      try {
        circuitIR = validateCircuitIR(p.circuitIR);
      } catch (err) {
        return {
          success: false,
          project_id: p.projectId ?? '',
          transaction_id: '',
          mode: p.mode ?? 'preview',
          applied: false,
          blocked: true,
          placements: [],
          operations: [],
          issues: [],
          floorplan_notes: [],
          summary: 'CircuitIR validation failed.',
          not_available: true,
          // CircuitError extends Error, so this also covers the CircuitError case.
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const plan = planFloorplan({ ...p, circuitIR });
      const base = {
        project_id: plan.projectId,
        transaction_id: plan.transactionId,
        mode: plan.mode,
        placements: plan.placements,
        operations: plan.operations,
        issues: plan.issues,
        floorplan_notes: plan.floorplanNotes,
      };

      if (p.mode !== 'apply') {
        return {
          ...base,
          success: !plan.blocked,
          applied: false,
          blocked: plan.blocked,
          summary: plan.summary,
        };
      }

      if (plan.blocked) {
        return {
          ...base,
          success: false,
          applied: false,
          blocked: true,
          summary: plan.summary,
          error: 'Floorplan contains blocking constraint errors.',
        };
      }

      if (p.confirmWrite !== true) {
        return {
          ...base,
          success: false,
          applied: false,
          blocked: true,
          summary: 'Apply blocked because confirmWrite=true was not provided.',
          error: 'confirmWrite=true is required to apply a floorplan.',
        };
      }

      const applyResults = await applyLayoutOperations(ctx, plan.operations);
      const failed = applyResults.some((result) => !result.success);
      return {
        ...base,
        success: !failed,
        applied: !failed,
        blocked: false,
        apply_results: applyResults,
        summary: failed
          ? 'Floorplan apply failed before all operations completed.'
          : `Applied ${applyResults.length} placement operation(s).`,
        error: applyResults.find((result) => !result.success)?.error,
      };
    },
  });
}

// ── easyeda_pcb_autoroute ────────────────────────────────────────────────────

/**
 * Numeric enum values from `@jlceda/pro-api-types`' `EPCB_AutoRoutingCornerStyle` /
 * `EPCB_AutoRoutingOptimization` — the live EasyEDA Pro API expects these exact
 * numbers, not our friendlier string labels.
 */
const CORNER_STYLE_VALUES: Record<'45' | '90', number> = { '45': 0, '90': 1 };
const OPTIMIZATION_VALUES: Record<'completion' | 'faster', number> = { completion: 1, faster: 0 };

function computeOverallVerdict(
  autorouteStarted: boolean,
  drcPassed: boolean | undefined,
  constraintVerdict: string | undefined,
): 'success' | 'partial' | 'failed' {
  if (!autorouteStarted) return 'failed';
  if ((drcPassed ?? true) && constraintVerdict === 'approved') return 'success';
  return 'partial';
}

function summaryForVerdict(verdict: 'success' | 'partial' | 'failed'): string {
  if (verdict === 'success')
    return 'Autoroute completed and post-route DRC/constraint checks passed.';
  if (verdict === 'partial') {
    return 'Autoroute completed but post-route checks found issues requiring review.';
  }
  return 'Autoroute did not complete successfully.';
}

/**
 * The native autorouter runs far longer than an ordinary bridge call. With the default bridge
 * timeout (15 s) the call was reported as failed on a 33-component, 2-layer board while EasyEDA
 * Pro 4.1.105 kept routing and added the tracks. Wait up to 10 minutes for the result.
 */
const AUTOROUTE_TIMEOUT_MS = 10 * 60 * 1000;

type GateMode = 'warn' | 'block';

interface AutoroutePreflightSummary {
  error_count: number;
  warning_count: number;
  unknown_count: number;
  unknown_checks: Array<{ area: string; missingFields: string[] }>;
  gate_mode: GateMode;
}

/**
 * Pre-flight for easyeda_pcb_autoroute. Bridge-derived evidence is the base and caller-supplied
 * boardData overrides it field by field, so a caller that knows a few facts does not lose what
 * the bridge already measured. Errors always block. Unknown checks (missing
 * evidence) block only in 'block' mode, the default: autorouting is a layout step, not a
 * production sign-off, so a caller may choose 'warn' to route while the unknowns stay reported.
 */
async function runAutoroutePreflight(
  ctx: ToolContext,
  projectId: string,
  boardData: Partial<PcbConstraintInput> | undefined,
  gateMode: GateMode,
): Promise<{ response?: Record<string, unknown>; summary: AutoroutePreflightSummary }> {
  let bridgeInput: PcbConstraintInput = {};
  try {
    bridgeInput = await fetchBoardDataFromBridge(ctx, projectId);
  } catch (err) {
    if (!boardData) {
      return {
        response: {
          success: false,
          project_id: projectId,
          overall_verdict: 'failed' as const,
          blocked_by_preflight: false,
          summary: 'Failed to gather board data for the pre-flight constraint check.',
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        },
        summary: emptyPreflightSummary(gateMode),
      };
    }
  }
  const result = validatePcbConstraints(mergeBoardData(bridgeInput, boardData));
  const summary: AutoroutePreflightSummary = {
    error_count: result.errors.length,
    warning_count: result.warnings.length,
    unknown_count: result.unknownChecks.length,
    unknown_checks: result.unknownChecks,
    gate_mode: gateMode,
  };
  // Known errors block in every mode: gateMode only decides what missing evidence does.
  const blockedByErrors = summary.error_count > 0;
  const blockedByUnknowns = gateMode === 'block' && summary.unknown_count > 0;
  if (!blockedByErrors && !blockedByUnknowns) return { summary };
  return {
    response: {
      success: false,
      project_id: projectId,
      overall_verdict: 'blocked' as const,
      blocked_by_preflight: true,
      preflight: { passed: false, ...summary },
      summary: preflightBlockSummary(summary),
    },
    summary,
  };
}

function emptyPreflightSummary(gateMode: GateMode): AutoroutePreflightSummary {
  return {
    error_count: 0,
    warning_count: 0,
    unknown_count: 0,
    unknown_checks: [],
    gate_mode: gateMode,
  };
}

function mergeBoardData(
  bridgeData: PcbConstraintInput,
  callerData: Partial<PcbConstraintInput> | undefined,
): PcbConstraintInput {
  if (!callerData) return bridgeData;
  const merged: Record<string, unknown> = { ...bridgeData };
  for (const [key, value] of Object.entries(callerData)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as PcbConstraintInput;
}

function preflightBlockSummary(summary: AutoroutePreflightSummary): string {
  const counts =
    `${summary.error_count} error(s), ${summary.warning_count} warning(s), ` +
    `${summary.unknown_count} unknown check(s)`;
  if (summary.error_count > 0) {
    return `Autoroute blocked by the pre-flight constraint check: ${counts}. Fix the errors before autorouting.`;
  }
  const areas = summary.unknown_checks.map((u) => u.area).join(', ');
  return (
    `Autoroute blocked by the pre-flight constraint check (gateMode '${summary.gate_mode}'): ` +
    `${counts}. No evidence for: ${areas}. Supply those fields in boardData, or pass gateMode ` +
    "'warn' to route while reporting them."
  );
}

function registerAutorouteTool(registry: { register: (def: ToolDefinition) => void }) {
  registry.register({
    name: 'easyeda_pcb_autoroute',
    title: 'Run EasyEDA Pro autorouting with pre-flight and post-route checks',
    description:
      "Drive EasyEDA Pro's native autorouter (PCB_Document.autoRouting, @beta) after a pre-flight " +
      'check (boardData merged over bridge evidence; errors block, unknown checks block unless ' +
      "gateMode is 'warn'), then attach DRC and a constraint report (confirmWrite required).",
    profile: 'pro',
    evidence: ['pro-api-types'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      routingNets: z
        .union([z.literal('selected'), z.literal('selectedComponents'), z.array(z.string())])
        .optional(),
      cornerStyle: z.enum(['45', '90']).optional(),
      existingPrimitiveMode: z.enum(['keep', 'remove']).optional(),
      optimization: z.enum(['completion', 'faster']).optional(),
      layers: z.array(z.number().int()).optional(),
      ignoreNets: z.array(z.string()).optional(),
      boardData: pcbBoardDataSchema.optional(),
      gateMode: z.enum(['warn', 'block']).optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      overall_verdict: z.enum(['success', 'partial', 'blocked', 'failed']),
      blocked_by_preflight: z.boolean(),
      preflight: z
        .object({
          passed: z.boolean(),
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
          unknown_count: z.number().int().nonnegative().optional(),
          unknown_checks: z
            .array(z.object({ area: z.string(), missingFields: z.array(z.string()) }))
            .optional(),
          gate_mode: z.enum(['warn', 'block']).optional(),
        })
        .optional(),
      autoroute_result: z
        .object({
          started: z.boolean(),
          total_nets_count: z.number().int().nonnegative().optional(),
          success_nets_count: z.number().int().nonnegative().optional(),
          failed_nets: z.array(z.string()).optional(),
          duration_ms: z.number().nonnegative().optional(),
        })
        .optional(),
      post_route_drc: z
        .object({
          passed: z.boolean(),
          total_violations: z.number().int().nonnegative(),
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
        })
        .optional(),
      post_route_constraint_report: z
        .object({
          verdict: z.string(),
          manual_review_required_count: z.number().int().nonnegative(),
        })
        .optional(),
      summary: z.string(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        routingNets?: 'selected' | 'selectedComponents' | string[];
        cornerStyle?: '45' | '90';
        existingPrimitiveMode?: 'keep' | 'remove';
        optimization?: 'completion' | 'faster';
        layers?: number[];
        ignoreNets?: string[];
        boardData?: Partial<PcbConstraintInput>;
        gateMode?: 'warn' | 'block';
        confirmWrite?: boolean;
      };
      const gateMode = p.gateMode ?? 'block';

      if (p.confirmWrite !== true) {
        return {
          success: false,
          project_id: p.projectId,
          overall_verdict: 'blocked' as const,
          blocked_by_preflight: false,
          summary: 'Apply blocked because confirmWrite=true was not provided.',
          error: 'confirmWrite=true is required to run autorouting.',
        };
      }

      const preflight = await runAutoroutePreflight(ctx, p.projectId, p.boardData, gateMode);
      if (preflight.response) return preflight.response;
      const preflightSummary = preflight.summary;

      let autorouteStarted: boolean;
      let autorouteResult:
        | {
            started: boolean;
            total_nets_count?: number;
            success_nets_count?: number;
            failed_nets?: string[];
            duration_ms?: number;
          }
        | undefined;
      let autorouteError: string | undefined;

      try {
        const props = {
          RoutingNets: p.routingNets,
          cornerStyle: p.cornerStyle ? CORNER_STYLE_VALUES[p.cornerStyle] : undefined,
          existingPrimitiveMode: p.existingPrimitiveMode,
          optimization: p.optimization ? OPTIMIZATION_VALUES[p.optimization] : undefined,
          layers: p.layers,
          ignoreNets: p.ignoreNets,
        };
        const result = await ctx.bridge.call(
          'api.call',
          { path: 'PCB_Document.autoRouting', args: [props] },
          { timeoutMs: AUTOROUTE_TIMEOUT_MS },
        );
        const data = result as { result?: Record<string, unknown> };
        const inner = (data.result ?? data) as {
          success?: boolean;
          totalNetsCount?: number;
          successNetsCount?: number;
          failedNets?: string[];
          duration?: number;
        };
        autorouteStarted = inner.success !== false;
        autorouteResult = {
          started: autorouteStarted,
          total_nets_count: inner.totalNetsCount,
          success_nets_count: inner.successNetsCount,
          failed_nets: inner.failedNets,
          duration_ms: inner.duration,
        };
      } catch (err) {
        autorouteError = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          project_id: p.projectId,
          overall_verdict: 'failed' as const,
          blocked_by_preflight: false,
          preflight: { passed: true, ...preflightSummary },
          summary:
            'Autoroute call failed. PCB_Document.autoRouting is a @beta EasyEDA Pro API and may ' +
            'not be available in every EasyEDA Pro version — check easyeda_api_inventory.',
          not_available: true,
          error: autorouteError,
        };
      }

      let drcSummary:
        | { passed: boolean; total_violations: number; error_count: number; warning_count: number }
        | undefined;
      try {
        const drc = await ctx.bridge.call('design.drc', { projectId: p.projectId });
        const data = drc as {
          violations?: Array<{ severity?: string }>;
          totalViolations?: number;
          errorCount?: number;
          warningCount?: number;
          passed?: boolean;
        };
        const violations = data.violations ?? [];
        const errorCount =
          data.errorCount ?? violations.filter((v) => v.severity === 'error').length;
        const warningCount =
          data.warningCount ?? violations.filter((v) => v.severity === 'warning').length;
        drcSummary = {
          passed: data.passed ?? errorCount === 0,
          total_violations: data.totalViolations ?? violations.length,
          error_count: errorCount,
          warning_count: warningCount,
        };
      } catch {
        drcSummary = undefined;
      }

      let constraintReportSummary:
        { verdict: string; manual_review_required_count: number } | undefined;
      try {
        const postRouteInput = await fetchBoardDataFromBridge(ctx, p.projectId);
        const postRouteResult = validatePcbConstraints(postRouteInput);
        const report = buildConstraintReport(postRouteInput, postRouteResult);
        constraintReportSummary = {
          verdict: report.verdict,
          manual_review_required_count: report.manualReviewRequired.length,
        };
      } catch {
        constraintReportSummary = undefined;
      }

      const overallVerdict = computeOverallVerdict(
        autorouteStarted,
        drcSummary?.passed,
        constraintReportSummary?.verdict,
      );

      return {
        success: autorouteStarted,
        project_id: p.projectId,
        overall_verdict: overallVerdict,
        blocked_by_preflight: false,
        preflight: { passed: true, ...preflightSummary },
        autoroute_result: autorouteResult,
        post_route_drc: drcSummary,
        post_route_constraint_report: constraintReportSummary,
        summary: summaryForVerdict(overallVerdict),
      };
    },
  });
}

// ── easyeda_pcb_export_route_context ────────────────────────────────────────

interface BinaryBridgeResult {
  base64?: string;
  fileName?: string;
}

function writeRouteContextFile(
  ctx: ToolContext,
  data: unknown,
  requestedPath: string | undefined,
  defaultFileName: string,
): { ok: boolean; filePath?: string; byteLength?: number; error?: string } {
  if (
    data === undefined ||
    data === null ||
    (typeof data === 'object' && Object.keys(data).length === 0)
  ) {
    return { ok: false, error: 'Bridge did not return route-context data.' };
  }
  const binary = data as BinaryBridgeResult;
  if (typeof binary.base64 !== 'string') {
    return { ok: false, error: 'Bridge did not return binary route-context data.' };
  }
  const buffer = Buffer.from(binary.base64, 'base64');
  const fileName = binary.fileName || defaultFileName;
  const artifactDir = path.resolve(ctx.config.artifactDir);
  const target = requestedPath ? path.resolve(requestedPath) : path.resolve(artifactDir, fileName);
  const relative = path.relative(artifactDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: 'File path must be inside the artifact directory.' };
  }
  const parentDir = path.dirname(target);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(target, buffer);
  return { ok: true, filePath: target, byteLength: buffer.byteLength };
}

function registerExportRouteContextTool(registry: { register: (def: ToolDefinition) => void }) {
  registry.register({
    name: 'easyeda_pcb_export_route_context',
    title: 'Export a vendor-neutral routing context (DSN) for external autorouters',
    description:
      'Export the board as a Specctra DSN file (PCB_ManufactureData.getDsnFile) — an open, ' +
      'vendor-neutral format supported by external autorouters such as FreeRouting. Re-import ' +
      "the routed result through EasyEDA Pro's own SES/DSN import, not through this server.",
    profile: 'pro',
    evidence: ['pro-api-types'],
    risk: 'low',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      filePath: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      artifact_path: z.string().optional(),
      byte_length: z.number().int().nonnegative().optional(),
      exported: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, filePath } = params as { projectId: string; filePath?: string };
      try {
        const result = await ctx.bridge.call('pcb.exportRouteContext', {
          fileName: `${projectId}-route-context`,
        });
        const written = writeRouteContextFile(
          ctx,
          result,
          filePath,
          `${projectId}-route-context.dsn`,
        );
        if (!written.ok) {
          return {
            project_id: projectId,
            exported: false,
            not_available: true,
            error: written.error,
          };
        }
        return {
          project_id: projectId,
          artifact_path: written.filePath,
          byte_length: written.byteLength,
          exported: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          exported: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

function registerAutoroutingTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registerFloorplanTool(registry);
  registerAutorouteTool(registry);
  registerExportRouteContextTool(registry);
}

export { registerAutoroutingTools };

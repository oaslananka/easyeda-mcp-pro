import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { validatePcbConstraints, buildConstraintReport } from '../pcb-constraints/index.js';
import type { PcbConstraintInput } from '../pcb-constraints/types.js';
import type { ReviewObservation } from '../engineering-review/report.js';

export const pcbBoardDataSchema = z.object({
  widthMm: z.number().nonnegative().optional(),
  heightMm: z.number().nonnegative().optional(),
  layerCount: z.number().int().nonnegative().optional(),
  hasOutline: z.boolean().optional(),
  mountingHoleCount: z.number().int().nonnegative().optional(),
  hasLayerStack: z.boolean().optional(),
  hasNetClasses: z.boolean().optional(),
  hasClearanceRules: z.boolean().optional(),
  hasKeepoutAreas: z.boolean().optional(),
  hasPlacementZones: z.boolean().optional(),
  hasFiducials: z.boolean().optional(),
  hasTestPads: z.boolean().optional(),
  hasDrillFile: z.boolean().optional(),
  minCopperToEdgeMm: z.number().nonnegative().optional(),
  copperToEdgeViolationCount: z.number().int().nonnegative().optional(),
  minDrillMm: z.number().nonnegative().optional(),
  minAnnularRingMm: z.number().nonnegative().optional(),
  minSolderMaskSliverMm: z.number().nonnegative().optional(),
  solderMaskSliverViolationCount: z.number().int().nonnegative().optional(),
  silkscreenOverPadCount: z.number().int().nonnegative().optional(),
  smtComponentCount: z.number().int().nonnegative().optional(),
  fiducialCount: z.number().int().nonnegative().optional(),
  toolingHoleCount: z.number().int().nonnegative().optional(),
  polarizedComponentCount: z.number().int().nonnegative().optional(),
  polarityMarkCount: z.number().int().nonnegative().optional(),
  componentSpacingViolationCount: z.number().int().nonnegative().optional(),
  criticalNetNames: z.array(z.string()).optional(),
  testPointNets: z.array(z.string()).optional(),
  hasProgrammingHeader: z.boolean().optional(),
  requiresProgrammingHeader: z.boolean().optional(),
  hasFabricationNotes: z.boolean().optional(),
  hasHighVoltage: z.boolean().optional(),
  manufacturingProcess: z.string().optional(),
  hasQuantity: z.boolean().optional(),
});

const pcbUnknownSchema = z.object({
  area: z.string(),
  missingFields: z.array(z.string()),
});

const pcbIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.string(),
  path: z.string().optional(),
  remediationHint: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

function mapPcbIssue(issue: {
  code: string;
  message: string;
  severity: string;
  path?: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}) {
  return {
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    path: issue.path,
    remediationHint: issue.remediationHint,
    details: issue.details,
  };
}

function resolvedObject(result: PromiseSettledResult<unknown>): Record<string, unknown> {
  if (
    result.status !== 'fulfilled' ||
    result.value === null ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  )
    return {};
  return result.value as Record<string, unknown>;
}

function measuredNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function measuredCount(value: unknown, minimum = 0): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : undefined;
}

function measuredStackup(record: Record<string, unknown>): boolean | undefined {
  if (typeof record.available === 'boolean') return record.available;
  return Array.isArray(record.layers) && record.layers.length > 0 ? true : undefined;
}

/**
 * Fetch board data from the live EasyEDA bridge when no explicit boardData is provided.
 * Queries dimensions, layers, and stackup in parallel via Promise.allSettled.
 */
export async function fetchBoardEvidenceFromBridge(
  ctx: ToolContext,
  projectId: string,
): Promise<{ data: PcbConstraintInput; observations: ReviewObservation[] }> {
  const methods = [
    'board.getDimensions',
    'board.listLayers',
    'board.getStackup',
    'board.getDesignRules',
  ];
  if (!ctx.bridge.connected) {
    return {
      data: {},
      observations: methods.map((method) => ({
        method,
        status: 'unavailable',
        guidance: 'Connect the EasyEDA bridge and focus the PCB document.',
      })),
    };
  }
  const [dimensionsResult, layersResult, stackupResult, designRulesResult] =
    await Promise.allSettled([
      ctx.bridge.call('board.getDimensions', { projectId }),
      ctx.bridge.call('board.listLayers', { projectId }),
      ctx.bridge.call('board.getStackup', { projectId }),
      ctx.bridge.call('board.getDesignRules', { projectId }),
    ]);

  // A failed API call or an absent property is UNKNOWN, not evidence of absence.
  // board.listLayers is a catalogue of visible/non-copper layers, never a copper count.
  void layersResult;
  const dimensions = resolvedObject(dimensionsResult);
  const stackup = resolvedObject(stackupResult);
  const designRules = resolvedObject(designRulesResult);
  const results = [dimensionsResult, layersResult, stackupResult, designRulesResult];
  const observations: ReviewObservation[] = methods.map((method, index) => ({
    method,
    status: results[index]?.status === 'fulfilled' ? 'observed' : 'unavailable',
    ...(results[index]?.status === 'rejected'
      ? { guidance: 'Native read unavailable. Check the active PCB tab and EasyEDA capabilities.' }
      : {}),
  }));
  return {
    data: {
      widthMm: measuredNonnegative(dimensions.widthMm),
      heightMm: measuredNonnegative(dimensions.heightMm),
      hasOutline: typeof dimensions.hasOutline === 'boolean' ? dimensions.hasOutline : undefined,
      mountingHoleCount: measuredCount(dimensions.mountingHoleCount),
      minDrillMm: measuredNonnegative(dimensions.minDrillMm),
      hasClearanceRules:
        typeof designRules.hasClearanceRules === 'boolean'
          ? designRules.hasClearanceRules
          : undefined,
      layerCount: measuredCount(stackup.totalLayers, 2),
      hasLayerStack: measuredStackup(stackup),
    },
    observations,
  };
}

/** Backward-compatible raw board data reader used by existing constraint tools. */
export async function fetchBoardDataFromBridge(
  ctx: ToolContext,
  projectId: string,
): Promise<PcbConstraintInput> {
  return (await fetchBoardEvidenceFromBridge(ctx, projectId)).data;
}
function registerPcbConstraintTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_pcb_constraint_check',
    title: 'Check PCB constraints',
    description:
      'Run PCB constraint validation against the board design. Checks board outline, layer stackup, net classes, clearance rules, keepout areas, placement zones, mounting holes, fiducials, and manufacturing constraints.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'pcb-constraints',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      boardData: pcbBoardDataSchema.optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      valid: z.boolean(),
      errors: z.array(pcbIssueSchema),
      warnings: z.array(pcbIssueSchema),
      summary: z.object({
        totalChecks: z.number(),
        passed: z.number(),
        failed: z.number(),
        notApplicable: z.number(),
        unknown: z.number(),
      }),
      unknown_checks: z.array(pcbUnknownSchema),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, boardData } = params as {
        projectId: string;
        boardData?: Partial<PcbConstraintInput>;
      };

      try {
        // Try to get board data from the live EasyEDA board if no explicit data provided
        let input: PcbConstraintInput;

        if (boardData) {
          input = boardData as PcbConstraintInput;
        } else {
          input = await fetchBoardDataFromBridge(ctx, projectId);
        }

        const result = validatePcbConstraints(input);

        return {
          project_id: projectId,
          valid: result.valid,
          errors: result.errors.map(mapPcbIssue),
          warnings: result.warnings.map(mapPcbIssue),
          summary: result.summary,
          unknown_checks: result.unknownChecks,
        };
      } catch (err) {
        return {
          project_id: projectId,
          valid: false,
          errors: [],
          warnings: [],
          summary: { totalChecks: 0, passed: 0, failed: 0, notApplicable: 0, unknown: 0 },
          unknown_checks: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_production_review',
    title: 'Run PCB production review',
    description:
      'Run fabrication, assembly, and testability production review rules for PCB handoff. Reports severity-ranked DFM/DFA/DFT findings with actionable remediation before Gerber export or manufacturing submission.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: false,
    group: 'pcb-constraints',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      boardData: pcbBoardDataSchema.optional(),
      gateMode: z.enum(['warn', 'block', 'off']).default('warn'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      passed: z.boolean(),
      blocked: z.boolean(),
      gate_mode: z.string(),
      severity_counts: z.object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }),
      errors: z.array(pcbIssueSchema),
      warnings: z.array(pcbIssueSchema),
      summary: z.object({
        totalChecks: z.number(),
        passed: z.number(),
        failed: z.number(),
        notApplicable: z.number(),
        unknown: z.number(),
      }),
      unknown_checks: z.array(pcbUnknownSchema),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, boardData, gateMode } = params as {
        projectId: string;
        boardData?: Partial<PcbConstraintInput>;
        gateMode?: 'warn' | 'block' | 'off';
      };

      try {
        const input = boardData
          ? (boardData as PcbConstraintInput)
          : await fetchBoardDataFromBridge(ctx, projectId);
        const result = validatePcbConstraints(input);
        const errors = result.errors.map(mapPcbIssue);
        const warnings = result.warnings.map(mapPcbIssue);
        const mode = gateMode ?? 'warn';

        return {
          project_id: projectId,
          passed: result.valid,
          blocked: mode === 'block' && !result.valid,
          gate_mode: mode,
          severity_counts: {
            errors: errors.length,
            warnings: warnings.length,
            total: errors.length + warnings.length,
          },
          errors,
          warnings,
          summary: result.summary,
          unknown_checks: result.unknownChecks,
        };
      } catch (err) {
        return {
          project_id: projectId,
          passed: false,
          blocked: gateMode === 'block',
          gate_mode: gateMode ?? 'warn',
          severity_counts: { errors: 0, warnings: 0, total: 0 },
          errors: [],
          warnings: [],
          summary: { totalChecks: 0, passed: 0, failed: 0, notApplicable: 0, unknown: 0 },
          unknown_checks: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_constraint_report',
    title: 'PCB constraint report',
    description:
      'Generate a human-readable report explaining which PCB constraints were applied and which require manual review.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'pcb-constraints',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      boardData: pcbBoardDataSchema.optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      verdict: z.string(),
      checked: z.array(
        z.object({
          area: z.string(),
          status: z.string(),
          details: z.string(),
        }),
      ),
      manualReviewRequired: z.array(
        z.object({
          area: z.string(),
          reason: z.string(),
        }),
      ),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, boardData } = params as {
        projectId: string;
        boardData?: Partial<PcbConstraintInput>;
      };

      try {
        let input: PcbConstraintInput;

        if (boardData) {
          input = boardData as PcbConstraintInput;
        } else {
          input = await fetchBoardDataFromBridge(ctx, projectId);
        }

        const validationResult = validatePcbConstraints(input);
        const report = buildConstraintReport(input, validationResult);

        return {
          project_id: projectId,
          verdict: report.verdict,
          checked: report.checked,
          manualReviewRequired: report.manualReviewRequired,
        };
      } catch (err) {
        return {
          project_id: projectId,
          verdict: 'needs-review',
          checked: [],
          manualReviewRequired: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerPcbConstraintTools };

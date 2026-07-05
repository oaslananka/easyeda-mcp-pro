import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { validatePcbConstraints } from '../pcb-constraints/index.js';
import type { PcbConstraintInput } from '../pcb-constraints/types.js';
import { generateProductionQaArtifacts } from '../production-qa/index.js';
import { evaluateQuoteWorkflow } from '../quote-gating/index.js';

interface BinaryBridgeResult {
  base64?: string;
  fileName?: string;
}

interface WriteExportResult {
  ok: boolean;
  filePath?: string;
  byteLength?: number;
  error?: string;
}

/**
 * Write a bridge export result to disk under `ctx.config.artifactDir`.
 *
 * The EasyEDA manufacturing-data APIs (Gerbers/PDF/netlist/pick-place) return
 * in-memory Blob/File objects. The bridge extension converts these to a
 * `{base64, fileName, ...}` JSON payload (see
 * `easyeda-bridge-extension/src/binary-result.ts`) since Blob/File cannot
 * cross the JSON-only WS transport directly. Some paths (e.g. a netlist
 * method that returns plain structured data instead of a file) may return
 * non-binary JSON instead — that is written as formatted JSON so the tool's
 * `exported`/`file_path` contract stays meaningful either way.
 */
function writeExportPayload(
  ctx: ToolContext,
  data: unknown,
  requestedPath: string | undefined,
  defaultFileName: string,
): WriteExportResult {
  if (
    data === undefined ||
    data === null ||
    (typeof data === 'object' && Object.keys(data).length === 0)
  ) {
    // An empty object is what a stale/un-upgraded bridge extension produces when it
    // tries to JSON-serialize a Blob/File directly (JSON.stringify(blob) === '{}'),
    // so treat it the same as "no data" rather than writing a useless `{}` file.
    return { ok: false, error: 'Bridge did not return export data.' };
  }

  const binary = data as BinaryBridgeResult;
  let buffer: Buffer;
  let fileName = defaultFileName;
  if (typeof binary.base64 === 'string') {
    buffer = Buffer.from(binary.base64, 'base64');
    fileName = binary.fileName || defaultFileName;
  } else {
    buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }

  const artifactDir = path.resolve(ctx.config.artifactDir);
  const target = requestedPath ? path.resolve(requestedPath) : path.resolve(artifactDir, fileName);
  const relative = path.relative(artifactDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: 'File path must be inside the artifact directory.' };
  }

  const parentDir = path.dirname(target);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(target, buffer);
  return { ok: true, filePath: target, byteLength: buffer.byteLength };
}

const quoteBoardSchema = z.object({
  boardCount: z.number().int().positive(),
  layers: z.number().int().positive(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  thicknessMm: z.number().positive().optional(),
  surfaceFinish: z.string().optional(),
  solderMask: z.string().optional(),
  copperWeight: z.string().optional(),
  assembly: z.boolean().optional(),
  stencil: z.boolean().optional(),
});

const quoteSnapshotSchema = z.object({
  total: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  breakdown: z.array(z.object({ item: z.string(), cost: z.number().nonnegative() })).optional(),
  estimated: z.boolean().optional(),
  nonBinding: z.boolean().optional(),
  verifiedAt: z.string().optional(),
  source: z.enum(['local-estimate', 'vendor-api', 'user-provided']).optional(),
});

const quoteConfirmationSchema = z.object({
  confirmed: z.boolean().optional(),
  confirmationText: z.string().optional(),
  userId: z.string().optional(),
  reason: z.string().optional(),
});

const quoteGateIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediationHint: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const productionReviewBoardDataSchema = z.object({}).passthrough();

const productionReviewIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.string(),
  remediationHint: z.string(),
});

function runProductionReview(
  boardData: Partial<PcbConstraintInput> | undefined,
  mode: 'off' | 'warn' | 'block' | undefined,
) {
  if (!mode || mode === 'off') return undefined;
  const result = validatePcbConstraints((boardData ?? {}) as PcbConstraintInput);
  const errors = result.errors.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    remediationHint: issue.remediationHint,
  }));
  const warnings = result.warnings.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    remediationHint: issue.remediationHint,
  }));
  return {
    mode,
    passed: result.valid,
    blocked: mode === 'block' && errors.length > 0,
    error_count: errors.length,
    warning_count: warnings.length,
    errors,
    warnings,
  };
}

const qaCriticalNetSchema = z.object({
  name: z.string(),
  category: z
    .enum(['power', 'ground', 'reset', 'programming', 'clock', 'interface', 'analog', 'custom'])
    .optional(),
  required: z.boolean().optional(),
  hasTestPoint: z.boolean().optional(),
  testPointRef: z.string().optional(),
});

const qaComponentSchema = z.object({
  ref: z.string(),
  value: z.string().optional(),
  footprint: z.string().optional(),
  polarized: z.boolean().optional(),
  orientationMark: z.boolean().optional(),
  specialHandling: z.string().optional(),
  doNotPopulate: z.boolean().optional(),
  side: z.enum(['top', 'bottom']).optional(),
});

const qaIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediationHint: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const qaChecklistItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['testpoint', 'assembly', 'bringup', 'qa', 'programming']),
  required: z.boolean(),
  status: z.enum(['pass', 'fail', 'review']),
  details: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

const qaArtifactSchema = z.object({
  filename: z.string(),
  fileType: z.enum(['markdown', 'json']),
  role: z.enum([
    'testpoint-checklist',
    'assembly-notes',
    'bringup-plan',
    'production-qa-checklist',
    'qa-manifest',
  ]),
  content: z.string(),
  required: z.boolean(),
});

function registerExportTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_jlcpcb_quote_workflow',
    title: 'JLCPCB quote workflow gate',
    description:
      'Prepare a non-binding JLCPCB quote workflow snapshot with explicit human-review gates and audit evidence. This tool never places orders or performs paid operations.',
    profile: 'pro',
    evidence: ['official-docs', 'inferred'],
    risk: 'medium',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      provider: z.enum(['jlcpcb', 'custom']).default('jlcpcb'),
      action: z.enum(['estimate', 'verify_quote', 'place_order']).default('estimate'),
      projectId: z.string().optional(),
      board: quoteBoardSchema,
      quote: quoteSnapshotSchema.optional(),
      confirmation: quoteConfirmationSchema.optional(),
      vendorTermsReviewed: z.boolean().optional(),
      productionFilesReady: z.boolean().optional(),
      exportManifestVerified: z.boolean().optional(),
      productionReviewPassed: z.boolean().optional(),
      allowedPaidOperations: z.boolean().optional(),
    }),
    outputSchema: z.object({
      provider: z.string(),
      action: z.string(),
      project_id: z.string(),
      status: z.string(),
      allowed: z.boolean(),
      quote: z.object({
        total: z.number().optional(),
        currency: z.string().optional(),
        breakdown: z.array(z.object({ item: z.string(), cost: z.number() })).optional(),
        estimated: z.boolean(),
        non_binding: z.boolean(),
        verified_at: z.string().optional(),
        source: z.string(),
      }),
      risk: z.object({
        level: z.string(),
        paid_operation: z.boolean(),
        human_confirmation_required: z.boolean(),
        non_binding_estimate: z.boolean(),
        vendor_terms_reviewed: z.boolean(),
      }),
      issues: z.array(quoteGateIssueSchema),
      audit: z.object({
        id: z.string(),
        created_at: z.string(),
        provider: z.string(),
        action: z.string(),
        project_id: z.string().optional(),
        confirmed: z.boolean(),
        user_id: z.string().optional(),
        confirmation_text: z.string().optional(),
        reason: z.string().optional(),
        paid_operation_attempted: z.boolean(),
        paid_operation_allowed: z.boolean(),
      }),
      summary: z.string(),
      unsupported_operations: z.array(z.string()),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const report = evaluateQuoteWorkflow(params as Parameters<typeof evaluateQuoteWorkflow>[0]);
      return {
        provider: report.provider,
        action: report.action,
        project_id: report.projectId,
        status: report.status,
        allowed: report.allowed,
        quote: {
          total: report.quote.total,
          currency: report.quote.currency,
          breakdown: report.quote.breakdown,
          estimated: report.quote.estimated,
          non_binding: report.quote.nonBinding,
          verified_at: report.quote.verifiedAt,
          source: report.quote.source,
        },
        risk: {
          level: report.risk.level,
          paid_operation: report.risk.paidOperation,
          human_confirmation_required: report.risk.humanConfirmationRequired,
          non_binding_estimate: report.risk.nonBindingEstimate,
          vendor_terms_reviewed: report.risk.vendorTermsReviewed,
        },
        issues: report.issues,
        audit: {
          id: report.audit.id,
          created_at: report.audit.createdAt,
          provider: report.audit.provider,
          action: report.audit.action,
          project_id: report.audit.projectId,
          confirmed: report.audit.confirmed,
          user_id: report.audit.userId,
          confirmation_text: report.audit.confirmationText,
          reason: report.audit.reason,
          paid_operation_attempted: report.audit.paidOperationAttempted,
          paid_operation_allowed: report.audit.paidOperationAllowed,
        },
        summary: report.summary,
        unsupported_operations: [
          'place_order',
          'checkout',
          'payment',
          'coupon_apply',
          'shipping_purchase',
        ],
      };
    },
  });

  registry.register({
    name: 'easyeda_production_qa_artifacts',
    title: 'Generate production QA artifacts',
    description:
      'Generate testpoint checklist, assembly notes, bring-up plan, production QA checklist, and machine-readable QA manifest for board handoff.',
    profile: 'pro',
    evidence: ['inferred'],
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
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      revision: z.string().optional(),
      criticalNets: z.array(qaCriticalNetSchema).optional(),
      components: z.array(qaComponentSchema).optional(),
      requiresProgramming: z.boolean().optional(),
      programmingInterfaces: z.array(z.string()).optional(),
      hasProgrammingAccess: z.boolean().optional(),
      hasBattery: z.boolean().optional(),
      requiresFunctionalTest: z.boolean().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      project_name: z.string().optional(),
      revision: z.string().optional(),
      passed: z.boolean(),
      issues: z.array(qaIssueSchema),
      checklist: z.array(qaChecklistItemSchema),
      artifacts: z.array(qaArtifactSchema),
      summary: z.object({
        criticalNetCount: z.number().int().nonnegative(),
        missingTestpointCount: z.number().int().nonnegative(),
        assemblyNoteCount: z.number().int().nonnegative(),
        checklistItemCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
        humanSummary: z.string(),
      }),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const report = generateProductionQaArtifacts(
        params as Parameters<typeof generateProductionQaArtifacts>[0],
      );
      return {
        project_id: report.projectId,
        project_name: report.projectName,
        revision: report.revision,
        passed: report.passed,
        issues: report.issues,
        checklist: report.checklist,
        artifacts: report.artifacts,
        summary: report.summary,
      };
    },
  });

  registry.register({
    name: 'easyeda_export_gerbers',
    title: 'Export Gerber files',
    description: 'Export PCB design to Gerber files for PCB fabrication.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      filePath: z.string().optional(),
      drillFormat: z.enum(['excellon', 'millimeter', 'inch']).optional(),
      excludeLayer: z.array(z.string()).optional(),
      ledPanel: z.boolean().optional(),
      productionReview: z
        .object({
          mode: z.enum(['off', 'warn', 'block']).default('warn'),
          boardData: productionReviewBoardDataSchema.optional(),
        })
        .optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      artifact_path: z.string().optional(),
      byte_length: z.number().int().nonnegative().optional(),
      file_count: z.number().int().nonnegative().optional(),
      exported: z.boolean(),
      blocked_by_production_review: z.boolean().optional(),
      production_review: z
        .object({
          mode: z.string(),
          passed: z.boolean(),
          blocked: z.boolean(),
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
          errors: z.array(productionReviewIssueSchema),
          warnings: z.array(productionReviewIssueSchema),
        })
        .optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, filePath, drillFormat, excludeLayer, ledPanel, productionReview } =
        params as {
          projectId: string;
          filePath?: string;
          drillFormat?: string;
          excludeLayer?: string[];
          ledPanel?: boolean;
          productionReview?: {
            mode?: 'off' | 'warn' | 'block';
            boardData?: Partial<PcbConstraintInput>;
          };
        };
      try {
        const productionReviewResult = runProductionReview(
          productionReview?.boardData,
          productionReview?.mode,
        );

        if (productionReviewResult?.blocked) {
          return {
            project_id: projectId,
            exported: false,
            blocked_by_production_review: true,
            production_review: productionReviewResult,
          };
        }

        const result = await ctx.bridge.call('board.exportGerbers', {
          projectId,
          drillFormat,
          excludeLayer,
          ledPanel,
        });
        const written = writeExportPayload(ctx, result, filePath, `${projectId}-gerbers.zip`);
        if (!written.ok) {
          return {
            project_id: projectId,
            exported: false,
            not_available: true,
            error: written.error,
            production_review: productionReviewResult,
          };
        }
        return {
          project_id: projectId,
          artifact_path: written.filePath,
          byte_length: written.byteLength,
          exported: true,
          production_review: productionReviewResult,
        };
      } catch (err) {
        return {
          project_id: projectId,
          exported: false,
          production_review: runProductionReview(
            productionReview?.boardData,
            productionReview?.mode,
          ),
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_export_pick_place',
    title: 'Export pick-and-place file',
    description:
      'Export pick-and-place (centroid) file for PCB assembly. Contains component reference, position, rotation, and layer.',
    profile: 'pro',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      format: z.enum(['csv', 'txt']).default('csv'),
      filePath: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      format: z.string(),
      file_path: z.string().optional(),
      byte_length: z.number().int().nonnegative().optional(),
      component_count: z.number().int().nonnegative().optional(),
      exported: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, format, filePath } = params as {
        projectId: string;
        format: string;
        filePath?: string;
      };
      try {
        const result = await ctx.bridge.call('export.pickPlace', {
          projectId,
          format,
        });
        const written = writeExportPayload(
          ctx,
          result,
          filePath,
          `${projectId}-pick-place.${format}`,
        );
        if (!written.ok) {
          return {
            project_id: projectId,
            format,
            exported: false,
            not_available: true,
            error: written.error,
          };
        }
        return {
          project_id: projectId,
          format,
          file_path: written.filePath,
          byte_length: written.byteLength,
          exported: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          format,
          exported: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_export_pdf',
    title: 'Export to PDF',
    description: 'Export the schematic and/or board layout to PDF.',
    profile: 'pro',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      scope: z.enum(['schematic', 'board', 'both']).default('both'),
      orientation: z.enum(['portrait', 'landscape']).default('landscape'),
      filePath: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      scope: z.string(),
      orientation: z.string(),
      file_path: z.string().optional(),
      byte_length: z.number().int().nonnegative().optional(),
      pages: z.number().int().nonnegative().optional(),
      exported: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, scope, orientation, filePath } = params as {
        projectId: string;
        scope: string;
        orientation: string;
        filePath?: string;
      };
      try {
        const result = await ctx.bridge.call('export.pdf', {
          projectId,
          scope,
          orientation,
          what: scope,
        });
        const written = writeExportPayload(ctx, result, filePath, `${projectId}-${scope}.pdf`);
        if (!written.ok) {
          return {
            project_id: projectId,
            scope,
            orientation,
            exported: false,
            not_available: true,
            error: written.error,
          };
        }
        return {
          project_id: projectId,
          scope,
          orientation,
          file_path: written.filePath,
          byte_length: written.byteLength,
          exported: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          scope,
          orientation,
          exported: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_export_netlist',
    title: 'Export netlist',
    description:
      'Export the schematic netlist in a specified EDA tool format (PADS, Allegro, or Altium).',
    profile: 'pro',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'export',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      format: z.enum(['pads', 'allegro', 'altium']).default('pads'),
      filePath: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      format: z.string(),
      file_path: z.string().optional(),
      byte_length: z.number().int().nonnegative().optional(),
      net_count: z.number().int().nonnegative().optional(),
      exported: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, format, filePath } = params as {
        projectId: string;
        format: string;
        filePath?: string;
      };
      try {
        const result = await ctx.bridge.call('export.netlist', {
          projectId,
          format,
        });
        const written = writeExportPayload(ctx, result, filePath, `${projectId}-netlist.${format}`);
        if (!written.ok) {
          return {
            project_id: projectId,
            format,
            exported: false,
            not_available: true,
            error: written.error,
          };
        }
        const netCount =
          result &&
          typeof result === 'object' &&
          typeof (result as { netCount?: unknown }).netCount === 'number'
            ? (result as { netCount: number }).netCount
            : undefined;
        return {
          project_id: projectId,
          format,
          file_path: written.filePath,
          byte_length: written.byteLength,
          net_count: netCount,
          exported: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          format,
          exported: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerExportTools };

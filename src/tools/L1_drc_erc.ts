import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { validateNets } from '../net-validation/validation.js';
import { type NetValidationIssue } from '../net-validation/errors.js';
import {
  type DeviceValidationEntry,
  type NetValidationEntry,
  type PinValidationMetadata,
} from '../net-validation/schema.js';
import { classifyNetType, classifyPinElectricalType } from '../net-validation/pin-classifier.js';
import { analyzePowerTree } from '../power-tree/index.js';
import {
  classifyPostWriteQa,
  collectNativeRuleRunsForPostWriteQa,
} from '../workflows/schematic-post-write-qa.js';
import { fetchComponentPins } from './schematic-helpers.js';
import { normalizeSchematicNets } from '../schematic-model/index.js';

/** Shared error/warning mapper for both the hand-authored and auto-extracted
 *  semantic ERC tools — same NetValidationIssue shape, same response fields. */
function mapSemanticIssue(issue: NetValidationIssue) {
  return {
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    path: issue.path,
    net_name: issue.netName,
    component_ref: issue.componentRef,
    pin: issue.pin,
    remediation_hint: issue.remediationHint,
    details: issue.details,
  };
}

/**
 * Extract nets + devices from the live schematic (schematic.listNets +
 * schematic.listComponents + per-component pin fetch) and classify net/pin
 * electrical types from naming conventions — see pin-classifier.ts for why
 * EasyEDA's own pinType metadata isn't trusted as the primary source.
 * Unclassified pins default to 'passive' so they never trigger a false
 * floating-input/output-contention/missing-power finding.
 */
async function extractLiveSemanticNetlist(
  ctx: ToolContext,
  projectId: string,
): Promise<{ nets: NetValidationEntry[]; devices: DeviceValidationEntry[] }> {
  const netsResult = (await ctx.bridge.call('schematic.listNets', { projectId })) as Array<{
    netName?: string;
    nodes?: Array<{ component?: string; pin?: string }>;
  }>;
  const compsResult = (await ctx.bridge.call('schematic.listComponents', {
    projectId,
    limit: 500,
    offset: 0,
  })) as { items?: Array<{ primitiveId?: string; reference?: string }> };
  const components = compsResult?.items ?? [];

  const devices: DeviceValidationEntry[] = [];
  for (const c of components) {
    if (!c.primitiveId || !c.reference) continue;
    let pins;
    try {
      pins = await fetchComponentPins(ctx, c.primitiveId);
    } catch {
      continue; // best-effort; skip components whose pins can't be read live
    }
    const devicePins: PinValidationMetadata[] = pins.map((p) => ({
      pin: p.pinNumber,
      name: p.pinName,
      electricalType: classifyPinElectricalType(p.pinName, p.pinType) ?? 'passive',
    }));
    devices.push({ id: c.reference, ref: c.reference, pins: devicePins });
  }

  const nets: NetValidationEntry[] = normalizeSchematicNets(netsResult ?? []).map((net) => ({
    id: net.id,
    name: net.canonicalNetName,
    type: classifyNetType(net.canonicalNetName),
    nodes: net.nodes.map((node) => ({
      deviceRef: node.componentRef,
      pin: node.pin,
    })),
  }));

  return { nets, devices };
}

function registerDrcErcTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_drc_run',
    title: 'Run design rule check',
    description:
      'Run the native design rule check (DRC): same as clicking "Check DRC" in EasyEDA Pro, so ' +
      "the bottom DRC panel opens/refreshes in the user's window as a visible side effect. " +
      'Returns coarse per-severity counts only — which specific wire/net/component is affected ' +
      "is shown only in EasyEDA Pro's own DRC panel.",
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      rules: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      violations: z.array(
        z.object({
          rule: z.string(),
          description: z.string(),
          location: z
            .object({
              x: z.number(),
              y: z.number(),
              layer: z.string().optional(),
            })
            .optional(),
          severity: z.enum(['error', 'warning', 'info']),
          net: z.string().optional(),
          component: z.string().optional(),
        }),
      ),
      total_violations: z.number().int().nonnegative(),
      error_count: z.number().int().nonnegative(),
      warning_count: z.number().int().nonnegative(),
      passed: z.boolean(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, rules } = params as { projectId: string; rules?: string[] };
      try {
        const result = await ctx.bridge.call('design.drc', { projectId, rules });
        const data = result as {
          violations?: Array<{
            rule?: string;
            description?: string;
            location?: { x?: number; y?: number; layer?: string };
            severity?: string;
            net?: string;
            component?: string;
          }>;
          totalViolations?: number;
          errorCount?: number;
          warningCount?: number;
        };
        const violations = (data.violations ?? []).map((v) => ({
          rule: v.rule ?? '',
          description: v.description ?? '',
          location: v.location
            ? {
                x: v.location.x ?? 0,
                y: v.location.y ?? 0,
                layer: v.location.layer,
              }
            : undefined,
          severity: (v.severity === 'error' || v.severity === 'warning' || v.severity === 'info'
            ? v.severity
            : 'info') as 'error' | 'warning' | 'info',
          net: v.net,
          component: v.component,
        }));
        return {
          project_id: projectId,
          violations,
          total_violations: data.totalViolations ?? violations.length,
          error_count: data.errorCount ?? violations.filter((v) => v.severity === 'error').length,
          warning_count:
            data.warningCount ?? violations.filter((v) => v.severity === 'warning').length,
          passed: (data.errorCount ?? 0) === 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          violations: [],
          total_violations: 0,
          error_count: 0,
          warning_count: 0,
          passed: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_erc_run',
    title: 'Run electrical rule check',
    description:
      'Run the native electrical rule check (ERC). Native counts are coarse; ' +
      'inferred_floating_pins supplements them with located, unconnected pins from this ' +
      "bridge's own inference (best-effort — other categories still need the DRC panel).",
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'medium',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      checks: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      violations: z.array(
        z.object({
          net: z.string().optional(),
          component: z.string().optional(),
          description: z.string(),
          severity: z.enum(['error', 'warning', 'info']),
          location: z
            .object({
              x: z.number(),
              y: z.number(),
            })
            .optional(),
        }),
      ),
      total_violations: z.number().int().nonnegative(),
      error_count: z.number().int().nonnegative(),
      warning_count: z.number().int().nonnegative(),
      passed: z.boolean(),
      inferred_floating_pins: z
        .array(
          z.object({
            primitiveId: z.string(),
            designator: z.string(),
            pinNumber: z.string(),
          }),
        )
        .optional(),
      detail_source: z.enum(['inferred_partial', 'native_aggregate_only']).optional(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, checks } = params as { projectId: string; checks?: string[] };
      try {
        const result = await ctx.bridge.call('design.erc', { projectId, checks });
        const data = result as {
          violations?: Array<{
            net?: string;
            component?: string;
            description?: string;
            severity?: string;
            location?: { x?: number; y?: number };
          }>;
          totalViolations?: number;
          errorCount?: number;
          warningCount?: number;
          inferredFloatingPins?: Array<{
            primitiveId: string;
            designator: string;
            pinNumber: string;
          }>;
          detailSource?: 'inferred_partial' | 'native_aggregate_only';
        };
        const violations = (data.violations ?? []).map((v) => ({
          net: v.net,
          component: v.component,
          description: v.description ?? '',
          severity: (v.severity === 'error' || v.severity === 'warning' || v.severity === 'info'
            ? v.severity
            : 'info') as 'error' | 'warning' | 'info',
          location: v.location
            ? {
                x: v.location.x ?? 0,
                y: v.location.y ?? 0,
              }
            : undefined,
        }));
        return {
          project_id: projectId,
          violations,
          total_violations: data.totalViolations ?? violations.length,
          error_count: data.errorCount ?? violations.filter((v) => v.severity === 'error').length,
          warning_count:
            data.warningCount ?? violations.filter((v) => v.severity === 'warning').length,
          passed: (data.errorCount ?? 0) === 0,
          inferred_floating_pins: data.inferredFloatingPins,
          detail_source: data.detailSource,
        };
      } catch (err) {
        return {
          project_id: projectId,
          violations: [],
          total_violations: 0,
          error_count: 0,
          warning_count: 0,
          passed: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const semanticPinSchema = z.object({
    pin: z.string(),
    name: z.string().optional(),
    electricalType: z.enum([
      'input',
      'output',
      'bidirectional',
      'passive',
      'power_input',
      'power_output',
      'power_source',
      'open_drain',
      'tri_state',
      'no_connect',
    ]),
    required: z.boolean().optional(),
    expectedNetType: z.enum(['power', 'signal', 'ground']).optional(),
    expectedVoltage: z.number().optional(),
    noConnectAllowed: z.boolean().optional(),
  });

  const semanticNodeSchema = z.object({
    deviceRef: z.string(),
    pin: z.string(),
    electricalType: semanticPinSchema.shape.electricalType.optional(),
    pinName: z.string().optional(),
    expectedVoltage: z.number().optional(),
  });

  const semanticNetSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['power', 'signal', 'ground']),
    voltage: z.number().optional(),
    nodes: z.array(semanticNodeSchema),
  });

  const semanticDeviceSchema = z.object({
    id: z.string(),
    ref: z.string(),
    category: z.string().optional(),
    pins: z.array(semanticPinSchema).optional(),
    requiresDecoupling: z.boolean().optional(),
  });

  const semanticInterfaceSchema = z.object({
    id: z.string(),
    name: z.string(),
    pinout: z.array(
      z.object({
        pin: z.string(),
        signal: z.string(),
        type: z.string().optional(),
      }),
    ),
  });

  const semanticIssueSchema = z.object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(['error', 'warning']),
    path: z.string().optional(),
    net_name: z.string().optional(),
    component_ref: z.string().optional(),
    pin: z.string().optional(),
    remediation_hint: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  });

  registry.register({
    name: 'easyeda_semantic_erc_validate',
    title: 'Run semantic ERC validation',
    description:
      'Run semantic electrical-rule validation over a netlist with pin electrical types to detect output contention, floating inputs, power conflicts, missing power pins, missing decoupling, and voltage-domain mismatches.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      nets: z.array(semanticNetSchema),
      devices: z.array(semanticDeviceSchema).optional(),
      interfaces: z.array(semanticInterfaceSchema).optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      passed: z.boolean(),
      error_count: z.number().int().nonnegative(),
      warning_count: z.number().int().nonnegative(),
      total_issues: z.number().int().nonnegative(),
      errors: z.array(semanticIssueSchema),
      warnings: z.array(semanticIssueSchema),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const parsed = params as {
        projectId?: string;
        nets: Array<{
          id: string;
          name: string;
          type: 'power' | 'signal' | 'ground';
          voltage?: number;
          nodes: Array<{
            deviceRef: string;
            pin: string;
            electricalType?:
              | 'input'
              | 'output'
              | 'bidirectional'
              | 'passive'
              | 'power_input'
              | 'power_output'
              | 'power_source'
              | 'open_drain'
              | 'tri_state'
              | 'no_connect';
            pinName?: string;
            expectedVoltage?: number;
          }>;
        }>;
        devices?: Array<{
          id: string;
          ref: string;
          category?: string;
          pins?: Array<{
            pin: string;
            name?: string;
            electricalType:
              | 'input'
              | 'output'
              | 'bidirectional'
              | 'passive'
              | 'power_input'
              | 'power_output'
              | 'power_source'
              | 'open_drain'
              | 'tri_state'
              | 'no_connect';
            required?: boolean;
            expectedNetType?: 'power' | 'signal' | 'ground';
            expectedVoltage?: number;
            noConnectAllowed?: boolean;
          }>;
          requiresDecoupling?: boolean;
        }>;
        interfaces?: Array<{
          id: string;
          name: string;
          pinout: Array<{ pin: string; signal: string; type?: string }>;
        }>;
      };

      const result = validateNets({
        nets: parsed.nets,
        devices: parsed.devices,
        interfaces: parsed.interfaces,
      });

      const errors = result.errors.map(mapSemanticIssue);
      const warnings = result.warnings.map(mapSemanticIssue);

      return {
        project_id: parsed.projectId ?? '',
        passed: result.valid,
        error_count: errors.length,
        warning_count: warnings.length,
        total_issues: errors.length + warnings.length,
        errors,
        warnings,
      };
    },
  });

  registry.register({
    name: 'easyeda_semantic_erc_auto',
    title: 'Auto-extract netlist and run semantic ERC',
    description:
      'Extract nets/devices/pins from the LIVE schematic and run semantic ERC — no hand-authored ' +
      'netlist needed. Net/pin electrical types are INFERRED from naming conventions, not ' +
      'verified — treat findings as a first-pass signal, not a substitute for semantic_erc_validate.',
    profile: 'core',
    evidence: ['inferred', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      passed: z.boolean(),
      error_count: z.number().int().nonnegative(),
      warning_count: z.number().int().nonnegative(),
      total_issues: z.number().int().nonnegative(),
      errors: z.array(semanticIssueSchema),
      warnings: z.array(semanticIssueSchema),
      inferred_net_count: z.number().int().nonnegative(),
      inferred_device_count: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const { nets, devices } = await extractLiveSemanticNetlist(ctx, projectId);
        const result = validateNets({ nets, devices });
        const errors = result.errors.map(mapSemanticIssue);
        const warnings = result.warnings.map(mapSemanticIssue);
        return {
          project_id: projectId,
          passed: result.valid,
          error_count: errors.length,
          warning_count: warnings.length,
          total_issues: errors.length + warnings.length,
          errors,
          warnings,
          inferred_net_count: nets.length,
          inferred_device_count: devices.length,
        };
      } catch (err) {
        return {
          project_id: projectId,
          passed: false,
          error_count: 0,
          warning_count: 0,
          total_issues: 0,
          errors: [],
          warnings: [],
          inferred_net_count: 0,
          inferred_device_count: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const powerRailSchema = z.object({
    id: z.string(),
    name: z.string(),
    voltage: z.number(),
    maxCurrentA: z.number().nonnegative().optional(),
    sourceRefs: z.array(z.string()).optional(),
    regulatorRefs: z.array(z.string()).optional(),
    external: z.boolean().optional(),
    requiresProtection: z.boolean().optional(),
    requiresBulkCapacitance: z.boolean().optional(),
    sequenceAfterRailRefs: z.array(z.string()).optional(),
  });

  const powerSourceSchema = z.object({
    id: z.string(),
    name: z.string().optional(),
    kind: z.enum(['usb', 'battery', 'barrel-jack', 'bench', 'ac-dc', 'external', 'custom']),
    railId: z.string(),
    voltage: z.number(),
    maxCurrentA: z.number().nonnegative().optional(),
    currentLimitA: z.number().nonnegative().optional(),
    requiresProtection: z.boolean().optional(),
  });

  const powerRegulatorSchema = z.object({
    id: z.string(),
    ref: z.string().optional(),
    kind: z.enum(['ldo', 'linear', 'buck', 'boost', 'buck-boost', 'load-switch', 'custom']),
    inputRailId: z.string(),
    outputRailId: z.string(),
    inputVoltage: z.number().optional(),
    outputVoltage: z.number().optional(),
    maxOutputCurrentA: z.number().nonnegative().optional(),
    currentLimitA: z.number().nonnegative().optional(),
    dropoutVoltage: z.number().nonnegative().optional(),
    efficiency: z.number().positive().max(1).optional(),
    quiescentCurrentA: z.number().nonnegative().optional(),
    thermalResistanceCPerW: z.number().positive().optional(),
    maxJunctionTempC: z.number().optional(),
    package: z.string().optional(),
  });

  const powerLoadSchema = z.object({
    id: z.string(),
    ref: z.string().optional(),
    railId: z.string(),
    currentA: z.number().nonnegative(),
    peakCurrentA: z.number().nonnegative().optional(),
    category: z.string().optional(),
    required: z.boolean().optional(),
  });

  const powerProtectionSchema = z.object({
    id: z.string(),
    railId: z.string(),
    kind: z.enum([
      'fuse',
      'polyfuse',
      'tvs',
      'reverse-polarity',
      'ideal-diode',
      'current-limit',
      'esd',
      'custom',
    ]),
    ref: z.string().optional(),
    currentRatingA: z.number().nonnegative().optional(),
    location: z.enum(['input', 'output', 'rail', 'connector']).optional(),
  });

  const powerCapacitorSchema = z.object({
    id: z.string(),
    railId: z.string(),
    ref: z.string().optional(),
    capacitanceUf: z.number().nonnegative(),
    role: z.enum(['bulk', 'input', 'output', 'decoupling', 'hold-up', 'custom']),
    voltageRating: z.number().positive().optional(),
  });

  const powerIssueSchema = z.object({
    code: z.string(),
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    railId: z.string().optional(),
    railName: z.string().optional(),
    componentRef: z.string().optional(),
    remediationHint: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  });

  registry.register({
    name: 'easyeda_power_tree_analyze',
    title: 'Analyze power-tree current and thermal budget',
    description:
      'Analyze supply sources, regulators, loads, protection, bulk capacitance, current budget, dropout, and regulator thermal risk. Returns machine-readable issues and a human-readable summary.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      rails: z.array(powerRailSchema),
      sources: z.array(powerSourceSchema).optional(),
      regulators: z.array(powerRegulatorSchema).optional(),
      loads: z.array(powerLoadSchema).optional(),
      protections: z.array(powerProtectionSchema).optional(),
      capacitors: z.array(powerCapacitorSchema).optional(),
      limits: z
        .object({
          minCurrentMarginPercent: z.number().nonnegative().optional(),
          minThermalMarginC: z.number().nonnegative().optional(),
          ambientTempC: z.number().optional(),
          minBulkCapacitanceUfPerA: z.number().nonnegative().optional(),
          minBulkCapacitanceUf: z.number().nonnegative().optional(),
        })
        .optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      passed: z.boolean(),
      rails: z.array(
        z.object({
          railId: z.string(),
          railName: z.string(),
          voltage: z.number(),
          loadCurrentA: z.number(),
          peakCurrentA: z.number(),
          availableCurrentA: z.number().optional(),
          marginA: z.number().optional(),
          marginPercent: z.number().optional(),
          loadCount: z.number().int().nonnegative(),
          sourceRefs: z.array(z.string()),
          regulatorRefs: z.array(z.string()),
          protectionRefs: z.array(z.string()),
          bulkCapacitanceUf: z.number(),
          requiredBulkCapacitanceUf: z.number().optional(),
          passed: z.boolean(),
        }),
      ),
      regulators: z.array(
        z.object({
          regulatorId: z.string(),
          ref: z.string().optional(),
          kind: z.string(),
          inputRailId: z.string(),
          outputRailId: z.string(),
          inputVoltage: z.number(),
          outputVoltage: z.number(),
          outputCurrentA: z.number(),
          maxOutputCurrentA: z.number().optional(),
          currentMarginA: z.number().optional(),
          currentMarginPercent: z.number().optional(),
          dropoutMarginV: z.number().optional(),
          estimatedDissipationW: z.number().optional(),
          estimatedJunctionTempC: z.number().optional(),
          thermalMarginC: z.number().optional(),
          passed: z.boolean(),
        }),
      ),
      issues: z.array(powerIssueSchema),
      summary: z.object({
        railCount: z.number().int().nonnegative(),
        sourceCount: z.number().int().nonnegative(),
        regulatorCount: z.number().int().nonnegative(),
        loadCount: z.number().int().nonnegative(),
        totalLoadCurrentA: z.number(),
        totalPeakCurrentA: z.number(),
        errorCount: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
        passed: z.boolean(),
        humanSummary: z.string(),
      }),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const report = analyzePowerTree(params as Parameters<typeof analyzePowerTree>[0]);
      return {
        project_id: report.projectId,
        passed: report.passed,
        rails: report.rails,
        regulators: report.regulators,
        issues: report.issues,
        summary: report.summary,
      };
    },
  });

  const qaViolationSchema = z.object({
    rule: z.string().optional(),
    description: z.string().optional(),
    message: z.string().optional(),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    net: z.string().optional(),
    component: z.string().optional(),
  });

  const qaRunOverrideSchema = z.object({
    not_available: z.boolean().optional(),
    error: z.string().optional(),
    violations: z.array(qaViolationSchema).optional(),
    total_violations: z.number().int().nonnegative().optional(),
    error_count: z.number().int().nonnegative().optional(),
    warning_count: z.number().int().nonnegative().optional(),
    passed: z.boolean().optional(),
    inferred_floating_pins: z
      .array(
        z.object({
          primitiveId: z.string().optional(),
          designator: z.string().optional(),
          pinNumber: z.string().optional(),
        }),
      )
      .optional(),
  });

  registry.register({
    name: 'easyeda_post_write_qa',
    title: 'Classify post-write schematic QA results',
    description:
      'Run and classify post-write schematic QA after generated edits. Combines native DRC/ERC results ' +
      'with policy-aware classification so duplicate net names, free networks, and unconnected pins are ' +
      'reported as pass/fail/inconclusive instead of raw warning counts.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'medium',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      policy: z.enum(['circuit', 'diagnostic-fixture']).default('circuit'),
      useNativeChecks: z.boolean().default(true),
      manualDrcMessages: z
        .array(z.string())
        .optional()
        .describe(
          'Optional user-copied EasyEDA DRC log lines for classification when native details are unavailable',
        ),
      manualErcMessages: z
        .array(z.string())
        .optional()
        .describe(
          'Optional user-copied EasyEDA ERC log lines for classification when native details are unavailable',
        ),
      drc: qaRunOverrideSchema
        .optional()
        .describe('Optional explicit DRC result override for tests or log ingestion'),
      erc: qaRunOverrideSchema
        .optional()
        .describe('Optional explicit ERC result override for tests or log ingestion'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      status: z.enum(['pass', 'fail', 'inconclusive']),
      passed: z.boolean(),
      policy: z.enum(['circuit', 'diagnostic-fixture']),
      issue_count: z.number().int().nonnegative(),
      fatal_count: z.number().int().nonnegative(),
      warning_count: z.number().int().nonnegative(),
      inconclusive_count: z.number().int().nonnegative(),
      categories: z.record(z.string(), z.number().int().nonnegative()),
      issues: z.array(
        z.object({
          source: z.enum(['drc', 'erc', 'layout', 'manual-log']),
          category: z.string(),
          severity: z.enum(['error', 'warning', 'info']),
          fatal: z.boolean(),
          message: z.string(),
          rule: z.string().optional(),
          net: z.string().optional(),
          component: z.string().optional(),
          remediation_hint: z.string(),
        }),
      ),
      summary: z.string(),
      detail_source: z.enum(['native', 'manual', 'override', 'mixed']).optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = z
        .object({
          projectId: z.string(),
          policy: z.enum(['circuit', 'diagnostic-fixture']).default('circuit'),
          useNativeChecks: z.boolean().default(true),
          manualDrcMessages: z.array(z.string()).optional(),
          manualErcMessages: z.array(z.string()).optional(),
          drc: qaRunOverrideSchema.optional(),
          erc: qaRunOverrideSchema.optional(),
        })
        .parse(params ?? {});

      const manualDrc = p.manualDrcMessages?.map((description) => ({
        description,
        severity: 'warning' as const,
      }));
      const manualErc = p.manualErcMessages?.map((description) => ({
        description,
        severity: 'warning' as const,
      }));
      let drc =
        p.drc ??
        (manualDrc ? { violations: manualDrc, total_violations: manualDrc.length } : undefined);
      let erc =
        p.erc ??
        (manualErc ? { violations: manualErc, total_violations: manualErc.length } : undefined);
      let nativeUsed = false;

      if (p.useNativeChecks) {
        const native = await collectNativeRuleRunsForPostWriteQa(ctx.bridge, p.projectId, {
          drc: !drc,
          erc: !erc,
        });
        if (!drc) drc = native.drc;
        if (!erc) erc = native.erc;
        nativeUsed = Boolean(native.drc || native.erc);
      }

      const summary = classifyPostWriteQa({ projectId: p.projectId, policy: p.policy, drc, erc });
      const hasManual = Boolean(p.manualDrcMessages?.length || p.manualErcMessages?.length);
      const hasOverride = Boolean(p.drc || p.erc);
      return {
        ...summary,
        detail_source:
          [nativeUsed, hasManual, hasOverride].filter(Boolean).length > 1
            ? 'mixed'
            : nativeUsed
              ? 'native'
              : hasManual
                ? 'manual'
                : hasOverride
                  ? 'override'
                  : undefined,
      };
    },
  });

  registry.register({
    name: 'easyeda_rule_check_summary',
    title: 'Get rule check summary',
    description: 'Get a summary of all design and electrical rule check results for the project.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'drc-erc',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      drc: z.object({
        total: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        passed: z.boolean(),
      }),
      erc: z.object({
        total: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        passed: z.boolean(),
      }),
      overall_passed: z.boolean(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const [drcResult, ercResult] = await Promise.all([
          ctx.bridge.call('design.drc', { projectId }),
          ctx.bridge.call('design.erc', { projectId }),
        ]);
        const drc = drcResult as {
          totalViolations?: number;
          errorCount?: number;
          warningCount?: number;
        };
        const erc = ercResult as {
          totalViolations?: number;
          errorCount?: number;
          warningCount?: number;
        };
        const drcErrors = drc.errorCount ?? 0;
        const drcWarnings = drc.warningCount ?? 0;
        const ercErrors = erc.errorCount ?? 0;
        const ercWarnings = erc.warningCount ?? 0;
        return {
          project_id: projectId,
          drc: {
            total: drc.totalViolations ?? drcErrors + drcWarnings,
            errors: drcErrors,
            warnings: drcWarnings,
            passed: drcErrors === 0,
          },
          erc: {
            total: erc.totalViolations ?? ercErrors + ercWarnings,
            errors: ercErrors,
            warnings: ercWarnings,
            passed: ercErrors === 0,
          },
          overall_passed: drcErrors === 0 && ercErrors === 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          drc: { total: 0, errors: 0, warnings: 0, passed: false },
          erc: { total: 0, errors: 0, warnings: 0, passed: false },
          overall_passed: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerDrcErcTools };

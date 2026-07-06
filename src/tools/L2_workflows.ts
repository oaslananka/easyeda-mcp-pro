import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { planWorkflowBlock } from '../workflows/planner.js';
import type {
  WorkflowBlockInput,
  WorkflowIssue,
  WorkflowOperation,
  WorkflowPlan,
} from '../workflows/types.js';
import { lookupDecouplingGuidance, type DecouplingCategory } from '../design-rules/decoupling.js';
import { buildSpiceDeck } from '../simulation/netlist.js';
import { detectNgspice, runNgspiceDeck } from '../simulation/runner.js';
import { parseOperatingPointOutput } from '../simulation/parser.js';
import { verifyRailAgainstSpec } from '../simulation/verify.js';
import type { SimCircuit } from '../simulation/types.js';

const deviceItemSchema = z.object({
  libraryUuid: z.string().min(1),
  uuid: z.string().min(1),
});

const pinConnectionSchema = z.object({
  pin: z.string().min(1),
  netName: z.string().min(1),
});

const componentInputSchema = z.object({
  ref: z.string().min(1),
  role: z.string().min(1),
  deviceItem: deviceItemSchema,
  rotation: z.number().optional(),
  mirror: z.boolean().optional(),
  subPartName: z.string().optional(),
  pinConnections: z.array(pinConnectionSchema).default([]),
});

const existingComponentInputSchema = z.object({
  ref: z.string().min(1),
  role: z.string().min(1),
  primitiveId: z.string().min(1),
  pinConnections: z.array(pinConnectionSchema).default([]),
});

const netPortInputSchema = z.object({
  netName: z.string().min(1),
  portType: z.enum(['input', 'output', 'bidirectional', 'triState', 'passive']).optional(),
  rotation: z.number().optional(),
});

const pointSchema = z.object({ x: z.number(), y: z.number() });

const workflowIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediationHint: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const workflowOperationSchema = z.object({
  kind: z.string(),
  ref: z.string().optional(),
  role: z.string().optional(),
  netName: z.string().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});

const workflowPlacementSchema = z.object({
  ref: z.string(),
  role: z.string(),
  x: z.number(),
  y: z.number(),
});

const applyResultEntrySchema = z.object({
  method: z.string(),
  ref: z.string().optional(),
  success: z.boolean(),
  primitiveId: z.string().optional(),
  error: z.string().optional(),
});

const workflowOutputSchema = z.object({
  success: z.boolean(),
  project_id: z.string(),
  transaction_id: z.string(),
  mode: z.string(),
  applied: z.boolean(),
  blocked: z.boolean(),
  rolled_back: z.boolean(),
  placements: z.array(workflowPlacementSchema),
  operations: z.array(workflowOperationSchema),
  apply_results: z.array(applyResultEntrySchema).optional(),
  issues: z.array(workflowIssueSchema),
  summary: z.string(),
  rollback_notes: z.array(z.string()),
  error: z.string().optional(),
});

function mapIssues(issues: WorkflowIssue[]) {
  return issues.map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    message: entry.message,
    remediationHint: entry.remediationHint,
    details: entry.details,
  }));
}

function operationRef(op: WorkflowOperation): string | undefined {
  return 'ref' in op ? op.ref : undefined;
}

function resolveOperationParams(
  params: Record<string, unknown>,
  refToPrimitiveId: Map<string, string>,
): Record<string, unknown> {
  const resolved = { ...params };
  const primitiveId = resolved.primitiveId;
  if (typeof primitiveId === 'string' && primitiveId.startsWith('$ref:')) {
    const ref = primitiveId.slice('$ref:'.length);
    const real = refToPrimitiveId.get(ref);
    if (!real) {
      throw new Error(
        `Cannot resolve primitiveId for ref "${ref}" — its placement did not complete successfully.`,
      );
    }
    resolved.primitiveId = real;
  }
  return resolved;
}

interface ApplyOutcome {
  applyResults: Array<{
    method: string;
    ref?: string;
    success: boolean;
    primitiveId?: string;
    error?: string;
  }>;
  failed: boolean;
  rolledBack: boolean;
}

/**
 * Execute a workflow plan's operations in order against the bridge. Stops at the first
 * failure and best-effort rolls back every newly-created primitive (placed components and
 * net ports) from this same transaction — see `WorkflowPlan.rollbackNotes` for what cannot
 * be rolled back (pin connections applied to pre-existing components).
 */
async function applyWorkflowPlan(ctx: ToolContext, plan: WorkflowPlan): Promise<ApplyOutcome> {
  const refToPrimitiveId = new Map<string, string>();
  const appliedNewPrimitiveIds: string[] = [];
  const applyResults: ApplyOutcome['applyResults'] = [];
  let failed = false;

  for (const op of plan.operations) {
    if (failed) break;
    try {
      const params = resolveOperationParams(op.params, refToPrimitiveId);
      const result = await ctx.bridge.call<Record<string, unknown>, unknown>(op.method, params);
      const data = result as { primitiveId?: string; result?: string } | string | undefined;
      const primitiveId =
        typeof data === 'string' ? data : (data?.primitiveId ?? data?.result ?? undefined);

      if (op.kind === 'placeComponent' && primitiveId) {
        refToPrimitiveId.set(op.ref, primitiveId);
        appliedNewPrimitiveIds.push(primitiveId);
      }
      if (op.kind === 'createNetPort' && primitiveId) {
        appliedNewPrimitiveIds.push(primitiveId);
      }

      applyResults.push({
        method: op.method,
        ref: operationRef(op),
        success: true,
        primitiveId,
      });
    } catch (err) {
      failed = true;
      applyResults.push({
        method: op.method,
        ref: operationRef(op),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let rolledBack = false;
  if (failed && appliedNewPrimitiveIds.length > 0) {
    try {
      await ctx.bridge.call('schematic.deletePrimitive', { primitiveIds: appliedNewPrimitiveIds });
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
  }

  return { applyResults, failed, rolledBack };
}

function pushIssue(plan: WorkflowPlan, issue: WorkflowIssue): void {
  plan.issues.push(issue);
}

const verifyRailInputSchema = z.object({
  inputVoltage: z.number(),
  outputVoltage: z.number().positive(),
  dropoutVoltage: z.number().nonnegative().default(0.3),
  outputResistanceOhms: z.number().nonnegative().default(0.1),
  loadCurrentA: z.number().positive(),
  tolerancePercent: z.number().positive().default(5),
});

type VerifyRailInput = z.infer<typeof verifyRailInputSchema>;

const railVerificationOutputSchema = z.object({
  available: z.boolean(),
  ngspice_version: z.string().optional(),
  observed_voltage: z.number().optional(),
  within_tolerance: z.boolean().optional(),
  caveat: z.string(),
  error: z.string().optional(),
});

/**
 * Attach an optional electrical verification verdict to a power-rail workflow's result.
 * This is a deliberately standalone, simplified model of the rail — not a simulation of
 * the literal placed components/pins — see `src/simulation/types.ts`'s `LdoBehavioralComponent`
 * doc for exactly what the model does and does not capture.
 */
async function verifyPowerRail(spec: VerifyRailInput) {
  const caveat =
    'Simplified linear regulator model (ideal source + dropout clamp + output resistance), ' +
    'not a simulation of the literal placed components — see docs/simulation.md.';
  const availability = await detectNgspice();
  if (!availability.available) {
    return {
      available: false,
      caveat,
      error: `ngspice is not installed or not on PATH: ${availability.error ?? 'unknown reason'}`,
    };
  }

  const circuit: SimCircuit = {
    title: 'power rail verification',
    groundNode: '0',
    components: [
      { ref: '1', kind: 'dc-voltage-source', nodes: ['vin', '0'], voltage: spec.inputVoltage },
      {
        ref: '1',
        kind: 'ldo-behavioral',
        nodes: ['vin', 'vout', '0'],
        targetVoltage: spec.outputVoltage,
        dropoutVoltage: spec.dropoutVoltage,
        outputResistanceOhms: spec.outputResistanceOhms,
      },
      { ref: '1', kind: 'dc-current-source', nodes: ['vout', '0'], current: spec.loadCurrentA },
    ],
  };

  try {
    const deck = buildSpiceDeck(circuit, { kind: 'operating-point' });
    const { stdout } = await runNgspiceDeck(deck);
    const result = parseOperatingPointOutput(stdout);
    const verdict = verifyRailAgainstSpec(result.nodeVoltages, {
      nodeName: 'vout',
      nominalVoltage: spec.outputVoltage,
      tolerancePercent: spec.tolerancePercent,
    });
    return {
      available: true,
      ngspice_version: availability.version,
      observed_voltage: verdict.observedVoltage,
      within_tolerance: verdict.withinTolerance,
      caveat,
    };
  } catch (err) {
    return {
      available: true,
      ngspice_version: availability.version,
      caveat,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runWorkflow(
  ctx: ToolContext,
  input: WorkflowBlockInput,
  transactionPrefix: string,
  confirmWrite: boolean | undefined,
  extraIssues: (plan: WorkflowPlan) => void = () => {},
) {
  const plan = planWorkflowBlock(input, transactionPrefix);
  extraIssues(plan);
  const blocked = plan.issues.some((entry) => entry.severity === 'error');

  if (input.mode !== 'apply') {
    return {
      success: !blocked,
      project_id: plan.projectId,
      transaction_id: plan.transactionId,
      mode: plan.mode,
      applied: false,
      blocked,
      rolled_back: false,
      placements: plan.placements,
      operations: plan.operations,
      issues: mapIssues(plan.issues),
      summary: plan.summary,
      rollback_notes: plan.rollbackNotes,
    };
  }

  if (blocked) {
    return {
      success: false,
      project_id: plan.projectId,
      transaction_id: plan.transactionId,
      mode: plan.mode,
      applied: false,
      blocked: true,
      rolled_back: false,
      placements: plan.placements,
      operations: plan.operations,
      issues: mapIssues(plan.issues),
      summary: plan.summary,
      rollback_notes: plan.rollbackNotes,
      error: 'Workflow plan contains blocking errors.',
    };
  }

  if (confirmWrite !== true) {
    return {
      success: false,
      project_id: plan.projectId,
      transaction_id: plan.transactionId,
      mode: plan.mode,
      applied: false,
      blocked: true,
      rolled_back: false,
      placements: plan.placements,
      operations: plan.operations,
      issues: mapIssues(plan.issues),
      summary: 'Apply blocked because confirmWrite=true was not provided.',
      rollback_notes: plan.rollbackNotes,
      error: 'confirmWrite=true is required to apply this workflow.',
    };
  }

  const outcome = await applyWorkflowPlan(ctx, plan);
  return {
    success: !outcome.failed,
    project_id: plan.projectId,
    transaction_id: plan.transactionId,
    mode: plan.mode,
    applied: !outcome.failed,
    blocked: false,
    rolled_back: outcome.rolledBack,
    placements: plan.placements,
    operations: plan.operations,
    apply_results: outcome.applyResults,
    issues: mapIssues(plan.issues),
    summary: outcome.failed
      ? outcome.rolledBack
        ? 'Apply failed part-way through; newly-created primitives from this transaction were rolled back.'
        : 'Apply failed part-way through and automatic rollback also failed — review the project manually.'
      : `Applied ${outcome.applyResults.length} operation(s).`,
    rollback_notes: plan.rollbackNotes,
    error: outcome.applyResults.find((entry) => !entry.success)?.error,
  };
}

function registerWorkflowTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_workflow_power_rail',
    title: 'Plan or apply a power rail (regulator + passives) as one transaction',
    description:
      'Place a regulator and its supporting passives and wire them to input/output/ground nets ' +
      'in a single atomic transaction, instead of one primitive call per component. Caller supplies ' +
      'already-resolved device items and pin connections; this tool does not select parts (confirmWrite required).',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      mode: z.enum(['preview', 'apply']).default('preview'),
      anchor: pointSchema,
      spacing: z.number().positive().optional(),
      groundNetName: z.string().min(1).default('GND'),
      inputNetName: z.string().min(1),
      outputNetName: z.string().min(1),
      components: z.array(componentInputSchema).min(1),
      verifyRail: verifyRailInputSchema.optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: workflowOutputSchema.extend({
      verification: railVerificationOutputSchema.optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        mode?: 'preview' | 'apply';
        anchor: { x: number; y: number };
        spacing?: number;
        groundNetName: string;
        inputNetName: string;
        outputNetName: string;
        components: WorkflowBlockInput['components'];
        verifyRail?: VerifyRailInput;
        confirmWrite?: boolean;
      };
      const input: WorkflowBlockInput = {
        projectId: p.projectId,
        mode: p.mode,
        anchor: p.anchor,
        spacing: p.spacing,
        components: p.components,
      };
      const result = await runWorkflow(ctx, input, 'wf_power_rail', p.confirmWrite, (plan) => {
        const allConnections = (p.components ?? []).flatMap((c) => c.pinConnections);
        const hasRegulator = (p.components ?? []).some((c) =>
          c.role.toLowerCase().includes('regulator'),
        );
        if (!hasRegulator) {
          pushIssue(plan, {
            code: 'WORKFLOW_MISSING_ROLE',
            severity: 'warning',
            message: 'No component role contains "regulator".',
            remediationHint:
              'Tag the regulator component\'s role (e.g. "power-regulator") so downstream tooling can identify it.',
          });
        }
        for (const [label, netName] of [
          ['ground', p.groundNetName],
          ['input', p.inputNetName],
          ['output', p.outputNetName],
        ] as const) {
          if (!allConnections.some((connection) => connection.netName === netName)) {
            pushIssue(plan, {
              code: 'WORKFLOW_MISSING_ROLE',
              severity: 'warning',
              message: `No pin connection references the ${label} net "${netName}".`,
              remediationHint: `Connect at least one pin to "${netName}", or confirm this rail intentionally omits it.`,
            });
          }
        }
      });

      if (!p.verifyRail) return result;
      return { ...result, verification: await verifyPowerRail(p.verifyRail) };
    },
  });

  registry.register({
    name: 'easyeda_workflow_decouple_ic',
    title: 'Plan or apply per-pin decoupling capacitors for an existing IC',
    description:
      "Place one decoupling capacitor per declared IC power pin and wire each to the pin's net " +
      'and ground, in a single atomic transaction. Cites design-rules decoupling guidance ' +
      '(rule-of-thumb, not datasheet-specific) alongside the plan (confirmWrite required).',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      mode: z.enum(['preview', 'apply']).default('preview'),
      anchor: pointSchema,
      spacing: z.number().positive().optional(),
      groundNetName: z.string().min(1).default('GND'),
      icPowerPins: z.array(pinConnectionSchema).min(1),
      capacitor: deviceItemSchema,
      capacitorPins: z
        .object({ p1: z.string().min(1).default('1'), p2: z.string().min(1).default('2') })
        .default({ p1: '1', p2: '2' }),
      decouplingCategory: z
        .enum(['digital-logic', 'mcu', 'analog', 'rf', 'crystal-oscillator', 'power-regulator'])
        .default('mcu'),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: workflowOutputSchema.extend({
      decoupling_guidance: z
        .object({
          category: z.string(),
          displayName: z.string(),
          perPinCapacitorsNf: z.array(z.number()),
          placement: z.string(),
          source: z.string(),
          caveat: z.string(),
        })
        .optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        mode?: 'preview' | 'apply';
        anchor: { x: number; y: number };
        spacing?: number;
        groundNetName: string;
        icPowerPins: Array<{ pin: string; netName: string }>;
        capacitor: { libraryUuid: string; uuid: string };
        capacitorPins?: { p1: string; p2: string };
        decouplingCategory: DecouplingCategory;
        confirmWrite?: boolean;
      };
      const capacitorPins = p.capacitorPins ?? { p1: '1', p2: '2' };

      const components: WorkflowBlockInput['components'] = p.icPowerPins.map((pin, index) => ({
        ref: `C_DECOUPLE_${index + 1}_${pin.pin}`,
        role: 'decoupling-capacitor',
        deviceItem: p.capacitor,
        pinConnections: [
          { pin: capacitorPins.p1, netName: pin.netName },
          { pin: capacitorPins.p2, netName: p.groundNetName },
        ],
      }));

      const input: WorkflowBlockInput = {
        projectId: p.projectId,
        mode: p.mode,
        anchor: p.anchor,
        spacing: p.spacing,
        components,
      };

      const result = await runWorkflow(ctx, input, 'wf_decouple_ic', p.confirmWrite);
      const guidance = lookupDecouplingGuidance(p.decouplingCategory);
      return {
        ...result,
        decoupling_guidance: {
          category: guidance.category,
          displayName: guidance.displayName,
          perPinCapacitorsNf: guidance.perPinCapacitorsNf,
          placement: guidance.placement,
          source: guidance.source,
          caveat: guidance.caveat,
        },
      };
    },
  });

  registry.register({
    name: 'easyeda_workflow_place_block',
    title: 'Plan or apply a CircuitIR-style block (devices, nets, ports) as one transaction',
    description:
      'Place a group of components, wire their pin-to-net connections (new and/or pre-existing ' +
      'components), and create net ports for block-external nets — all as a single atomic ' +
      'transaction with rollback on partial failure (confirmWrite required).',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      mode: z.enum(['preview', 'apply']).default('preview'),
      anchor: pointSchema,
      spacing: z.number().positive().optional(),
      blockName: z.string().optional(),
      components: z.array(componentInputSchema).default([]),
      existingComponents: z.array(existingComponentInputSchema).default([]),
      netPorts: z.array(netPortInputSchema).default([]),
      netPortAnchor: pointSchema.optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: workflowOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as WorkflowBlockInput & { blockName?: string; confirmWrite?: boolean };
      const input: WorkflowBlockInput = {
        projectId: p.projectId,
        mode: p.mode,
        anchor: p.anchor,
        spacing: p.spacing,
        components: p.components,
        existingComponents: p.existingComponents,
        netPorts: p.netPorts,
        netPortAnchor: p.netPortAnchor,
      };
      return runWorkflow(ctx, input, 'wf_place_block', p.confirmWrite);
    },
  });

  registry.register({
    name: 'easyeda_workflow_connector_breakout',
    title: 'Plan or apply a connector placement with per-pin net ports as one transaction',
    description:
      'Place a connector, wire each declared pin to its net, and create a net port for each net ' +
      'so the breakout is accessible off-sheet — all as a single atomic transaction (confirmWrite required).',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      mode: z.enum(['preview', 'apply']).default('preview'),
      anchor: pointSchema,
      netPortAnchor: pointSchema.optional(),
      connectorRef: z.string().min(1).default('J1'),
      connector: deviceItemSchema,
      rotation: z.number().optional(),
      mirror: z.boolean().optional(),
      subPartName: z.string().optional(),
      pins: z
        .array(
          z.object({
            pin: z.string().min(1),
            netName: z.string().min(1),
            portType: z
              .enum(['input', 'output', 'bidirectional', 'triState', 'passive'])
              .optional(),
          }),
        )
        .min(1),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: workflowOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        mode?: 'preview' | 'apply';
        anchor: { x: number; y: number };
        netPortAnchor?: { x: number; y: number };
        connectorRef: string;
        connector: { libraryUuid: string; uuid: string };
        rotation?: number;
        mirror?: boolean;
        subPartName?: string;
        pins: Array<{ pin: string; netName: string; portType?: string }>;
        confirmWrite?: boolean;
      };

      const input: WorkflowBlockInput = {
        projectId: p.projectId,
        mode: p.mode,
        anchor: p.anchor,
        netPortAnchor: p.netPortAnchor,
        components: [
          {
            ref: p.connectorRef,
            role: 'connector',
            deviceItem: p.connector,
            rotation: p.rotation,
            mirror: p.mirror,
            subPartName: p.subPartName,
            pinConnections: p.pins.map((pin) => ({ pin: pin.pin, netName: pin.netName })),
          },
        ],
        netPorts: p.pins.map((pin) => ({
          netName: pin.netName,
          portType: pin.portType as
            'input' | 'output' | 'bidirectional' | 'triState' | 'passive' | undefined,
        })),
      };
      return runWorkflow(ctx, input, 'wf_connector_breakout', p.confirmWrite);
    },
  });
}

export { registerWorkflowTools };

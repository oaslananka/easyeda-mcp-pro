import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { buildSpiceDeck } from '../simulation/netlist.js';
import { detectNgspice, runNgspiceDeck } from '../simulation/runner.js';
import { parseOperatingPointOutput, parseTransientOutput } from '../simulation/parser.js';
import { verifyRailAgainstSpec } from '../simulation/verify.js';
import type { SimCircuit } from '../simulation/types.js';
export type { SimComponent } from '../simulation/types.js';

const nodesSchema = z.array(z.string().min(1)).min(2).max(3);

function passiveComponentSchema(kind: 'resistor' | 'capacitor' | 'inductor') {
  return z.object({
    ref: z.string().min(1),
    kind: z.literal(kind),
    nodes: nodesSchema,
    value: z.number(),
    initialCondition: z.number().optional(),
  });
}

function diodeComponentSchema(kind: 'diode' | 'led') {
  return z.object({
    ref: z.string().min(1),
    kind: z.literal(kind),
    nodes: nodesSchema,
    modelName: z.string().min(1),
  });
}

const dcVoltageSourceSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('dc-voltage-source'),
  nodes: nodesSchema,
  voltage: z.number(),
});

const pulseVoltageSourceSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('pulse-voltage-source'),
  nodes: nodesSchema,
  initialVoltage: z.number(),
  pulsedVoltage: z.number(),
  delaySeconds: z.number().nonnegative(),
  riseSeconds: z.number().positive(),
  fallSeconds: z.number().positive(),
  pulseWidthSeconds: z.number().positive(),
  periodSeconds: z.number().positive(),
});

const dcCurrentSourceSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('dc-current-source'),
  nodes: nodesSchema,
  current: z.number(),
});

const pulseCurrentSourceSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('pulse-current-source'),
  nodes: nodesSchema,
  initialCurrent: z.number(),
  pulsedCurrent: z.number(),
  delaySeconds: z.number().nonnegative(),
  riseSeconds: z.number().positive(),
  fallSeconds: z.number().positive(),
  pulseWidthSeconds: z.number().positive(),
  periodSeconds: z.number().positive(),
});

const ldoBehavioralSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('ldo-behavioral'),
  nodes: z.array(z.string().min(1)).length(3),
  targetVoltage: z.number().positive(),
  dropoutVoltage: z.number().nonnegative(),
  outputResistanceOhms: z.number().nonnegative(),
});

const simComponentSchema = z.discriminatedUnion('kind', [
  passiveComponentSchema('resistor'),
  passiveComponentSchema('capacitor'),
  passiveComponentSchema('inductor'),
  diodeComponentSchema('diode'),
  diodeComponentSchema('led'),
  dcVoltageSourceSchema,
  pulseVoltageSourceSchema,
  dcCurrentSourceSchema,
  pulseCurrentSourceSchema,
  ldoBehavioralSchema,
]);

const simCircuitSchema = z.object({
  title: z.string().min(1),
  groundNode: z.literal('0'),
  components: z.array(simComponentSchema).min(1),
});

const railSpecSchema = z.object({
  nodeName: z.string().min(1),
  nominalVoltage: z.number(),
  tolerancePercent: z.number().positive(),
});

const railVerdictSchema = z.object({
  nodeName: z.string(),
  nominalVoltage: z.number(),
  tolerancePercent: z.number(),
  minAllowedVoltage: z.number(),
  maxAllowedVoltage: z.number(),
  observedVoltage: z.number(),
  withinTolerance: z.boolean(),
});

function registerOperatingPointTool(registry: { register: (def: ToolDefinition) => void }) {
  registry.register({
    name: 'easyeda_simulate_operating_point',
    title: 'Run an offline SPICE operating-point simulation',
    description:
      'Translate a typed circuit description into a SPICE deck and run an offline ngspice ' +
      'operating-point (.op) simulation, optionally checking rail node voltages against a spec. ' +
      'Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'simulation',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      circuit: simCircuitSchema,
      railSpecs: z.array(railSpecSchema).optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
    }),
    outputSchema: z.object({
      available: z.boolean(),
      ngspice_version: z.string().optional(),
      node_voltages: z.record(z.string(), z.number()).optional(),
      rail_verdicts: z.array(railVerdictSchema).optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const p = params as {
        circuit: SimCircuit;
        railSpecs?: Array<{ nodeName: string; nominalVoltage: number; tolerancePercent: number }>;
        timeoutMs?: number;
      };

      const availability = await detectNgspice();
      if (!availability.available) {
        return {
          available: false,
          not_available: true,
          error: `ngspice is not installed or not on PATH: ${availability.error ?? 'unknown reason'}`,
        };
      }

      try {
        const deck = buildSpiceDeck(p.circuit, { kind: 'operating-point' });
        const { stdout } = await runNgspiceDeck(deck, { timeoutMs: p.timeoutMs });
        const result = parseOperatingPointOutput(stdout);
        const railVerdicts = p.railSpecs?.map((spec) =>
          verifyRailAgainstSpec(result.nodeVoltages, spec),
        );
        return {
          available: true,
          ngspice_version: availability.version,
          node_voltages: result.nodeVoltages,
          rail_verdicts: railVerdicts,
        };
      } catch (err) {
        return {
          available: true,
          ngspice_version: availability.version,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

const MAX_TRANSIENT_SAMPLES = 200;

function registerTransientTool(registry: { register: (def: ToolDefinition) => void }) {
  registry.register({
    name: 'easyeda_simulate_transient',
    title: 'Run an offline SPICE transient simulation',
    description:
      'Translate a typed circuit description into a SPICE deck and run an offline ngspice ' +
      'transient (.tran) simulation, optionally checking the final rail voltage against a spec. ' +
      'Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'simulation',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      circuit: simCircuitSchema,
      stepSeconds: z.number().positive(),
      stopTimeSeconds: z.number().positive(),
      railSpecs: z.array(railSpecSchema).optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
    }),
    outputSchema: z.object({
      available: z.boolean(),
      ngspice_version: z.string().optional(),
      samples: z
        .array(
          z.object({ time_seconds: z.number(), node_voltages: z.record(z.string(), z.number()) }),
        )
        .optional(),
      truncated: z.boolean().optional(),
      rail_verdicts: z.array(railVerdictSchema).optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const p = params as {
        circuit: SimCircuit;
        stepSeconds: number;
        stopTimeSeconds: number;
        railSpecs?: Array<{ nodeName: string; nominalVoltage: number; tolerancePercent: number }>;
        timeoutMs?: number;
      };

      const availability = await detectNgspice();
      if (!availability.available) {
        return {
          available: false,
          not_available: true,
          error: `ngspice is not installed or not on PATH: ${availability.error ?? 'unknown reason'}`,
        };
      }

      try {
        const deck = buildSpiceDeck(p.circuit, {
          kind: 'transient',
          stepSeconds: p.stepSeconds,
          stopTimeSeconds: p.stopTimeSeconds,
        });
        const { stdout } = await runNgspiceDeck(deck, { timeoutMs: p.timeoutMs });
        const result = parseTransientOutput(stdout);
        const truncated = result.samples.length > MAX_TRANSIENT_SAMPLES;
        const samples = (
          truncated ? result.samples.slice(0, MAX_TRANSIENT_SAMPLES) : result.samples
        ).map((sample) => ({
          time_seconds: sample.timeSeconds,
          node_voltages: sample.nodeVoltages,
        }));
        const lastSample = result.samples.at(-1);
        const railVerdicts = lastSample
          ? p.railSpecs?.map((spec) => verifyRailAgainstSpec(lastSample.nodeVoltages, spec))
          : undefined;
        return {
          available: true,
          ngspice_version: availability.version,
          samples,
          truncated,
          rail_verdicts: railVerdicts,
        };
      } catch (err) {
        return {
          available: true,
          ngspice_version: availability.version,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

function registerSimulationTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registerOperatingPointTool(registry);
  registerTransientTool(registry);
}

export { registerSimulationTools };

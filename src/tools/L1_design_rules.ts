import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { calculateTraceWidth, calculateMaxCurrent } from '../design-rules/trace-width.js';
import { lookupClearance } from '../design-rules/clearance.js';
import {
  lookupProtocolRouting,
  listProtocolRoutingKeys,
  type ProtocolKey,
} from '../design-rules/protocol-routing.js';
import {
  lookupDecouplingGuidance,
  listDecouplingCategories,
  recommendBulkCapacitance,
  type DecouplingCategory,
} from '../design-rules/decoupling.js';
import {
  listDfmChecklist,
  getDfmChecklistItem,
  type DfmCategory,
} from '../design-rules/dfm-checklist.js';

const conductorLayerSchema = z.enum(['external', 'internal']);
const protocolKeySchema = z.enum([
  'usb2',
  'usb3',
  'rs485',
  'i2c',
  'spi',
  'uart',
  'ethernet-10-100',
  'ethernet-1000',
]);
const decouplingCategorySchema = z.enum([
  'digital-logic',
  'mcu',
  'analog',
  'rf',
  'crystal-oscillator',
  'power-regulator',
]);
const dfmCategorySchema = z.enum([
  'clearance',
  'drilling',
  'copper',
  'solder-mask',
  'silkscreen',
  'panelization',
  'assembly',
]);

const inputSchema = z.discriminatedUnion('topic', [
  z.object({
    topic: z.literal('trace-width'),
    currentA: z.number().positive(),
    temperatureRiseC: z.number().positive(),
    layer: conductorLayerSchema,
    copperWeightOz: z.number().positive(),
  }),
  z.object({
    topic: z.literal('max-current'),
    traceWidthMils: z.number().positive(),
    temperatureRiseC: z.number().positive(),
    layer: conductorLayerSchema,
    copperWeightOz: z.number().positive(),
  }),
  z.object({
    topic: z.literal('clearance'),
    voltageV: z.number().nonnegative(),
    location: conductorLayerSchema,
  }),
  z.object({
    topic: z.literal('protocol-routing'),
    protocol: protocolKeySchema.optional(),
  }),
  z.object({
    topic: z.literal('decoupling'),
    category: decouplingCategorySchema.optional(),
  }),
  z.object({
    topic: z.literal('bulk-capacitance'),
    loadA: z.number().positive(),
    minBulkCapacitanceUfPerA: z.number().positive().optional(),
    minBulkCapacitanceUf: z.number().positive().optional(),
  }),
  z.object({
    topic: z.literal('dfm-checklist'),
    category: dfmCategorySchema.optional(),
    id: z.string().optional(),
  }),
]);

const traceWidthResultSchema = z.object({
  requiredAreaMils2: z.number(),
  copperThicknessMils: z.number(),
  traceWidthMils: z.number(),
  traceWidthMm: z.number(),
  k: z.number(),
  source: z.string(),
  caveat: z.string(),
});

const maxCurrentResultSchema = z.object({
  maxCurrentA: z.number(),
  source: z.string(),
  caveat: z.string(),
});

const clearanceResultSchema = z.object({
  minClearanceMm: z.number(),
  minClearanceMils: z.number(),
  bandMaxVoltageV: z.number(),
  source: z.string(),
  caveat: z.string(),
  outOfRange: z.boolean().optional(),
});

const protocolRoutingResultSchema = z.object({
  protocol: z.string(),
  displayName: z.string(),
  topology: z.string(),
  differentialImpedanceOhms: z.number().optional(),
  singleEndedImpedanceOhms: z.number().optional(),
  terminationOhms: z.number().optional(),
  terminationNotes: z.string().optional(),
  pullUpResistanceOhms: z.object({ min: z.number(), max: z.number() }).optional(),
  lengthMatchingGuidance: z.string(),
  maxRecommendedLengthNotes: z.string().optional(),
  notes: z.array(z.string()),
  source: z.string(),
  caveat: z.string(),
});

const decouplingResultSchema = z.object({
  category: z.string(),
  displayName: z.string(),
  perPinCapacitorsNf: z.array(z.number()),
  placement: z.string(),
  notes: z.array(z.string()),
  source: z.string(),
  caveat: z.string(),
});

const bulkCapacitanceResultSchema = z.object({
  requiredBulkCapacitanceUf: z.number(),
  loadA: z.number(),
  source: z.string(),
  caveat: z.string(),
});

const dfmChecklistItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  guidance: z.string(),
  rationale: z.string(),
  source: z.string(),
  caveat: z.string(),
});

const outputSchema = z.object({
  topic: z.string(),
  traceWidth: traceWidthResultSchema.optional(),
  maxCurrent: maxCurrentResultSchema.optional(),
  clearance: clearanceResultSchema.optional(),
  protocolRouting: protocolRoutingResultSchema.optional(),
  protocolRoutingList: z.array(protocolRoutingResultSchema).optional(),
  decoupling: decouplingResultSchema.optional(),
  decouplingList: z.array(decouplingResultSchema).optional(),
  bulkCapacitance: bulkCapacitanceResultSchema.optional(),
  dfmChecklist: z.array(dfmChecklistItemSchema).optional(),
  dfmChecklistItem: dfmChecklistItemSchema.optional(),
  error: z.string().optional(),
});

type LookupInput = z.infer<typeof inputSchema>;
type LookupOutput = z.infer<typeof outputSchema>;

function handleLookup(input: LookupInput): LookupOutput {
  switch (input.topic) {
    case 'trace-width':
      return {
        topic: input.topic,
        traceWidth: calculateTraceWidth({
          currentA: input.currentA,
          temperatureRiseC: input.temperatureRiseC,
          layer: input.layer,
          copperWeightOz: input.copperWeightOz,
        }),
      };
    case 'max-current':
      return {
        topic: input.topic,
        maxCurrent: calculateMaxCurrent({
          traceWidthMils: input.traceWidthMils,
          temperatureRiseC: input.temperatureRiseC,
          layer: input.layer,
          copperWeightOz: input.copperWeightOz,
        }),
      };
    case 'clearance':
      return {
        topic: input.topic,
        clearance: lookupClearance({ voltageV: input.voltageV, location: input.location }),
      };
    case 'protocol-routing':
      if (input.protocol) {
        return {
          topic: input.topic,
          protocolRouting: lookupProtocolRouting(input.protocol as ProtocolKey),
        };
      }
      return {
        topic: input.topic,
        protocolRoutingList: listProtocolRoutingKeys().map((key) => lookupProtocolRouting(key)),
      };
    case 'decoupling':
      if (input.category) {
        return {
          topic: input.topic,
          decoupling: lookupDecouplingGuidance(input.category as DecouplingCategory),
        };
      }
      return {
        topic: input.topic,
        decouplingList: listDecouplingCategories().map((category) =>
          lookupDecouplingGuidance(category),
        ),
      };
    case 'bulk-capacitance':
      return {
        topic: input.topic,
        bulkCapacitance: recommendBulkCapacitance(input.loadA, {
          minBulkCapacitanceUfPerA: input.minBulkCapacitanceUfPerA,
          minBulkCapacitanceUf: input.minBulkCapacitanceUf,
        }),
      };
    case 'dfm-checklist':
      if (input.id) {
        const item = getDfmChecklistItem(input.id);
        return { topic: input.topic, dfmChecklistItem: item };
      }
      return {
        topic: input.topic,
        dfmChecklist: listDfmChecklist(input.category as DfmCategory | undefined),
      };
  }
}

function registerDesignRulesTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_design_rules_lookup',
    title: 'Look up engineering design-rule reference guidance',
    description:
      'Look up generic engineering reference guidance: IPC-2221 trace-width/current-capacity, ' +
      'clearance bands, protocol routing data (USB/RS-485/I2C/SPI/UART/Ethernet), decoupling ' +
      'recipes and bulk capacitance sizing, and a static DFM checklist. Every result cites a ' +
      'source and caveat: these are estimates, not certified values.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'design-rules',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema,
    outputSchema,
    handler: async (_ctx: ToolContext, params: unknown) => {
      const input = params as LookupInput;
      try {
        return handleLookup(input);
      } catch (err) {
        return {
          topic: input.topic,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerDesignRulesTools };

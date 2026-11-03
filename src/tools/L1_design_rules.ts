import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { calculateTraceWidth, calculateMaxCurrent } from '../design-rules/trace-width.js';
import { reviewTraceCurrent } from '../design-rules/trace-current-review.js';
import { lookupClearance } from '../design-rules/clearance.js';
import { reviewIsolationEmc } from '../design-rules/isolation-emc-review.js';
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

const currentASchema = z.number().finite().positive();
const temperatureRiseCSchema = z.number().finite().positive();
const copperWeightOzSchema = z.number().finite().positive();
const traceWidthMilsSchema = z.number().finite().positive();
const traceWidthMmSchema = z.number().finite().positive();
const environmentSchema = z.enum(['still-air', 'forced-air', 'vacuum', 'unspecified']);

const voltageVSchema = z.number().nonnegative();
const loadASchema = z.number().positive();
const minBulkCapacitanceUfPerASchema = z.number().positive();
const minBulkCapacitanceUfSchema = z.number().positive();

const standardEvidenceSchema = z.object({
  identifier: z.string().trim().min(3).max(150),
  edition: z.string().trim().min(4).max(120),
  clause: z.string().trim().min(1).max(120),
  source: z.string().trim().min(3).max(500),
});
const spacingRequirementSchema = z.object({
  minimumMm: z.number().finite().positive(),
  reference: standardEvidenceSchema,
});
const geometryObservationSchema = z.object({
  distanceMm: z.number().finite().nonnegative(),
  evidenceRef: z.string().trim().min(3).max(400),
  evidenceKind: z.enum(['measured_air_gap', 'measured_surface_path', 'estimated']),
});
const isolationEmcInputSchema = z.object({
  purpose: z.enum(['functional', 'basic', 'supplementary', 'reinforced', 'unspecified']).optional(),
  workingVoltageV: z.number().finite().nonnegative().optional(),
  transientVoltageV: z.number().finite().nonnegative().optional(),
  environment: z
    .enum(['controlled-indoor', 'industrial', 'outdoor', 'condensing', 'unspecified'])
    .optional(),
  pollutionDegree: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  overvoltageCategory: z.enum(['I', 'II', 'III', 'IV']).optional(),
  materialGroup: z.enum(['I', 'II', 'IIIa', 'IIIb']).optional(),
  altitudeM: z.number().finite().nonnegative().max(20000).optional(),
  safetyStandard: standardEvidenceSchema.optional(),
  clearanceRequirement: spacingRequirementSchema.optional(),
  creepageRequirement: spacingRequirementSchema.optional(),
  airClearance: geometryObservationSchema.optional(),
  surfaceCreepage: geometryObservationSchema.optional(),
  boardSlotEvidence: z.string().trim().min(3).max(400).optional(),
  coatingEvidence: z.string().trim().min(3).max(400).optional(),
  esdEntry: z
    .object({
      connectorRef: z.string().trim().min(1).max(100),
      protectorRef: z.string().trim().min(1).max(100).optional(),
      entryNet: z.string().trim().min(1).max(100).optional(),
      returnPathEvidence: z.string().trim().min(3).max(400).optional(),
      testStandard: standardEvidenceSchema.optional(),
    })
    .optional(),
  emcReturn: z
    .object({
      fastLoopRef: z.string().trim().min(1).max(100).optional(),
      returnPlaneEvidence: z.string().trim().min(3).max(400).optional(),
      sensitiveCircuitRef: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
});

const lookupInputSchema = z.discriminatedUnion('topic', [
  z.object({
    topic: z.literal('trace-width'),
    currentA: currentASchema,
    temperatureRiseC: temperatureRiseCSchema,
    layer: conductorLayerSchema,
    copperWeightOz: copperWeightOzSchema,
  }),
  z.object({
    topic: z.literal('trace-current-review'),
    currentA: currentASchema.optional(),
    temperatureRiseC: temperatureRiseCSchema.optional(),
    layer: conductorLayerSchema.optional(),
    copperWeightOz: copperWeightOzSchema.optional(),
    traceWidthMm: traceWidthMmSchema.optional(),
    neckDownWidthMm: traceWidthMmSchema.optional(),
    manufacturerMinWidthMm: traceWidthMmSchema.optional(),
    environment: environmentSchema.optional(),
  }),
  z.object({
    topic: z.literal('max-current'),
    traceWidthMils: traceWidthMilsSchema,
    temperatureRiseC: temperatureRiseCSchema,
    layer: conductorLayerSchema,
    copperWeightOz: copperWeightOzSchema,
  }),
  z.object({
    topic: z.literal('clearance'),
    voltageV: voltageVSchema,
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
    loadA: loadASchema,
    minBulkCapacitanceUfPerA: minBulkCapacitanceUfPerASchema.optional(),
    minBulkCapacitanceUf: minBulkCapacitanceUfSchema.optional(),
  }),
  z.object({
    topic: z.literal('isolation-emc-review'),
    review: isolationEmcInputSchema,
  }),
  z.object({
    topic: z.literal('dfm-checklist'),
    category: dfmCategorySchema.optional(),
    id: z.string().optional(),
  }),
]);

const inputSchema = z
  .object({
    topic: z
      .enum([
        'trace-width',
        'trace-current-review',
        'max-current',
        'clearance',
        'protocol-routing',
        'decoupling',
        'bulk-capacitance',
        'dfm-checklist',
        'isolation-emc-review',
      ])
      .describe('Reference topic to look up.'),
    currentA: currentASchema
      .optional()
      .describe('Required when topic is trace-width. Load current in amperes.'),
    traceWidthMils: traceWidthMilsSchema
      .optional()
      .describe('Required when topic is max-current. Trace width in mils.'),
    traceWidthMm: traceWidthMmSchema
      .optional()
      .describe(
        'Optional caller-supplied routed trace width (mm); not a verified EasyEDA measurement.',
      ),
    neckDownWidthMm: traceWidthMmSchema
      .optional()
      .describe(
        'Optional caller-supplied narrowest route segment (mm); not a verified whole-route measurement.',
      ),
    manufacturerMinWidthMm: traceWidthMmSchema
      .optional()
      .describe('Optional manufacturer trace minimum (mm); not a verified fabrication capability.'),
    environment: environmentSchema
      .optional()
      .describe('Qualitative thermal environment context; no thermal correction is assumed.'),
    temperatureRiseC: temperatureRiseCSchema
      .optional()
      .describe('Required for trace-width and max-current. Allowed temperature rise in °C.'),
    layer: conductorLayerSchema
      .optional()
      .describe('Required for trace-width and max-current. Conductor layer location.'),
    copperWeightOz: copperWeightOzSchema
      .optional()
      .describe('Required for trace-width and max-current. Copper weight in oz/ft².'),
    voltageV: voltageVSchema
      .optional()
      .describe('Required when topic is clearance. Working voltage in volts.'),
    location: conductorLayerSchema
      .optional()
      .describe('Required when topic is clearance. Clearance location.'),
    protocol: protocolKeySchema
      .optional()
      .describe('Optional protocol filter when topic is protocol-routing.'),
    category: z
      .union([decouplingCategorySchema, dfmCategorySchema])
      .optional()
      .describe('Optional category filter for decoupling or dfm-checklist.'),
    loadA: loadASchema
      .optional()
      .describe('Required when topic is bulk-capacitance. Load current in amperes.'),
    minBulkCapacitanceUfPerA: minBulkCapacitanceUfPerASchema
      .optional()
      .describe('Optional minimum bulk capacitance per ampere in µF/A.'),
    minBulkCapacitanceUf: minBulkCapacitanceUfSchema
      .optional()
      .describe('Optional absolute minimum bulk capacitance in µF.'),
    id: z.string().optional().describe('Optional DFM checklist item id.'),
    review: isolationEmcInputSchema
      .optional()
      .describe(
        'Optional source-declared insulation/EMC observations. Required for isolation-emc-review.',
      ),
  })
  .superRefine((value, ctx) => {
    const parsed = lookupInputSchema.safeParse(value);
    if (parsed.success) return;

    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  });

const traceReferenceUnitsSchema = z.object({
  currentA: z.literal('A'),
  temperatureRiseC: z.literal('°C'),
  copperWeightOz: z.literal('oz/ft²'),
});

const traceReferenceInputSchema = z.object({
  currentA: currentASchema,
  temperatureRiseC: temperatureRiseCSchema,
  layer: conductorLayerSchema,
  copperWeightOz: copperWeightOzSchema,
});

const maxCurrentReferenceInputSchema = z.object({
  traceWidthMils: traceWidthMilsSchema,
  temperatureRiseC: temperatureRiseCSchema,
  layer: conductorLayerSchema,
  copperWeightOz: copperWeightOzSchema,
});

const referenceMethodSchema = z.literal('IPC2221_EMPIRICAL_REFERENCE');

const traceWidthResultSchema = z.object({
  requiredAreaMils2: z.number(),
  copperThicknessMils: z.number(),
  traceWidthMils: z.number(),
  traceWidthMm: z.number(),
  k: z.number(),
  source: z.string(),
  caveat: z.string(),
  method: referenceMethodSchema,
  inputs: traceReferenceInputSchema,
  units: traceReferenceUnitsSchema.extend({
    traceWidthMm: z.literal('mm'),
    traceWidthMils: z.literal('mil'),
    copperThicknessMils: z.literal('mil'),
    requiredAreaMils2: z.literal('mil²'),
  }),
  limitations: z.array(z.string()),
});

const maxCurrentResultSchema = z.object({
  maxCurrentA: z.number(),
  source: z.string(),
  caveat: z.string(),
  method: referenceMethodSchema,
  inputs: maxCurrentReferenceInputSchema,
  units: z.object({
    maxCurrentA: z.literal('A'),
    traceWidthMils: z.literal('mil'),
    temperatureRiseC: z.literal('°C'),
    copperWeightOz: z.literal('oz/ft²'),
  }),
  limitations: z.array(z.string()),
});

const traceCurrentReviewSchema = z.object({
  status: z.enum(['WARNING', 'UNKNOWN']),
  method: referenceMethodSchema,
  evidence: z.literal('caller_supplied_unverified'),
  source: z.string(),
  inputs: z.object({
    currentA: currentASchema.optional(),
    temperatureRiseC: temperatureRiseCSchema.optional(),
    layer: conductorLayerSchema.optional(),
    copperWeightOz: copperWeightOzSchema.optional(),
    traceWidthMm: traceWidthMmSchema.optional(),
    neckDownWidthMm: traceWidthMmSchema.optional(),
    manufacturerMinWidthMm: traceWidthMmSchema.optional(),
    environment: environmentSchema.optional(),
  }),
  inputUnits: traceReferenceUnitsSchema.extend({
    traceWidthMm: z.literal('mm'),
    neckDownWidthMm: z.literal('mm'),
    manufacturerMinWidthMm: z.literal('mm'),
  }),
  estimatedMinimumWidthMm: z.number().optional(),
  suppliedNarrowestWidthMm: z.number().optional(),
  findings: z.array(
    z.object({
      id: z.enum(['THERMAL_ESTIMATE', 'FABRICATION_WIDTH', 'ROUTE_GEOMETRY', 'VIA_BOTTLENECK']),
      status: z.enum(['WARNING', 'UNKNOWN']),
      message: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
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

const isolationEmcFindingSchema = z.object({
  id: z.enum([
    'AIR_CLEARANCE',
    'SURFACE_CREEPAGE',
    'INSULATION_CONTEXT',
    'ESD_ENTRY',
    'EMC_RETURN',
  ]),
  status: z.enum(['WARNING', 'UNKNOWN']),
  message: z.string(),
  reported_mm: z.number().optional(),
  declared_min_mm: z.number().optional(),
  reference: standardEvidenceSchema.optional(),
  evidence_refs: z.array(z.string()),
  missing: z.array(z.string()),
});
const isolationEmcResultSchema = z.object({
  status: z.enum(['WARNING', 'UNKNOWN']),
  evidence: z.literal('caller_supplied_unverified'),
  safety_certification: z.literal(false),
  qualified_review_required: z.boolean(),
  context_missing: z.array(z.string()),
  findings: z.array(isolationEmcFindingSchema),
  limitations: z.array(z.string()),
  source_references: z.array(standardEvidenceSchema),
  engineering_sign_off: z.literal(false),
});

const outputSchema = z.object({
  topic: z.string(),
  traceWidth: traceWidthResultSchema.optional(),
  traceCurrentReview: traceCurrentReviewSchema.optional(),
  maxCurrent: maxCurrentResultSchema.optional(),
  clearance: clearanceResultSchema.optional(),
  protocolRouting: protocolRoutingResultSchema.optional(),
  protocolRoutingList: z.array(protocolRoutingResultSchema).optional(),
  decoupling: decouplingResultSchema.optional(),
  decouplingList: z.array(decouplingResultSchema).optional(),
  bulkCapacitance: bulkCapacitanceResultSchema.optional(),
  dfmChecklist: z.array(dfmChecklistItemSchema).optional(),
  dfmChecklistItem: dfmChecklistItemSchema.optional(),
  isolationEmcReview: isolationEmcResultSchema.optional(),
  error: z.string().optional(),
});

type LookupInput = z.infer<typeof lookupInputSchema>;
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
    case 'trace-current-review': {
      const { topic, ...reviewInput } = input;
      return { topic, traceCurrentReview: reviewTraceCurrent(reviewInput) };
    }
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
    case 'isolation-emc-review':
      return { topic: input.topic, isolationEmcReview: reviewIsolationEmc(input.review) };
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
      'Look up bounded trace/current, clearance, routing, decoupling, bulk capacitance ' +
      'and DFM guidance. Source-declared isolation, creepage and ESD/EMC review ' +
      'reports warnings or UNKNOWN, never safety certification.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'design-rules',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema,
    outputSchema,
    handler: async (_ctx: ToolContext, params: unknown) => {
      const topic =
        typeof params === 'object' &&
        params !== null &&
        'topic' in params &&
        typeof params.topic === 'string'
          ? params.topic
          : 'unknown';
      try {
        return handleLookup(lookupInputSchema.parse(params));
      } catch (err) {
        return {
          topic,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerDesignRulesTools };

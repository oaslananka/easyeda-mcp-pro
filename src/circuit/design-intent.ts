/**
 * DesignIntent — versioned, validated user requirements model.
 *
 * A DesignIntent captures what the user wants to build at a high level:
 * project goal, functional blocks, electrical requirements, power rails,
 * mechanical constraints, manufacturing intent, and safety/regulatory notes.
 *
 * DesignIntent is the **input** to the compile pipeline.  It is compiled
 * into a CircuitIR (the validated, machine-readable source of truth) which
 * downstream EasyEDA tools consume.
 *
 * @schema design-intent/v1
 */

import { z } from 'zod';
import { BoardType } from './types.js';
import { CircuitError, CircuitErrorCode, fromZodError } from './errors.js';
import { UsbIsolatedRs485ReferenceSchema } from './reference-design.js';

// ── Schema version ────────────────────────────────────────────────────────

export const DESIGN_INTENT_SCHEMA_VERSION = 'design-intent/v1';

// ── Sub-schemas ───────────────────────────────────────────────────────────

const boardTypeSchema = z.nativeEnum(BoardType);

const functionalBlockReqSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  purpose: z.string().min(1).max(1024),
  required: z.boolean().default(true),
});

const powerRailReqSchema = z.object({
  id: z.string().min(1).max(64),
  voltage: z.number().positive(),
  tolerance: z.number().min(0).max(100).default(5),
  maxCurrentAmps: z.number().nonnegative().optional(),
  description: z.string().max(256).optional(),
});

const electricalReqSchema = z.object({
  vinMin: z.number().nonnegative().optional(),
  vinMax: z.number().nonnegative().optional(),
  currentMaxAmps: z.number().nonnegative().optional(),
  frequencyMaxHz: z.number().nonnegative().optional(),
  notes: z.string().max(1024).optional(),
});

const mechanicalConstraintsSchema = z.object({
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  layers: z.number().int().positive().max(64).optional(),
  mountingHoles: z.boolean().optional(),
  notes: z.string().max(1024).optional(),
});

const manufacturingIntentSchema = z.object({
  volume: z.enum(['prototype', 'small-series', 'medium-series', 'mass-production']).optional(),
  process: z.enum(['lead-free', 'lead-based', 'mixed']).optional(),
  timelineWeeks: z.number().int().positive().optional(),
  notes: z.string().max(1024).optional(),
});

const safetyNotesSchema = z.object({
  isolation: z.boolean().optional(),
  certifications: z.array(z.string()).optional(),
  regulatory: z.string().max(2048).optional(),
});

// ── Full DesignIntent schema ──────────────────────────────────────────────

export const DesignIntentSchema = z
  .object({
    $schema: z.literal(DESIGN_INTENT_SCHEMA_VERSION).default(DESIGN_INTENT_SCHEMA_VERSION),

    project: z.object({
      name: z.string().min(1).max(128),
      goal: z.string().min(1).max(4096),
      boardType: boardTypeSchema,
    }),

    requirements: z.object({
      functionalBlocks: z.array(functionalBlockReqSchema).min(1, {
        message: 'At least one functional block is required',
      }),
      electrical: electricalReqSchema.default({}),
      power: z.object({
        rails: z.array(powerRailReqSchema).min(1, {
          message: 'At least one power rail is required',
        }),
      }),
      mechanical: mechanicalConstraintsSchema.default({}),
      manufacturing: manufacturingIntentSchema.default({}),
      safety: safetyNotesSchema.default({}),
    }),

    assumptions: z.array(z.string()).default([]),
    unknowns: z.array(z.string()).default([]),

    metadata: z
      .object({
        version: z.literal('1.0.0').default('1.0.0'),
        createdAt: z.string().datetime().optional(),
      })
      .optional(),

    referenceDesign: UsbIsolatedRs485ReferenceSchema.optional(),
  })
  .strict();

// ── Inferred type ─────────────────────────────────────────────────────────

export type DesignIntent = z.infer<typeof DesignIntentSchema>;

// ── Validation helper ─────────────────────────────────────────────────────

/**
 * Parse and validate an unknown input as a DesignIntent.
 *
 * Returns the validated DesignIntent on success.
 * Throws `CircuitError` with structured errors on failure.
 */
export function validateDesignIntent(input: unknown): DesignIntent {
  const result = DesignIntentSchema.safeParse(input);
  if (!result.success) {
    const errors = fromZodError(result.error, 'designIntent');
    throw new CircuitError({
      code: CircuitErrorCode.DESIGN_INTENT_INVALID,
      message: 'DesignIntent validation failed',
      errors,
    });
  }
  return result.data;
}

/**
 * Type guard: check whether an unknown value is a valid DesignIntent.
 */
export function isDesignIntent(value: unknown): value is DesignIntent {
  return DesignIntentSchema.safeParse(value).success;
}

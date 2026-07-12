/**
 * CircuitIR — versioned, validated, machine-readable circuit model.
 *
 * CircuitIR is the **source of truth** for downstream EasyEDA operations.
 * It is produced by compiling a DesignIntent, but can also be authored or
 * edited directly for advanced use cases.
 *
 * Every significant node (Block, Device, Net, Rail) carries a `designIntentRef`
 * array for traceability back to the originating DesignIntent requirements.
 *
 * @schema circuit-ir/v1
 */

import { z } from 'zod';
import {
  ValidationStatus,
  NetType,
  ConstraintSeverity,
  ConstraintType,
  BoardLayerType,
  KeepoutRestriction,
  PlacementSide,
  PlacementZoneType,
  MountingHoleType,
} from './types.js';
import { CircuitError, CircuitErrorCode, fromZodError } from './errors.js';
import { UsbIsolatedRs485ReferenceSchema } from './reference-design.js';

// ── Schema constants ──────────────────────────────────────────────────────

const MAX_STRING_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 2048;

// Field length constraints
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 128;
const MAX_TYPE_LENGTH = 64;
const MAX_REF_LENGTH = 32;
const MAX_LCSC_LENGTH = 32;
const MAX_SCOPE_LENGTH = 256;
const MAX_NOTE_LENGTH = 512;
const MAX_DESIGN_DESC_LENGTH = 256;

// ── Schema version ────────────────────────────────────────────────────────

export const CIRCUIT_IR_SCHEMA_VERSION = 'circuit-ir/v1';

// ── Sub-schemas ───────────────────────────────────────────────────────────

const designIntentRefSchema = z.object({
  requirementId: z.string().min(1),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
});

const metadataEntrySchema = z.object({ key: z.string(), value: z.string() });
const physicalValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const metadataSchema = z.object({
  version: z.literal('1.0.0').default('1.0.0'),
  createdAt: z.string().datetime().optional(),
  designIntentRef: z.string().optional(),
  validationStatus: z.nativeEnum(ValidationStatus).default(ValidationStatus.Draft),
});

// ── Block ─────────────────────────────────────────────────────────────────

export const BlockSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.string().min(1).max(MAX_TYPE_LENGTH),
  description: z.string().max(MAX_STRING_LENGTH).optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  children: z.array(z.string()).default([]),
});

export type Block = z.infer<typeof BlockSchema>;

// ── Device ────────────────────────────────────────────────────────────────

export const DeviceSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  ref: z.string().min(1).max(MAX_REF_LENGTH),
  mpn: z.string().max(MAX_NAME_LENGTH).optional(),
  manufacturer: z.string().max(MAX_NAME_LENGTH).optional(),
  package: z.string().max(MAX_NAME_LENGTH).optional(),
  datasheet: z.string().url().optional().or(z.literal('')),
  lcsc: z.string().max(MAX_LCSC_LENGTH).optional(),
  blockRef: z.string().max(MAX_ID_LENGTH).optional(),
  powerDomainRef: z.string().max(MAX_ID_LENGTH).optional(),
  placementZoneRef: z.string().max(MAX_ID_LENGTH).optional(),
  estimatedDissipationWatts: z.number().nonnegative().optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type Device = z.infer<typeof DeviceSchema>;

// ── Net ───────────────────────────────────────────────────────────────────

export const NetNodeSchema = z.object({
  deviceRef: z.string().min(1),
  pin: z.string().min(1),
});

export const NetSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.nativeEnum(NetType).default(NetType.Signal),
  nodes: z.array(NetNodeSchema).default([]),
  blockRef: z.string().max(MAX_ID_LENGTH).optional(),
  powerDomainRef: z.string().max(MAX_ID_LENGTH).optional(),
  signalClassRef: z.string().max(MAX_ID_LENGTH).optional(),
  railRef: z.string().max(MAX_ID_LENGTH).optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type Net = z.infer<typeof NetSchema>;
export type NetNode = z.infer<typeof NetNodeSchema>;

// ── Power Rail ────────────────────────────────────────────────────────────

export const PowerRailSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_ID_LENGTH),
  voltage: z.number(),
  tolerance: z.number().min(0).max(100).default(5),
  maxCurrentAmps: z.number().nonnegative().optional(),
  sourceBlockRef: z.string().max(MAX_ID_LENGTH).optional(),
  sinkBlockRefs: z.array(z.string()).default([]),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type PowerRail = z.infer<typeof PowerRailSchema>;

// ── Power Domain ──────────────────────────────────────────────────────────

export const PowerDomainSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  nominalVoltage: z.number().optional(),
  tolerancePercent: z.number().min(0).max(100).default(5),
  groundNet: z.string().max(MAX_NAME_LENGTH).optional(),
  railRefs: z.array(z.string().max(MAX_ID_LENGTH)).default([]),
  sourceRailRef: z.string().max(MAX_ID_LENGTH).optional(),
  loadDeviceRefs: z.array(z.string().max(MAX_ID_LENGTH)).default([]),
  maxCurrentAmps: z.number().nonnegative().optional(),
  isolation: z.enum(['none', 'functional', 'reinforced', 'galvanic']).default('none'),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type PowerDomain = z.infer<typeof PowerDomainSchema>;

// ── Signal Class ──────────────────────────────────────────────────────────

export const SignalClassSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  kind: z.enum([
    'digital',
    'analog',
    'power',
    'ground',
    'clock',
    'reset',
    'i2c',
    'spi',
    'uart',
    'usb',
    'can',
    'rf',
    'high-speed',
    'differential',
    'sensitive',
  ]),
  netNames: z.array(z.string().min(1).max(MAX_NAME_LENGTH)).default([]),
  differentialPair: z
    .object({
      positiveNet: z.string().min(1).max(MAX_NAME_LENGTH),
      negativeNet: z.string().min(1).max(MAX_NAME_LENGTH),
      targetImpedanceOhms: z.number().positive().optional(),
      lengthMatchToleranceMm: z.number().nonnegative().optional(),
    })
    .optional(),
  impedanceOhms: z.number().positive().optional(),
  maxFrequencyHz: z.number().positive().optional(),
  edgeRateNs: z.number().positive().optional(),
  routing: z
    .object({
      preferredLayer: z.string().max(MAX_ID_LENGTH).optional(),
      traceWidthMm: z.number().positive().optional(),
      clearanceMm: z.number().nonnegative().optional(),
      maxLengthMm: z.number().positive().optional(),
      shieldNet: z.string().max(MAX_NAME_LENGTH).optional(),
      returnPathNet: z.string().max(MAX_NAME_LENGTH).optional(),
    })
    .default({}),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type SignalClass = z.infer<typeof SignalClassSchema>;

// ── Physical Constraint ───────────────────────────────────────────────────

export const PhysicalConstraintSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  type: z.enum([
    'placement',
    'clearance',
    'creepage',
    'thermal',
    'height',
    'mechanical',
    'keepout',
    'accessibility',
    'testability',
  ]),
  severity: z.nativeEnum(ConstraintSeverity).default(ConstraintSeverity.Required),
  targetType: z.enum(['device', 'net', 'block', 'interface', 'zone', 'board']),
  targetRef: z.string().max(MAX_ID_LENGTH).optional(),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  value: physicalValueSchema.optional(),
  unit: z.string().max(MAX_TYPE_LENGTH).optional(),
  minClearanceMm: z.number().nonnegative().optional(),
  preferredSide: z.nativeEnum(PlacementSide).optional(),
  keepoutRef: z.string().max(MAX_ID_LENGTH).optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
  metadata: z.array(metadataEntrySchema).default([]),
});

export type PhysicalConstraint = z.infer<typeof PhysicalConstraintSchema>;

// ── Interface ─────────────────────────────────────────────────────────────

export const InterfacePinSchema = z.object({
  pin: z.string().min(1),
  signal: z.string().min(1),
  type: z.enum(['input', 'output', 'bidirectional', 'power', 'ground']).optional(),
});

export const InterfaceSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.string().min(1).max(MAX_TYPE_LENGTH),
  pinout: z.array(InterfacePinSchema).default([]),
  blockRef: z.string().max(MAX_ID_LENGTH).optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
});

export type Interface = z.infer<typeof InterfaceSchema>;
export type InterfacePin = z.infer<typeof InterfacePinSchema>;

// ── Constraint ────────────────────────────────────────────────────────────

export const ConstraintSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  type: z.nativeEnum(ConstraintType),
  severity: z.nativeEnum(ConstraintSeverity).default(ConstraintSeverity.Required),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
  designIntentRef: z.array(designIntentRefSchema).default([]),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

// ── BOM Intent ────────────────────────────────────────────────────────────

export const BomIntentSchema = z.object({
  excludeRefs: z.array(z.string()).default([]),
  preferredVendors: z.array(z.string()).default([]),
  costTargetUsd: z.number().nonnegative().optional(),
  notes: z.string().max(MAX_STRING_LENGTH).optional(),
});

export type BomIntent = z.infer<typeof BomIntentSchema>;

// ── PCB Intent ────────────────────────────────────────────────────────────

/** Board outline polygon (mm). */
const point2DSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const boardOutlineSchema = z.object({
  shape: z.array(point2DSchema).min(3, { message: 'Board outline must have at least 3 points' }),
  cutouts: z.array(z.array(point2DSchema)).optional(),
});

/** One layer in the PCB stackup. */
const layerStackEntrySchema = z.object({
  name: z.string().min(1).max(MAX_ID_LENGTH),
  type: z.nativeEnum(BoardLayerType),
  thicknessMm: z.number().positive(),
  material: z.string().min(1).max(MAX_ID_LENGTH),
  copperWeightOz: z.number().nonnegative().optional(),
  dielectricConstant: z.number().nonnegative().optional(),
  order: z.number().int().nonnegative(),
});

/** A net class with routing rules. */
const netClassRuleSchema = z.object({
  name: z.string().min(1).max(MAX_ID_LENGTH),
  traceWidthMm: z.number().positive(),
  clearanceMm: z.number().nonnegative(),
  viaDiameterMm: z.number().positive().optional(),
  viaHoleMm: z.number().positive().optional(),
  priority: z.number().int().nonnegative().optional(),
  netNames: z.array(z.string()).optional(),
});

/** Clearance rule between two net classes. */
const clearanceRuleSchema = z.object({
  netClassA: z.string().min(1),
  netClassB: z.string().min(1),
  clearanceMm: z.number().nonnegative(),
  layer: z.string().optional(),
});

/** A restricted area on the board. */
const keepoutAreaSchema = z.object({
  outline: z.array(point2DSchema).min(3),
  layer: z.string().min(1),
  restriction: z.nativeEnum(KeepoutRestriction),
  description: z.string().max(MAX_DESIGN_DESC_LENGTH).optional(),
});

/** A placement zone for grouping components. */
const placementZoneSchema = z.object({
  outline: z.array(point2DSchema).min(3),
  layer: z.nativeEnum(PlacementSide),
  zoneType: z.nativeEnum(PlacementZoneType),
  name: z.string().min(1).max(MAX_ID_LENGTH),
  allowedRefs: z.array(z.string()).optional(),
  description: z.string().max(MAX_DESIGN_DESC_LENGTH).optional(),
});

/** A mounting hole specification. */
const mountingHoleSchema = z.object({
  x: z.number(),
  y: z.number(),
  diameterMm: z.number().positive(),
  type: z.nativeEnum(MountingHoleType).default(MountingHoleType.Unplated),
  plated: z.boolean().default(false),
});

/** A fiducial mark. */
const fiducialSchema = z.object({
  x: z.number(),
  y: z.number(),
  type: z.enum(['global', 'local']),
  top: z.boolean(),
  bottom: z.boolean().optional(),
});

/** A test pad specification. */
const testPadSchema = z.object({
  x: z.number(),
  y: z.number(),
  netName: z.string().min(1),
  diameterMm: z.number().positive(),
  layer: z.nativeEnum(PlacementSide),
  label: z.string().max(MAX_ID_LENGTH).optional(),
});

export const PcbIntentSchema = z.object({
  // ── Board outline & dimensions ─────────────────────────────────────────
  layerCount: z.number().int().positive().max(MAX_ID_LENGTH).optional(),
  stackup: z.string().max(MAX_SCOPE_LENGTH).optional(),
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  material: z.string().max(MAX_NAME_LENGTH).optional(),
  notes: z.string().max(MAX_STRING_LENGTH).optional(),

  // ── PCB constraint fields ──────────────────────────────────────────────
  boardOutline: boardOutlineSchema.optional(),
  layerStack: z.array(layerStackEntrySchema).optional(),
  netClasses: z.array(netClassRuleSchema).optional(),
  clearanceRules: z.array(clearanceRuleSchema).optional(),
  keepoutAreas: z.array(keepoutAreaSchema).optional(),
  placementZones: z.array(placementZoneSchema).optional(),
  mountingHoles: z.array(mountingHoleSchema).optional(),
  fiducials: z.array(fiducialSchema).optional(),
  testPads: z.array(testPadSchema).optional(),
});

export type PcbIntent = z.infer<typeof PcbIntentSchema>;

// ── Manufacturing Intent ──────────────────────────────────────────────────

export const ManufacturingIntentSchema = z.object({
  quantity: z.number().int().positive().optional(),
  process: z.enum(['lead-free', 'lead-based', 'mixed']).optional(),
  timelineWeeks: z.number().int().positive().optional(),
  notes: z.string().max(MAX_STRING_LENGTH).optional(),
});

export type ManufacturingIntent = z.infer<typeof ManufacturingIntentSchema>;

// ── CircuitIR ─────────────────────────────────────────────────────────────

export const CircuitIRSchema = z
  .object({
    $schema: z.literal(CIRCUIT_IR_SCHEMA_VERSION).default(CIRCUIT_IR_SCHEMA_VERSION),
    metadata: metadataSchema,

    blocks: z.array(BlockSchema).default([]),
    devices: z.array(DeviceSchema).default([]),
    nets: z.array(NetSchema).default([]),
    rails: z.array(PowerRailSchema).default([]),
    powerDomains: z.array(PowerDomainSchema).default([]),
    signalClasses: z.array(SignalClassSchema).default([]),
    physicalConstraints: z.array(PhysicalConstraintSchema).default([]),
    interfaces: z.array(InterfaceSchema).default([]),
    constraints: z.array(ConstraintSchema).default([]),

    bom: BomIntentSchema.default({ excludeRefs: [], preferredVendors: [] }),
    pcb: PcbIntentSchema.default({}),
    manufacturing: ManufacturingIntentSchema.default({}),
    referenceDesign: UsbIsolatedRs485ReferenceSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      // All device refs and net node refs must reference valid devices
      const deviceIds = new Set(data.devices.map((d) => d.id));
      for (const net of data.nets) {
        for (const node of net.nodes) {
          if (!deviceIds.has(node.deviceRef)) {
            return false;
          }
        }
      }
      return true;
    },
    {
      message: 'All net node deviceRefs must reference a valid device ID',
      path: ['nets'],
    },
  )
  .refine(
    (data) => {
      // All blockRefs must reference valid blocks
      const blockIds = new Set(data.blocks.map((b) => b.id));
      for (const device of data.devices) {
        if (device.blockRef && !blockIds.has(device.blockRef)) {
          return false;
        }
      }
      return true;
    },
    {
      message: 'All device blockRefs must reference a valid block ID',
      path: ['devices'],
    },
  )
  .refine(
    (data) => {
      const railIds = new Set(data.rails.map((rail) => rail.id));
      for (const domain of data.powerDomains) {
        if (domain.sourceRailRef && !railIds.has(domain.sourceRailRef)) return false;
        if (domain.railRefs.some((railRef) => !railIds.has(railRef))) return false;
      }
      return true;
    },
    {
      message: 'All power domain railRefs must reference valid rails',
      path: ['powerDomains'],
    },
  )
  .refine(
    (data) => {
      const deviceIds = new Set(data.devices.map((device) => device.id));
      const domainIds = new Set(data.powerDomains.map((domain) => domain.id));
      for (const device of data.devices) {
        if (device.powerDomainRef && !domainIds.has(device.powerDomainRef)) return false;
      }
      for (const domain of data.powerDomains) {
        if (domain.loadDeviceRefs.some((deviceRef) => !deviceIds.has(deviceRef))) return false;
      }
      return true;
    },
    {
      message: 'All power domain device references must reference valid devices/domains',
      path: ['powerDomains'],
    },
  )
  .refine(
    (data) => {
      const deviceIds = new Set(data.devices.map((device) => device.id));
      const netNames = new Set(data.nets.map((net) => net.name));
      const netIds = new Set(data.nets.map((net) => net.id));
      const railIds = new Set(data.rails.map((rail) => rail.id));
      const domainIds = new Set(data.powerDomains.map((domain) => domain.id));
      const signalClassIds = new Set(data.signalClasses.map((signalClass) => signalClass.id));
      for (const net of data.nets) {
        if (net.powerDomainRef && !domainIds.has(net.powerDomainRef)) return false;
        if (net.signalClassRef && !signalClassIds.has(net.signalClassRef)) return false;
        if (net.railRef && !railIds.has(net.railRef)) return false;
      }
      for (const signalClass of data.signalClasses) {
        if (signalClass.netNames.some((netName) => !netNames.has(netName))) return false;
        if (signalClass.differentialPair) {
          if (!netNames.has(signalClass.differentialPair.positiveNet)) return false;
          if (!netNames.has(signalClass.differentialPair.negativeNet)) return false;
        }
      }
      for (const constraint of data.physicalConstraints) {
        if (!constraint.targetRef || constraint.targetType === 'board') continue;
        if (constraint.targetType === 'device' && !deviceIds.has(constraint.targetRef))
          return false;
        if (constraint.targetType === 'net' && !netIds.has(constraint.targetRef)) return false;
        if (
          constraint.targetType === 'block' &&
          !new Set(data.blocks.map((block) => block.id)).has(constraint.targetRef)
        )
          return false;
        if (
          constraint.targetType === 'interface' &&
          !new Set(data.interfaces.map((iface) => iface.id)).has(constraint.targetRef)
        )
          return false;
      }
      return true;
    },
    {
      message: 'CircuitIR domain, signal-class, and physical-constraint references must resolve',
      path: ['signalClasses'],
    },
  );

export type CircuitIR = z.infer<typeof CircuitIRSchema>;

// ── Validation helper ─────────────────────────────────────────────────────

/**
 * Parse and validate an unknown input as a CircuitIR.
 *
 * Returns the validated CircuitIR on success.
 * Throws `CircuitError` with structured errors on failure.
 */
export function validateCircuitIR(input: unknown): CircuitIR {
  const result = CircuitIRSchema.safeParse(input);
  if (!result.success) {
    const errors = fromZodError(result.error, 'circuitIR');
    throw new CircuitError({
      code: CircuitErrorCode.CIRCUIT_IR_INVALID,
      message: 'CircuitIR validation failed',
      errors,
    });
  }
  return result.data;
}

/**
 * Type guard: check whether an unknown value is a valid CircuitIR.
 */
export function isCircuitIR(value: unknown): value is CircuitIR {
  return CircuitIRSchema.safeParse(value).success;
}

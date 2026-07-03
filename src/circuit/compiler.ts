/**
 * DesignIntent → CircuitIR compiler.
 *
 * This module provides the compile boundary: a validated DesignIntent is
 * compiled into a draft CircuitIR.  The CircuitIR must then pass a review
 * gate (human or automated) before it is marked as "validated" and consumed
 * by downstream EasyEDA tools.
 *
 * The compiler:
 *   1. Validates the input DesignIntent.
 *   2. Transforms functional block requirements into Blocks.
 *   3. Creates power Rails from the DesignIntent's rail requirements.
 *   4. Plans one candidate Device per Block: a deterministic refdes, a
 *      component role, and a package-family hint (see component-planning.ts).
 *   5. Generates power Nets for each rail plus a synthesized common-ground Net.
 *   6. Wires device/power-domain load relationships when unambiguous, and
 *      synthesizes candidate connector Interfaces.
 *   7. Copies manufacturing, mechanical, and safety intent into CircuitIR fields.
 *   8. Preserves all traceability IDs.
 *
 * @module
 */

import { DesignIntent, DesignIntentSchema } from './design-intent.js';
import {
  CircuitIR,
  CircuitIRSchema,
  CIRCUIT_IR_SCHEMA_VERSION,
  Block,
  PowerRail,
  Device,
  Net,
  PowerDomain,
  SignalClass,
  PhysicalConstraint,
  Interface,
} from './circuit-ir.js';
import { ValidationStatus, NetType, ConstraintSeverity } from './types.js';
import { CircuitError, CircuitErrorCode, fromZodError } from './errors.js';
import { planComponents, getDeviceRole } from './component-planning.js';

// ── Compile options ───────────────────────────────────────────────────────

export interface CompileOptions {
  /** If true, skip DesignIntent validation (assumes pre-validated input). */
  skipValidation?: boolean;
  /** Optional override for the CircuitIR validation status after compile. */
  initialStatus?: ValidationStatus;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: CompileOptions = {
  skipValidation: false,
  initialStatus: ValidationStatus.Draft,
};

// ── Compile result ────────────────────────────────────────────────────────

export interface CompileResult {
  /** The compiled CircuitIR (draft — must pass review gate). */
  circuitIR: CircuitIR;
  /** The original DesignIntent, preserved for traceability. */
  designIntent: DesignIntent;
  /** Compile warnings (non-fatal issues the compiler wants to flag). */
  warnings: string[];
}

// ── Compile helpers ───────────────────────────────────────────────────────

function compileBlocks(designIntent: DesignIntent): Block[] {
  return designIntent.requirements.functionalBlocks.map((fb) => ({
    id: `block-${fb.id}`,
    name: fb.name,
    type: fb.type,
    description: fb.purpose,
    designIntentRef: [{ requirementId: fb.id, note: fb.purpose }],
    children: [],
  }));
}

function compilePowerRails(designIntent: DesignIntent, blocks: Block[]): PowerRail[] {
  return designIntent.requirements.power.rails.map((r) => {
    // Find which block this rail belongs to by matching the description / context
    const sourceBlock = blocks.find(
      (b) => r.description && b.description?.toLowerCase().includes(r.description.toLowerCase()),
    );
    return {
      id: `rail-${r.id}`,
      name: r.id,
      voltage: r.voltage,
      tolerance: r.tolerance,
      maxCurrentAmps: r.maxCurrentAmps,
      sourceBlockRef: sourceBlock?.id,
      sinkBlockRefs: [],
      designIntentRef: [{ requirementId: r.id }],
      metadata: [],
    };
  });
}

function compilePowerDomainId(rail: PowerRail): string {
  return `pd-${rail.id}`;
}

function compilePowerNets(rails: PowerRail[]): Net[] {
  return rails.map((rail) => ({
    id: `net-${rail.id}`,
    name: rail.name,
    type: NetType.Power,
    nodes: [],
    blockRef: rail.sourceBlockRef,
    railRef: rail.id,
    powerDomainRef: compilePowerDomainId(rail),
    signalClassRef: 'sc-power',
    designIntentRef: rail.designIntentRef,
    metadata: [],
  }));
}

function compilePowerDomains(rails: PowerRail[]): PowerDomain[] {
  return rails.map((rail) => ({
    id: compilePowerDomainId(rail),
    name: `${rail.name} power domain`,
    nominalVoltage: rail.voltage,
    tolerancePercent: rail.tolerance,
    railRefs: [rail.id],
    sourceRailRef: rail.id,
    loadDeviceRefs: [],
    maxCurrentAmps: rail.maxCurrentAmps,
    isolation: 'none',
    designIntentRef: rail.designIntentRef,
    metadata: [],
  }));
}

/**
 * Synthesize a single common-ground net. Every board with at least one power
 * rail needs a ground reference; this net is intentionally board-wide (not
 * tied to a specific rail or power domain) since DesignIntent does not model
 * multiple isolated ground planes.
 */
function compileGroundNet(rails: PowerRail[]): Net[] {
  if (rails.length === 0) return [];
  return [
    {
      id: 'net-gnd',
      name: 'GND',
      type: NetType.Ground,
      nodes: [],
      designIntentRef: [],
      metadata: [{ key: 'source', value: 'synthesized-common-ground' }],
    },
  ];
}

/**
 * Synthesize a candidate Interface entry for each block whose planned
 * component role is `connector`. Pinout is intentionally empty — DesignIntent
 * does not specify pin-level connector detail — but the Interface node makes
 * the connector's existence and traceability explicit before schematic entry.
 */
function compileInterfaceStubs(blocks: Block[], devices: Device[]): Interface[] {
  const deviceByBlockRef = new Map(devices.map((d) => [d.blockRef, d]));
  return blocks
    .filter((block) => {
      const device = deviceByBlockRef.get(block.id);
      return device ? getDeviceRole(device) === 'connector' : false;
    })
    .map((block) => ({
      id: `iface-${block.id}`,
      name: block.name,
      type: 'connector',
      pinout: [],
      blockRef: block.id,
      designIntentRef: block.designIntentRef,
    }));
}

/**
 * Attach each device to the power domain it most plausibly draws from or
 * supplies, and back-fill each power domain's `loadDeviceRefs`.
 *
 * This is intentionally conservative: DesignIntent does not specify which
 * rail a given functional block operates on, so device-level power-domain
 * assignment is only attempted when the design has exactly one rail overall
 * (an unambiguous case). For multi-rail designs the compiler emits a warning
 * instead of guessing a wrong rail assignment.
 */
function wirePowerDomainLoads(
  devices: Device[],
  rails: PowerRail[],
  powerDomains: PowerDomain[],
): { devices: Device[]; powerDomains: PowerDomain[]; warnings: string[] } {
  const warnings: string[] = [];

  if (rails.length !== 1 || powerDomains.length !== 1) {
    if (rails.length > 1) {
      warnings.push(
        `Design declares ${rails.length} power rails; automatic device-to-rail power-domain ` +
          `assignment was skipped because DesignIntent does not specify which rail each block ` +
          `operates on. Assign each Device.powerDomainRef manually during CircuitIR review.`,
      );
    }
    return { devices, powerDomains, warnings };
  }

  const domain = powerDomains[0];
  if (!domain) {
    return { devices, powerDomains, warnings };
  }

  const loadDeviceRefs = devices.map((device) => device.id);
  const updatedDevices = devices.map((device) => ({ ...device, powerDomainRef: domain.id }));
  const updatedDomains = powerDomains.map((pd) =>
    pd.id === domain.id ? { ...pd, loadDeviceRefs } : pd,
  );

  return { devices: updatedDevices, powerDomains: updatedDomains, warnings };
}

function compileSignalClasses(designIntent: DesignIntent, powerNets: Net[]): SignalClass[] {
  const classes: SignalClass[] = [
    {
      id: 'sc-power',
      name: 'Power rails',
      kind: 'power',
      netNames: powerNets.map((net) => net.name),
      routing: {
        traceWidthMm: designIntent.requirements.electrical.currentMaxAmps ? 0.5 : undefined,
        clearanceMm:
          designIntent.requirements.electrical.vinMax &&
          designIntent.requirements.electrical.vinMax > 30
            ? 0.6
            : 0.2,
      },
      designIntentRef: powerNets.flatMap((net) => net.designIntentRef),
      metadata: [],
    },
  ];

  if (designIntent.requirements.electrical.frequencyMaxHz) {
    classes.push({
      id: 'sc-high-speed',
      name: 'High-speed candidate signals',
      kind: 'high-speed',
      netNames: [],
      maxFrequencyHz: designIntent.requirements.electrical.frequencyMaxHz,
      routing: { returnPathNet: 'GND' },
      designIntentRef: [],
      metadata: [{ key: 'source', value: 'requirements.electrical.frequencyMaxHz' }],
    });
  }

  return classes;
}

function compilePhysicalConstraints(designIntent: DesignIntent): PhysicalConstraint[] {
  const constraints: PhysicalConstraint[] = [];
  const mechanical = designIntent.requirements.mechanical;
  if (mechanical.widthMm || mechanical.heightMm) {
    constraints.push({
      id: 'pc-board-outline',
      type: 'mechanical',
      severity: ConstraintSeverity.Required,
      targetType: 'board',
      description: 'Board outline must satisfy requested mechanical dimensions.',
      value: `${mechanical.widthMm ?? 'unspecified'}x${mechanical.heightMm ?? 'unspecified'}`,
      unit: 'mm',
      designIntentRef: [],
      metadata: [],
    });
  }
  if (mechanical.mountingHoles) {
    constraints.push({
      id: 'pc-mounting-holes',
      type: 'mechanical',
      severity: ConstraintSeverity.Required,
      targetType: 'board',
      description: 'Board requires mounting-hole placement planning before PCB write operations.',
      value: true,
      designIntentRef: [],
      metadata: [],
    });
  }
  if (designIntent.requirements.safety.isolation) {
    constraints.push({
      id: 'pc-isolation-clearance',
      type: 'creepage',
      severity: ConstraintSeverity.Required,
      targetType: 'board',
      description:
        'Isolation requirement must be converted into clearance and creepage rules before layout.',
      designIntentRef: [],
      metadata: [{ key: 'source', value: 'requirements.safety.isolation' }],
    });
  }
  return constraints;
}

function buildCircuitIR(
  designIntent: DesignIntent,
  blocks: Block[],
  rails: PowerRail[],
  devices: Device[],
  nets: Net[],
  powerDomains: PowerDomain[],
  signalClasses: SignalClass[],
  physicalConstraints: PhysicalConstraint[],
  interfaces: Interface[],
  opts: CompileOptions,
): CircuitIR {
  return {
    $schema: CIRCUIT_IR_SCHEMA_VERSION,
    metadata: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      designIntentRef: designIntent.project.name,
      validationStatus: opts.initialStatus ?? ValidationStatus.Draft,
    },
    blocks,
    devices,
    nets,
    rails,
    powerDomains,
    signalClasses,
    physicalConstraints,
    interfaces,
    constraints: [],
    bom: { excludeRefs: [], preferredVendors: [] },
    pcb: {
      layerCount: designIntent.requirements.mechanical.layers,
      widthMm: designIntent.requirements.mechanical.widthMm,
      heightMm: designIntent.requirements.mechanical.heightMm,
      boardOutline: undefined,
      layerStack: undefined,
      netClasses: undefined,
      clearanceRules: undefined,
      keepoutAreas: undefined,
      placementZones: undefined,
      mountingHoles: undefined,
      fiducials: undefined,
      testPads: undefined,
    },
    manufacturing: {
      quantity: undefined,
      process: designIntent.requirements.manufacturing.process,
      timelineWeeks: designIntent.requirements.manufacturing.timelineWeeks,
    },
  };
}

// ── Compiler ──────────────────────────────────────────────────────────────

/**
 * Compile a validated DesignIntent into a draft CircuitIR.
 *
 * Throws `CircuitError` if:
 *   - The input fails DesignIntent validation (unless `skipValidation`).
 *   - The board type is not supported by the compiler.
 */
export function compile(input: unknown, options?: CompileOptions): CompileResult {
  const opts: CompileOptions = { ...DEFAULT_OPTIONS, ...options };

  let designIntent: DesignIntent;

  // ── 1. Validate DesignIntent ────────────────────────────────────────────
  if (!opts.skipValidation) {
    const parsed = DesignIntentSchema.safeParse(input);
    if (!parsed.success) {
      const errors = fromZodError(parsed.error, 'compile.input');
      throw new CircuitError({
        code: CircuitErrorCode.DESIGN_INTENT_INVALID,
        message: 'Cannot compile: DesignIntent validation failed',
        errors,
      });
    }
    designIntent = parsed.data;
  } else {
    designIntent = input as DesignIntent;
  }

  const warnings: string[] = [];

  // ── 2. Compile Blocks ─────────────────────────────────────────────────
  const blocks = compileBlocks(designIntent);

  // ── 3. Compile Power Rails ──────────────────────────────────────────────
  const rails = compilePowerRails(designIntent, blocks);

  // ── 4. Plan candidate component roles, refdes, and package hints ───────
  const componentPlan = planComponents(blocks);
  warnings.push(...componentPlan.warnings);

  // ── 5. Create power + ground nets ───────────────────────────────────────
  const powerNets = compilePowerNets(rails);
  const groundNet = compileGroundNet(rails);
  const nets = [...powerNets, ...groundNet];

  // ── 6. Compile professional planning context ───────────────────────────
  const powerDomainWiring = wirePowerDomainLoads(
    componentPlan.devices,
    rails,
    compilePowerDomains(rails),
  );
  warnings.push(...powerDomainWiring.warnings);
  const devices = powerDomainWiring.devices;
  const powerDomains = powerDomainWiring.powerDomains;
  const signalClasses = compileSignalClasses(designIntent, powerNets);
  const physicalConstraints = compilePhysicalConstraints(designIntent);
  const interfaces = compileInterfaceStubs(blocks, devices);

  // ── 7. Build CircuitIR ──────────────────────────────────────────────────
  const circuitIR = buildCircuitIR(
    designIntent,
    blocks,
    rails,
    devices,
    nets,
    powerDomains,
    signalClasses,
    physicalConstraints,
    interfaces,
    opts,
  );

  // ── 8. Validate output CircuitIR ────────────────────────────────────────
  const parsed = CircuitIRSchema.safeParse(circuitIR);
  if (!parsed.success) {
    const errors = fromZodError(parsed.error, 'compile.output');
    throw new CircuitError({
      code: CircuitErrorCode.COMPILE_FAILED,
      message: 'Compilation produced invalid CircuitIR',
      errors,
    });
  }

  return {
    circuitIR: parsed.data,
    designIntent,
    warnings,
  };
}

// ── Review gate ───────────────────────────────────────────────────────────

/**
 * Transition a CircuitIR from "draft" to "validated" or "rejected".
 *
 * Downstream EasyEDA tools MUST check that the CircuitIR they consume
 * is in "validated" status before proceeding with mutations.
 */
export function setValidationStatus(
  circuitIR: CircuitIR,
  status: ValidationStatus.Validated | ValidationStatus.Rejected,
  _reason?: string,
): CircuitIR {
  return {
    ...circuitIR,
    metadata: {
      ...circuitIR.metadata,
      validationStatus: status,
    },
  };
}

/**
 * Check whether a CircuitIR is validated and ready for EasyEDA operations.
 */
export function isReadyForEasyEDA(circuitIR: CircuitIR): boolean {
  return circuitIR.metadata.validationStatus === ValidationStatus.Validated;
}

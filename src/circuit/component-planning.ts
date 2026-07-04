/**
 * Component role and refdes planning for CircuitIR device synthesis.
 *
 * Replaces generic `U?` device stubs with a deterministic, traceable
 * component-role plan: a refdes family, a package/footprint hint, and a
 * planning-state marker that differentiates a confidently-classified
 * candidate device from a low-confidence placeholder.
 *
 * This module intentionally does not select real MPNs, manufacturers, or
 * footprints — it narrows the search space (role + refdes + package family)
 * so a human, BOM-sourcing tool, or downstream planning step can make the
 * final manufacturable selection. See docs/circuit-ir.md for the full
 * synthesis pipeline this module is part of.
 *
 * @module
 */

import { BlockType } from './types.js';
import type { Block, Device } from './circuit-ir.js';

// ── Component roles ───────────────────────────────────────────────────────

export type ComponentRole =
  | 'power-regulator'
  | 'mcu-module'
  | 'sensor'
  | 'communication-ic'
  | 'analog-ic'
  | 'connector'
  | 'protection-diode'
  | 'fuse'
  | 'passive-support'
  | 'generic-ic';

/** Confidence that the role was inferred correctly from the DesignIntent block. */
export type RoleConfidence = 'high' | 'low';

export interface ComponentRolePlan {
  role: ComponentRole;
  confidence: RoleConfidence;
}

/** Deterministic refdes family per component role, matching common schematic convention. */
export const ROLE_REFDES_PREFIX: Record<ComponentRole, string> = {
  'power-regulator': 'U',
  'mcu-module': 'U',
  sensor: 'U',
  'communication-ic': 'U',
  'analog-ic': 'U',
  connector: 'J',
  'protection-diode': 'D',
  fuse: 'F',
  'passive-support': 'C',
  'generic-ic': 'U',
};

/** Conservative package/footprint family hint per role — not a final footprint selection. */
export const ROLE_PACKAGE_HINT: Record<ComponentRole, string> = {
  'power-regulator': 'SOT-23-5 or TO-220 (select by current/thermal rating)',
  'mcu-module': 'QFN/LQFP or module footprint (select by MCU family)',
  sensor: 'Manufacturer-specific package (verify against the selected sensor datasheet)',
  'communication-ic': 'SOIC/QFN (select by the selected transceiver/PHY datasheet)',
  'analog-ic': 'SOIC/SOT package (select by the selected part datasheet)',
  connector: 'THT or SMD connector footprint (select by mechanical/mating requirements)',
  'protection-diode': 'SOD-123/SMA (select by clamping voltage and current rating)',
  fuse: '0603/1206 SMD fuse or THT fuse holder (select by current rating)',
  'passive-support': '0402/0603 SMD passive (select values during schematic entry)',
  'generic-ic': 'TBD — insufficient design intent to suggest a package family',
};

/** Metadata keys the compiler attaches to each planned Device. */
export const COMPONENT_PLAN_METADATA_KEYS = {
  role: 'role',
  packageHint: 'packageHint',
  planningState: 'planningState',
} as const;

/**
 * Determine a component role for a Block from its `type` and free-text
 * `description` (the compiled block's purpose). Keyword matches on the
 * description take priority over the coarse `type` field because the
 * DesignIntent functional-block `type` is intentionally low-resolution
 * (e.g. "power-management" covers both regulators and passive filter
 * stages).
 */
export function determineComponentRole(block: {
  type: string;
  description?: string;
}): ComponentRolePlan {
  const text = `${block.type} ${block.description ?? ''}`.toLowerCase();

  if (
    text.includes('connector') ||
    text.includes('header') ||
    text.includes('usb') ||
    text.includes('jack')
  ) {
    return { role: 'connector', confidence: 'high' };
  }
  if (text.includes('fuse') || text.includes('polyfuse') || text.includes('ptc')) {
    return { role: 'fuse', confidence: 'high' };
  }
  if (text.includes('filter') || text.includes('decoupl') || text.includes('bypass')) {
    return { role: 'passive-support', confidence: 'high' };
  }

  switch (block.type) {
    case BlockType.PowerManagement:
      return { role: 'power-regulator', confidence: 'high' };
    case BlockType.Microcontroller:
      return { role: 'mcu-module', confidence: 'high' };
    case BlockType.Sensor:
      return { role: 'sensor', confidence: 'high' };
    case BlockType.Communication:
      return { role: 'communication-ic', confidence: 'high' };
    case BlockType.Interface:
      return { role: 'connector', confidence: 'high' };
    case BlockType.Protection:
      return { role: 'protection-diode', confidence: 'high' };
    case BlockType.Analog:
      return { role: 'analog-ic', confidence: 'high' };
    default:
      return { role: 'generic-ic', confidence: 'low' };
  }
}

export interface ComponentPlanResult {
  devices: Device[];
  warnings: string[];
}

/**
 * Plan one candidate Device per Block: a deterministic refdes, a component
 * role, and a package-family hint, recorded as Device metadata alongside
 * a `planningState` of `candidate` (role inferred with high confidence) or
 * `placeholder` (role could not be determined; manual classification
 * required).
 *
 * Refdes numbering is deterministic and stable across repeated compiles of
 * the same DesignIntent, because it is derived solely from block order.
 */
export function planComponents(blocks: Block[]): ComponentPlanResult {
  const refdesCounters: Record<string, number> = {};
  const warnings: string[] = [];

  const devices = blocks.map((block) => {
    const plan = determineComponentRole({ type: block.type, description: block.description });
    const prefix = ROLE_REFDES_PREFIX[plan.role];
    refdesCounters[prefix] = (refdesCounters[prefix] ?? 0) + 1;
    const ref = `${prefix}${refdesCounters[prefix]}`;
    const planningState = plan.confidence === 'high' ? 'candidate' : 'placeholder';

    if (planningState === 'placeholder') {
      warnings.push(
        `Block "${block.name}" (${block.id}): insufficient design intent to determine a ` +
          `component role; using a generic placeholder device (${ref}). Provide a more ` +
          `specific block type or purpose to enable manufacturable candidate planning.`,
      );
    }

    const device: Device = {
      id: `dev-${block.id}`,
      ref,
      mpn: undefined,
      manufacturer: undefined,
      package: undefined,
      datasheet: '',
      lcsc: undefined,
      blockRef: block.id,
      designIntentRef: block.designIntentRef,
      metadata: [
        { key: COMPONENT_PLAN_METADATA_KEYS.role, value: plan.role },
        { key: COMPONENT_PLAN_METADATA_KEYS.packageHint, value: ROLE_PACKAGE_HINT[plan.role] },
        { key: COMPONENT_PLAN_METADATA_KEYS.planningState, value: planningState },
      ],
    };
    return device;
  });

  return { devices, warnings };
}

/** Read a Device's planned component role back out of its metadata, if present. */
export function getDeviceRole(device: Device): ComponentRole | undefined {
  const value = device.metadata.find((m) => m.key === COMPONENT_PLAN_METADATA_KEYS.role)?.value;
  return value as ComponentRole | undefined;
}

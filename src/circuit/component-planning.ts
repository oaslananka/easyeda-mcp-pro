/**
 * Component role and refdes planning for CircuitIR device synthesis.
 *
 * Replaces generic `U?` device stubs with a deterministic, traceable
 * component-role plan: a refdes family, a package/footprint hint, and a
 * planning-state marker that differentiates a confidently-classified
 * candidate device from a low-confidence placeholder.
 *
 * By default this module does not select real MPNs, manufacturers, or
 * footprints — it narrows the search space (role + refdes + package family)
 * so a human, BOM-sourcing tool, or downstream planning step can make the
 * final manufacturable selection. Callers may optionally pass a pre-loaded
 * device catalog (`PlanComponentsOptions.catalog` — the starter catalog plus
 * any devices cached by `easyeda_catalog_verify_device`); when a
 * high-confidence role matches a non-obsolete catalog device, that device's
 * MPN/manufacturer/package/LCSC id are used and `planningState` becomes
 * `resolved` instead of `candidate`. See docs/catalog-ingestion.md for what
 * "resolved" does and does not guarantee, and docs/circuit-ir.md for the
 * full synthesis pipeline this module is part of.
 *
 * @module
 */

import { BlockType } from './types.js';
import type { Block, Device } from './circuit-ir.js';
import { UNRESOLVED_REF_PREFIX, type DeviceEntry } from '../catalog/schema.js';

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
  catalogDeviceId: 'catalogDeviceId',
} as const;

/**
 * Best-effort mapping from a component role to a catalog category
 * (`src/catalog/schema.ts`'s free-text `category` field). Roles with no
 * entry here (`generic-ic`) are never looked up — there's no reliable
 * category to search for a role that couldn't be classified.
 */
const ROLE_TO_CATALOG_CATEGORY: Partial<Record<ComponentRole, string>> = {
  'power-regulator': 'power',
  'mcu-module': 'microcontroller',
  sensor: 'sensor',
  'communication-ic': 'communication',
  'analog-ic': 'amplifier',
  connector: 'connector',
  'protection-diode': 'protection',
  fuse: 'protection',
  'passive-support': 'passive',
};

/**
 * Find the best catalog candidate for a component role, preferring devices
 * with a resolved (non-placeholder) symbol/footprint and a non-empty pin
 * map over ones ingested without an EasyEDA library match (see
 * `src/catalog/ingest.ts`). Returns `undefined` when the role has no
 * catalog-category mapping, no candidates exist, or all candidates are
 * obsolete.
 */
export function resolveCandidateDevice(
  role: ComponentRole,
  catalog: DeviceEntry[],
): DeviceEntry | undefined {
  const category = ROLE_TO_CATALOG_CATEGORY[role];
  if (!category) return undefined;

  const candidates = catalog.filter(
    (device) => device.category === category && device.lifecycleStatus !== 'obsolete',
  );
  if (candidates.length === 0) return undefined;

  const resolutionScore = (device: DeviceEntry): number =>
    (device.symbolRef.startsWith(UNRESOLVED_REF_PREFIX) ? 0 : 1) +
    (device.footprintRef.startsWith(UNRESOLVED_REF_PREFIX) ? 0 : 1) +
    (device.pinMapping.length > 0 ? 1 : 0);

  return [...candidates].sort((a, b) => resolutionScore(b) - resolutionScore(a))[0];
}

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

export interface PlanComponentsOptions {
  /**
   * A pre-loaded catalog (e.g. the starter catalog plus cached verified
   * devices from `easyeda_catalog_verify_device`) to resolve high-confidence
   * roles against. Omit to preserve the original role/refdes/package-hint-only
   * behavior — this parameter is purely additive and opt-in; existing callers
   * are unaffected.
   */
  catalog?: DeviceEntry[];
}

/**
 * Plan one candidate Device per Block: a deterministic refdes, a component
 * role, and a package-family hint, recorded as Device metadata alongside a
 * `planningState` of `resolved` (a verified catalog device matched the
 * role), `candidate` (role inferred with high confidence but no catalog
 * match), or `placeholder` (role could not be determined; manual
 * classification required).
 *
 * Refdes numbering is deterministic and stable across repeated compiles of
 * the same DesignIntent, because it is derived solely from block order.
 */
export function planComponents(
  blocks: Block[],
  options?: PlanComponentsOptions,
): ComponentPlanResult {
  const refdesCounters: Record<string, number> = {};
  const warnings: string[] = [];
  const catalog = options?.catalog;

  const devices = blocks.map((block) => {
    const plan = determineComponentRole({ type: block.type, description: block.description });
    const prefix = ROLE_REFDES_PREFIX[plan.role];
    refdesCounters[prefix] = (refdesCounters[prefix] ?? 0) + 1;
    const ref = `${prefix}${refdesCounters[prefix]}`;

    const match =
      catalog && plan.confidence === 'high'
        ? resolveCandidateDevice(plan.role, catalog)
        : undefined;
    const planningState = match
      ? 'resolved'
      : plan.confidence === 'high'
        ? 'candidate'
        : 'placeholder';

    if (planningState === 'placeholder') {
      warnings.push(
        `Block "${block.name}" (${block.id}): insufficient design intent to determine a ` +
          `component role; using a generic placeholder device (${ref}). Provide a more ` +
          `specific block type or purpose to enable manufacturable candidate planning.`,
      );
    } else if (catalog && plan.confidence === 'high' && !match) {
      warnings.push(
        `Block "${block.name}" (${block.id}): role "${plan.role}" has no matching verified ` +
          `catalog device (${ref}). Run easyeda_catalog_verify_device with a candidate LCSC ` +
          `part number to add one, or provide a manufacturable selection manually.`,
      );
    }

    const device: Device = {
      id: `dev-${block.id}`,
      ref,
      mpn: match?.mpn,
      manufacturer: match?.manufacturer,
      package: match?.package,
      datasheet: match?.datasheetUrl || '',
      lcsc: match?.lcsc,
      blockRef: block.id,
      designIntentRef: block.designIntentRef,
      metadata: [
        { key: COMPONENT_PLAN_METADATA_KEYS.role, value: plan.role },
        {
          key: COMPONENT_PLAN_METADATA_KEYS.packageHint,
          value: match?.package ?? ROLE_PACKAGE_HINT[plan.role],
        },
        { key: COMPONENT_PLAN_METADATA_KEYS.planningState, value: planningState },
        ...(match ? [{ key: COMPONENT_PLAN_METADATA_KEYS.catalogDeviceId, value: match.id }] : []),
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

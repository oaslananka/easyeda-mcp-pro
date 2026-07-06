/**
 * Decoupling capacitor placement guidance.
 *
 * Per-pin decoupling values here reflect widely-used industry rules of thumb (e.g. one
 * 100nF ceramic per digital power pin, placed as close to the pin as possible), not a
 * datasheet-specific requirement. Always check the target IC's datasheet for a
 * manufacturer-recommended decoupling network before finalizing layout — some parts
 * (RF transceivers, high-speed ADCs, switching regulators) call for a specific
 * multi-value network that this generic guidance does not capture.
 *
 * Bulk capacitance sizing reuses the same rule of thumb as the power-tree analyzer
 * ({@link requiredBulkCapacitance}) so the two tools never disagree with each other.
 *
 * @module
 */

import { requiredBulkCapacitance, DEFAULT_LIMITS } from '../power-tree/index.js';
import type { PowerTreeLimits } from '../power-tree/index.js';

export type DecouplingCategory =
  'digital-logic' | 'mcu' | 'analog' | 'rf' | 'crystal-oscillator' | 'power-regulator';

export interface PerPinDecouplingGuidance {
  category: DecouplingCategory;
  displayName: string;
  perPinCapacitorsNf: number[];
  placement: string;
  notes: string[];
  source: string;
  caveat: string;
}

const GENERIC_CAVEAT =
  "Rule-of-thumb guidance, not a datasheet-specific requirement — check the target IC's " +
  'datasheet for a manufacturer-recommended decoupling network before finalizing layout.';

const CATALOG: Record<DecouplingCategory, PerPinDecouplingGuidance> = {
  'digital-logic': {
    category: 'digital-logic',
    displayName: 'General digital logic (gates, buffers, simple ICs)',
    perPinCapacitorsNf: [100],
    placement:
      'One 100nF ceramic (X7R or better) per power pin, placed as close to the pin as possible',
    notes: [
      'Route power to the pin, then to the capacitor, then to the plane (not capacitor as a stub off a long trace)',
      'Use a via directly at the capacitor pad to reach the ground plane for the shortest return path',
    ],
    source: 'General digital IC decoupling practice',
    caveat: GENERIC_CAVEAT,
  },
  mcu: {
    category: 'mcu',
    displayName: 'Microcontrollers / SoCs',
    perPinCapacitorsNf: [100, 10000],
    placement:
      'One 100nF ceramic per VDD/VDDIO pin close to the pin, plus one 1-10uF bulk ceramic or ' +
      'tantalum per power domain near the device',
    notes: [
      'Multi-power-domain MCUs (e.g. separate VDD/VDDA/VBAT) need this per domain, not just once for the whole part',
      'Check the datasheet for VDDA/VREF filtering — many MCUs specify a separate ferrite bead or ' +
        'RC filter for the analog supply that this generic guidance does not cover',
    ],
    source: 'General MCU/SoC decoupling practice',
    caveat: GENERIC_CAVEAT,
  },
  analog: {
    category: 'analog',
    displayName: 'Analog ICs (op-amps, ADCs, DACs, references)',
    perPinCapacitorsNf: [100],
    placement:
      'One 100nF ceramic per analog supply pin, close to the pin, with a solid unbroken return path; ' +
      'keep analog and digital ground/power decoupling physically separated',
    notes: [
      'Avoid routing noisy digital signals or switching regulator traces near analog decoupling networks',
      'Split analog/digital ground planes only if the datasheet explicitly recommends it for that part ' +
        '— otherwise a single ground plane with careful component placement is usually preferred',
    ],
    source: 'General analog IC decoupling practice',
    caveat: GENERIC_CAVEAT,
  },
  rf: {
    category: 'rf',
    displayName: 'RF transceivers / PAs',
    perPinCapacitorsNf: [100, 1000],
    placement:
      'Multiple capacitor values in parallel (e.g. 100nF + a smaller high-frequency value the ' +
      "datasheet specifies) directly at the supply pin, per the manufacturer's reference design",
    notes: [
      "RF supply decoupling is highly part-specific — always follow the manufacturer's reference design/layout guide",
      'Ground vias and plane continuity near RF sections matter more than for general digital/analog circuits',
    ],
    source: 'General RF IC decoupling practice — defer to manufacturer reference design',
    caveat: GENERIC_CAVEAT,
  },
  'crystal-oscillator': {
    category: 'crystal-oscillator',
    displayName: 'Crystal oscillator supply pins',
    perPinCapacitorsNf: [100],
    placement: 'One 100nF ceramic on the oscillator/crystal driver supply pin, close to the pin',
    notes: [
      "Load capacitors on the crystal's XIN/XOUT pins are sized from the crystal's specified load " +
        'capacitance, not from this generic decoupling guidance — see the crystal datasheet',
      'Keep crystal traces short and away from switching/noisy signals to avoid frequency instability',
    ],
    source: 'General crystal oscillator decoupling practice',
    caveat: GENERIC_CAVEAT,
  },
  'power-regulator': {
    category: 'power-regulator',
    displayName: 'Linear/switching regulator input & output',
    perPinCapacitorsNf: [100, 10000],
    placement:
      'Input and output bulk capacitors sized per the regulator datasheet (often 1-22uF), plus a ' +
      '100nF ceramic close to the IC if the datasheet calls for one',
    notes: [
      'Switching regulator input/output capacitor values and ESR requirements are highly part-specific — ' +
        'follow the datasheet reference design rather than a generic value',
      'See requiredBulkCapacitance() / the power-tree analyzer for rail-level bulk capacitance sizing',
    ],
    source: 'General regulator decoupling practice — defer to manufacturer reference design',
    caveat: GENERIC_CAVEAT,
  },
};

export function lookupDecouplingGuidance(category: DecouplingCategory): PerPinDecouplingGuidance {
  const entry = CATALOG[category];
  if (!entry) throw new Error(`Unknown decoupling category: ${String(category)}`);
  return entry;
}

export function listDecouplingCategories(): DecouplingCategory[] {
  return Object.keys(CATALOG) as DecouplingCategory[];
}

export interface BulkCapacitanceRecommendation {
  requiredBulkCapacitanceUf: number;
  loadA: number;
  source: string;
  caveat: string;
}

/**
 * Rail-level bulk capacitance sizing, reusing the exact same rule of thumb as the
 * power-tree analyzer ({@link requiredBulkCapacitance}) so this tool's suggestion and a
 * power-tree analysis of the same rail can never silently disagree.
 */
export function recommendBulkCapacitance(
  loadA: number,
  limits?: PowerTreeLimits,
): BulkCapacitanceRecommendation {
  if (!(loadA > 0)) throw new Error('loadA must be a positive number');
  // Explicit `undefined` values in `limits` (e.g. from an optional tool input that wasn't
  // provided) must not override DEFAULT_LIMITS via spread, so only merge defined keys.
  const definedLimits = limits
    ? Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined))
    : {};
  const merged = { ...DEFAULT_LIMITS, ...definedLimits };
  const requiredUf = requiredBulkCapacitance(loadA, merged);
  return {
    requiredBulkCapacitanceUf: Math.round(requiredUf * 100) / 100,
    loadA,
    source:
      `Rule of thumb: ${merged.minBulkCapacitanceUfPerA}uF per amp of rail load, ` +
      `${merged.minBulkCapacitanceUf}uF floor (shared with the power-tree analyzer)`,
    caveat: GENERIC_CAVEAT,
  };
}

/**
 * Simplified electrical clearance guidance.
 *
 * IPC-2221's actual clearance tables (Table 6-1 through 6-4) have many bands split
 * by altitude, coating, and external/internal placement, with fine voltage
 * breakpoints. Reproducing that table precisely risks getting a breakpoint subtly
 * wrong — and a wrong *clearance* value is a safety-relevant mistake in a way a wrong
 * *trace-width* estimate on the conservative side is not. Rather than approximate the
 * fine breakpoints, this module offers a small number of deliberately coarse,
 * rounded-up bands that follow IPC-2221's general "clearance grows with voltage"
 * shape, clearly labeled as a starting estimate.
 *
 * **Always consult the current IPC-2221 revision's actual tables (or your
 * fabricator's certified minimums) before finalizing a safety-critical or
 * regulatory (e.g. mains-adjacent) clearance.**
 *
 * @module
 */

export type ConductorLocation = 'external' | 'internal';

const CLEARANCE_SOURCE =
  "Simplified, conservative approximation inspired by IPC-2221's clearance-vs-voltage bands — not a reproduction of the exact table.";
const CLEARANCE_CAVEAT =
  "Consult the current IPC-2221 revision (Table 6-1 through 6-4) or your fabricator's " +
  'certified minimum clearances before finalizing a safety-critical, mains-adjacent, or ' +
  'regulatory clearance. This estimate deliberately rounds up for safety margin.';

interface ClearanceBand {
  maxVoltageV: number;
  externalMm: number;
  internalMm: number;
}

/**
 * Coarse, safety-margined bands. Internal clearances are set at least as large as
 * external for the same band (a conservative simplification — real internal
 * clearances at low voltage are sometimes smaller than external in the full IPC-2221
 * table, but never larger, so this never under-recommends).
 */
const BANDS: ClearanceBand[] = [
  { maxVoltageV: 30, externalMm: 0.15, internalMm: 0.15 },
  { maxVoltageV: 100, externalMm: 0.25, internalMm: 0.3 },
  { maxVoltageV: 300, externalMm: 0.6, internalMm: 0.6 },
  { maxVoltageV: 500, externalMm: 1.5, internalMm: 1.5 },
];

export interface ClearanceInput {
  /** Voltage difference between the two conductors (peak, if AC), in volts. */
  voltageV: number;
  location: ConductorLocation;
}

export interface ClearanceResult {
  minClearanceMm: number;
  minClearanceMils: number;
  bandMaxVoltageV: number;
  source: string;
  caveat: string;
  outOfRange?: boolean;
}

export function lookupClearance(input: ClearanceInput): ClearanceResult {
  const { voltageV, location } = input;
  if (!(voltageV >= 0)) throw new Error('voltageV must be a non-negative number');

  const band = BANDS.find((b) => voltageV <= b.maxVoltageV);
  if (!band) {
    const last = BANDS.at(-1) ?? BANDS[0];
    if (!last) throw new Error('Clearance band table is empty');
    return {
      minClearanceMm: last.internalMm,
      minClearanceMils: round(last.internalMm / 0.0254, 1),
      bandMaxVoltageV: last.maxVoltageV,
      source: CLEARANCE_SOURCE,
      caveat:
        `${CLEARANCE_CAVEAT} This voltage (${voltageV}V) exceeds this module's covered range ` +
        `(>${last.maxVoltageV}V) — consult IPC-2221 high-voltage guidance and applicable safety ` +
        'standards (e.g. IEC 60950-1/62368-1) directly rather than using this floor value.',
      outOfRange: true,
    };
  }

  const mm = location === 'external' ? band.externalMm : band.internalMm;
  return {
    minClearanceMm: mm,
    minClearanceMils: round(mm / 0.0254, 1),
    bandMaxVoltageV: band.maxVoltageV,
    source: CLEARANCE_SOURCE,
    caveat: CLEARANCE_CAVEAT,
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

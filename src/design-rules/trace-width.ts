/**
 * IPC-2221 conductor current-carrying capacity.
 *
 * Formula (IPC-2221, formerly MIL-STD-275, the widely-cited empirical curve fit):
 *
 *   I = k · ΔT^0.44 · A^0.725
 *
 * where `I` is current in amps, `ΔT` is the allowed temperature rise in °C, `A` is
 * conductor cross-sectional area in mils², and `k` is 0.048 for external (outer
 * layer) conductors or 0.024 for internal conductors.
 *
 * This is an estimate, not a certified value: the curve does not model adjacent-trace
 * heating, via/plane proximity, forced airflow, or altitude. IPC-2152 supersedes
 * IPC-2221 with more conservative guidance for dense modern boards. Verify against
 * your fabricator's process and cross-check with IPC-2152 for safety-critical or
 * high-reliability current paths.
 *
 * @module
 */

export type ConductorLayer = 'external' | 'internal';

/** IPC-2221 empirical constant for external (outer layer) conductors. */
const K_EXTERNAL = 0.048;
/** IPC-2221 empirical constant for internal conductors. */
const K_INTERNAL = 0.024;

/** Standard copper thickness in mils per oz/ft² of copper weight (1oz ≈ 1.378 mils / 34.8 µm). */
export const COPPER_THICKNESS_MILS_PER_OZ = 1.378;

const IPC2221_SOURCE = 'IPC-2221 (formerly MIL-STD-275): I = k·ΔT^0.44·A^0.725';
const IPC2221_CAVEAT =
  'Estimate only — does not model adjacent-trace heating, via/plane proximity, or airflow. ' +
  'Verify against your fabricator process; cross-check with IPC-2152 for dense or ' +
  'high-reliability boards.';

function kFor(layer: ConductorLayer): number {
  return layer === 'external' ? K_EXTERNAL : K_INTERNAL;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface TraceWidthInput {
  /** Required current-carrying capacity, in amps. */
  currentA: number;
  /** Allowed conductor temperature rise above ambient, in °C. */
  temperatureRiseC: number;
  /** Whether the trace is on an external (outer) or internal layer. */
  layer: ConductorLayer;
  /** Copper weight in oz/ft² (e.g. 1, 2, 0.5). */
  copperWeightOz: number;
}

export interface TraceWidthResult {
  requiredAreaMils2: number;
  copperThicknessMils: number;
  traceWidthMils: number;
  traceWidthMm: number;
  k: number;
  source: string;
  caveat: string;
}

/** Compute the minimum trace width for a given current, temperature rise, layer, and copper weight. */
export function calculateTraceWidth(input: TraceWidthInput): TraceWidthResult {
  const { currentA, temperatureRiseC, layer, copperWeightOz } = input;
  if (!(currentA > 0)) throw new Error('currentA must be a positive number');
  if (!(temperatureRiseC > 0)) throw new Error('temperatureRiseC must be a positive number');
  if (!(copperWeightOz > 0)) throw new Error('copperWeightOz must be a positive number');

  const k = kFor(layer);
  const areaMils2 = Math.pow(currentA / (k * Math.pow(temperatureRiseC, 0.44)), 1 / 0.725);
  const thicknessMils = copperWeightOz * COPPER_THICKNESS_MILS_PER_OZ;
  const widthMils = areaMils2 / thicknessMils;

  return {
    requiredAreaMils2: round(areaMils2, 3),
    copperThicknessMils: round(thicknessMils, 3),
    traceWidthMils: round(widthMils, 2),
    traceWidthMm: round(widthMils * 0.0254, 4),
    k,
    source: IPC2221_SOURCE,
    caveat: IPC2221_CAVEAT,
  };
}

export interface MaxCurrentInput {
  /** Trace width in mils. */
  traceWidthMils: number;
  /** Allowed conductor temperature rise above ambient, in °C. */
  temperatureRiseC: number;
  layer: ConductorLayer;
  copperWeightOz: number;
}

export interface MaxCurrentResult {
  maxCurrentA: number;
  source: string;
  caveat: string;
}

/** Reverse lookup: the maximum current a given trace width can carry under the same model. */
export function calculateMaxCurrent(input: MaxCurrentInput): MaxCurrentResult {
  const { traceWidthMils, temperatureRiseC, layer, copperWeightOz } = input;
  if (!(traceWidthMils > 0)) throw new Error('traceWidthMils must be a positive number');
  if (!(temperatureRiseC > 0)) throw new Error('temperatureRiseC must be a positive number');
  if (!(copperWeightOz > 0)) throw new Error('copperWeightOz must be a positive number');

  const k = kFor(layer);
  const thicknessMils = copperWeightOz * COPPER_THICKNESS_MILS_PER_OZ;
  const areaMils2 = traceWidthMils * thicknessMils;
  const maxCurrentA = k * Math.pow(temperatureRiseC, 0.44) * Math.pow(areaMils2, 0.725);

  return {
    maxCurrentA: round(maxCurrentA, 3),
    source: IPC2221_SOURCE,
    caveat: IPC2221_CAVEAT,
  };
}

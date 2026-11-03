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
 * heating, via/plane proximity, forced airflow, or altitude. IPC-2152 provides
 * measured thermal guidance for a wider range of PCB conditions, not universally
 * more conservative estimates. Verify against the actual fabrication process and
 * thermal guidance for safety-critical and high-reliability current paths.
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
export const TRACE_WIDTH_METHOD = 'IPC2221_EMPIRICAL_REFERENCE' as const;
const TRACE_WIDTH_LIMITATIONS = [
  'Empirical IPC-2221 estimate only; not measured PCB or IPC-2152 thermal output.',
  'Nominal copper weight does not verify finished copper thickness.',
  'Copper planes, airflow, via bottlenecks, neck-downs and neighboring heat are not modeled.',
] as const;

const IPC2221_CAVEAT =
  'Estimate only — does not model adjacent-trace heating, via/plane proximity, or airflow. ' +
  'IPC-2152 includes board stackup, copper planes, environment and thermal coupling; ' +
  'it is not uniformly more conservative. Validate the board and fabrication process.';

function kFor(layer: ConductorLayer): number {
  return layer === 'external' ? K_EXTERNAL : K_INTERNAL;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(name + ' must be a finite positive number');
  }
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
  method: typeof TRACE_WIDTH_METHOD;
  inputs: TraceWidthInput;
  units: {
    currentA: 'A';
    temperatureRiseC: '°C';
    copperWeightOz: 'oz/ft²';
    traceWidthMm: 'mm';
    traceWidthMils: 'mil';
    copperThicknessMils: 'mil';
    requiredAreaMils2: 'mil²';
  };
  limitations: string[];
}

/** Compute the minimum trace width for a given current, temperature rise, layer, and copper weight. */
export function calculateTraceWidth(input: TraceWidthInput): TraceWidthResult {
  const { currentA, temperatureRiseC, layer, copperWeightOz } = input;
  assertPositiveFinite('currentA', currentA);
  assertPositiveFinite('temperatureRiseC', temperatureRiseC);
  assertPositiveFinite('copperWeightOz', copperWeightOz);

  const k = kFor(layer);
  const areaMils2 = Math.pow(currentA / (k * Math.pow(temperatureRiseC, 0.44)), 1 / 0.725);
  const thicknessMils = copperWeightOz * COPPER_THICKNESS_MILS_PER_OZ;
  const widthMils = areaMils2 / thicknessMils;
  assertPositiveFinite('computedTraceWidthMils', widthMils);

  return {
    requiredAreaMils2: round(areaMils2, 3),
    copperThicknessMils: round(thicknessMils, 3),
    traceWidthMils: round(widthMils, 2),
    traceWidthMm: round(widthMils * 0.0254, 4),
    k,
    source: IPC2221_SOURCE,
    caveat: IPC2221_CAVEAT,
    method: TRACE_WIDTH_METHOD,
    inputs: { ...input },
    units: {
      currentA: 'A',
      temperatureRiseC: '°C',
      copperWeightOz: 'oz/ft²',
      traceWidthMm: 'mm',
      traceWidthMils: 'mil',
      copperThicknessMils: 'mil',
      requiredAreaMils2: 'mil²',
    },
    limitations: [...TRACE_WIDTH_LIMITATIONS],
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
  method: typeof TRACE_WIDTH_METHOD;
  inputs: MaxCurrentInput;
  units: {
    maxCurrentA: 'A';
    traceWidthMils: 'mil';
    temperatureRiseC: '°C';
    copperWeightOz: 'oz/ft²';
  };
  limitations: string[];
}

/** Reverse lookup: the maximum current a given trace width can carry under the same model. */
export function calculateMaxCurrent(input: MaxCurrentInput): MaxCurrentResult {
  const { traceWidthMils, temperatureRiseC, layer, copperWeightOz } = input;
  assertPositiveFinite('traceWidthMils', traceWidthMils);
  assertPositiveFinite('temperatureRiseC', temperatureRiseC);
  assertPositiveFinite('copperWeightOz', copperWeightOz);

  const k = kFor(layer);
  const thicknessMils = copperWeightOz * COPPER_THICKNESS_MILS_PER_OZ;
  const areaMils2 = traceWidthMils * thicknessMils;
  const maxCurrentA = k * Math.pow(temperatureRiseC, 0.44) * Math.pow(areaMils2, 0.725);
  assertPositiveFinite('computedMaxCurrentA', maxCurrentA);

  return {
    maxCurrentA: round(maxCurrentA, 3),
    source: IPC2221_SOURCE,
    caveat: IPC2221_CAVEAT,
    method: TRACE_WIDTH_METHOD,
    inputs: { ...input },
    units: {
      maxCurrentA: 'A',
      traceWidthMils: 'mil',
      temperatureRiseC: '°C',
      copperWeightOz: 'oz/ft²',
    },
    limitations: [...TRACE_WIDTH_LIMITATIONS],
  };
}

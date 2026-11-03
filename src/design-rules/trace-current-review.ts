import { calculateTraceWidth, type ConductorLayer } from './trace-width.js';

/**
 * An auditable reference estimate, not a verification of an EasyEDA route.
 * All geometry and material inputs are caller supplied; no native readings
 * or vendor thermal validation are implied.
 */
export interface TraceCurrentReviewInput {
  currentA?: number;
  temperatureRiseC?: number;
  layer?: ConductorLayer;
  copperWeightOz?: number;
  traceWidthMm?: number;
  neckDownWidthMm?: number;
  manufacturerMinWidthMm?: number;
  environment?: 'still-air' | 'forced-air' | 'vacuum' | 'unspecified';
}

export interface TraceCurrentFinding {
  id: 'THERMAL_ESTIMATE' | 'FABRICATION_WIDTH' | 'ROUTE_GEOMETRY' | 'VIA_BOTTLENECK';
  status: 'WARNING' | 'UNKNOWN';
  message: string;
}

export interface TraceCurrentReview {
  status: 'WARNING' | 'UNKNOWN';
  method: 'IPC2221_EMPIRICAL_REFERENCE';
  evidence: 'caller_supplied_unverified';
  source: string;
  inputs: TraceCurrentReviewInput;
  inputUnits: {
    currentA: 'A';
    temperatureRiseC: '°C';
    copperWeightOz: 'oz/ft²';
    traceWidthMm: 'mm';
    neckDownWidthMm: 'mm';
    manufacturerMinWidthMm: 'mm';
  };
  estimatedMinimumWidthMm?: number;
  suppliedNarrowestWidthMm?: number;
  findings: TraceCurrentFinding[];
  limitations: string[];
}

const THERMAL_LIMITATIONS = [
  'IPC-2221 empirical estimate, not an IPC-2152 calculation or validated thermal limit.',
  'Copper weight is nominal: finished minimum plated copper thickness can differ.',
  'Actual temperature depends on board material/thickness, copper planes, adjacent heat, airflow and duty cycle.',
  'Via transitions, plane connections and local neck-downs require separate review.',
  'Fabricator trace/space capability and electrical thermal adequacy are different checks.',
];

const INPUT_UNITS = {
  currentA: 'A',
  temperatureRiseC: '°C',
  copperWeightOz: 'oz/ft²',
  traceWidthMm: 'mm',
  neckDownWidthMm: 'mm',
  manufacturerMinWidthMm: 'mm',
} as const;

function hasCompleteModelInput(input: TraceCurrentReviewInput): input is TraceCurrentReviewInput & {
  currentA: number;
  temperatureRiseC: number;
  layer: ConductorLayer;
  copperWeightOz: number;
} {
  return (
    input.currentA !== undefined &&
    input.temperatureRiseC !== undefined &&
    input.layer !== undefined &&
    input.copperWeightOz !== undefined
  );
}

function thermalFinding(
  estimate: number | undefined,
  narrowest: number | undefined,
): TraceCurrentFinding {
  if (estimate === undefined) {
    return {
      id: 'THERMAL_ESTIMATE',
      status: 'UNKNOWN',
      message: 'Current, temperature rise, layer and copper weight must all be supplied.',
    };
  }
  if (narrowest === undefined) {
    return {
      id: 'THERMAL_ESTIMATE',
      status: 'UNKNOWN',
      message: 'Only a reference width was calculated; actual routed width was not supplied.',
    };
  }
  if (narrowest < estimate) {
    return {
      id: 'THERMAL_ESTIMATE',
      status: 'WARNING',
      message:
        'Supplied width is below the IPC-2221 empirical estimate; review current path and thermal design.',
    };
  }
  return {
    id: 'THERMAL_ESTIMATE',
    status: 'UNKNOWN',
    message: 'Supplied width meets the empirical reference, but thermal adequacy is not verified.',
  };
}

function fabricationFinding(input: TraceCurrentReviewInput): TraceCurrentFinding {
  const { traceWidthMm, neckDownWidthMm, manufacturerMinWidthMm } = input;
  const narrowest =
    traceWidthMm === undefined
      ? undefined
      : Math.min(traceWidthMm, neckDownWidthMm ?? traceWidthMm);
  if (manufacturerMinWidthMm === undefined || narrowest === undefined) {
    return {
      id: 'FABRICATION_WIDTH',
      status: 'UNKNOWN',
      message: 'No verified manufacturer minimum or complete routed geometry is available.',
    };
  }
  if (narrowest < manufacturerMinWidthMm) {
    return {
      id: 'FABRICATION_WIDTH',
      status: 'WARNING',
      message: 'Supplied routed width is below the supplied fabricator trace-width minimum.',
    };
  }
  return {
    id: 'FABRICATION_WIDTH',
    status: 'UNKNOWN',
    message:
      'The supplied trace width meets the claimed fabricator minimum, but the process was not verified.',
  };
}

function validateReviewInput(input: TraceCurrentReviewInput): void {
  for (const field of [
    'currentA',
    'temperatureRiseC',
    'copperWeightOz',
    'traceWidthMm',
    'neckDownWidthMm',
    'manufacturerMinWidthMm',
  ] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(field + ' must be a finite positive number');
    }
  }
}

export function reviewTraceCurrent(input: TraceCurrentReviewInput): TraceCurrentReview {
  validateReviewInput(input);
  const estimate = hasCompleteModelInput(input)
    ? calculateTraceWidth({
        currentA: input.currentA,
        temperatureRiseC: input.temperatureRiseC,
        layer: input.layer,
        copperWeightOz: input.copperWeightOz,
      }).traceWidthMm
    : undefined;
  // Width of a single straight segment is not proof of the entire current path.
  const narrowest =
    input.traceWidthMm === undefined
      ? undefined
      : Math.min(input.traceWidthMm, input.neckDownWidthMm ?? input.traceWidthMm);
  const findings: TraceCurrentFinding[] = [
    thermalFinding(estimate, narrowest),
    fabricationFinding(input),
    {
      id: 'ROUTE_GEOMETRY',
      status: 'UNKNOWN',
      message:
        input.neckDownWidthMm === undefined
          ? 'The narrowest actual segment has not been established by live EasyEDA routing measurements.'
          : 'The supplied neck-down is not verified against the complete native route.',
    },
    {
      id: 'VIA_BOTTLENECK',
      status: 'UNKNOWN',
      message:
        'No verified via barrel/transition geometry or parallel-current evidence is available.',
    },
  ];
  const limitations = [
    ...THERMAL_LIMITATIONS,
    input.environment === 'vacuum'
      ? 'Vacuum thermal conditions are not covered by this empirical lookup.'
      : input.environment === 'forced-air'
        ? 'Forced airflow was supplied as context but is not modeled by this lookup.'
        : input.environment === undefined || input.environment === 'unspecified'
          ? 'Ambient conditions were not specified.'
          : 'Still-air assumptions have not been validated against the actual enclosure.',
  ];
  return {
    status: findings.some(({ status }) => status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    method: 'IPC2221_EMPIRICAL_REFERENCE',
    evidence: 'caller_supplied_unverified',
    source:
      'IPC-2221 empirical current-versus-conductor-area equation; see IPC-2152 for thermal design guidance.',
    inputs: input,
    inputUnits: INPUT_UNITS,
    ...(estimate === undefined ? {} : { estimatedMinimumWidthMm: estimate }),
    ...(narrowest === undefined ? {} : { suppliedNarrowestWidthMm: narrowest }),
    findings,
    limitations,
  };
}

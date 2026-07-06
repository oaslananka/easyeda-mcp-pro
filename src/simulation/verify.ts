/** Compare a simulated node voltage against a rail specification. */

import type { RailSpec, RailVerdict } from './types.js';

export function verifyRailAgainstSpec(
  nodeVoltages: Record<string, number>,
  spec: RailSpec,
): RailVerdict {
  const observedVoltage = nodeVoltages[spec.nodeName] ?? Number.NaN;
  const tolerance = (spec.tolerancePercent / 100) * spec.nominalVoltage;
  const minAllowedVoltage = spec.nominalVoltage - Math.abs(tolerance);
  const maxAllowedVoltage = spec.nominalVoltage + Math.abs(tolerance);
  const withinTolerance =
    Number.isFinite(observedVoltage) &&
    observedVoltage >= minAllowedVoltage &&
    observedVoltage <= maxAllowedVoltage;

  return {
    nodeName: spec.nodeName,
    nominalVoltage: spec.nominalVoltage,
    tolerancePercent: spec.tolerancePercent,
    minAllowedVoltage,
    maxAllowedVoltage,
    observedVoltage,
    withinTolerance,
  };
}

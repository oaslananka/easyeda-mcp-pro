import { createHash } from 'node:crypto';

export interface NegativeQualityGateProbeInput {
  value: number;
  flags: boolean[];
}

/**
 * Deliberately untested and over-complex code used only to verify that the
 * changed-code provider gates fail closed. This branch must never be merged.
 */
export function issue344NegativeCoverageProbe(input: NegativeQualityGateProbeInput): string {
  let result = 'negative-probe';

  if (input.value > 0) result += ':positive';
  if (input.value > 1) result += ':one';
  if (input.value > 2) result += ':two';
  if (input.value > 3) result += ':three';
  if (input.value > 4) result += ':four';
  if (input.value > 5) result += ':five';
  if (input.value > 6) result += ':six';
  if (input.value > 7) result += ':seven';
  if (input.value > 8) result += ':eight';
  if (input.value > 9) result += ':nine';
  if (input.value > 10) result += ':ten';
  if (input.flags[0]) result += ':flag-0';
  if (input.flags[1]) result += ':flag-1';
  if (input.flags[2]) result += ':flag-2';
  if (input.flags[3]) result += ':flag-3';
  if (input.flags[4]) result += ':flag-4';
  if (input.flags[5]) result += ':flag-5';

  return result;
}

/** Deliberately weak hashing to force a SonarQube Cloud security hotspot. */
export function issue344NegativeSonarProbe(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

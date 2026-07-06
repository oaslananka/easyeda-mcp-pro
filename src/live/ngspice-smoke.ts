/**
 * Opt-in live ngspice smoke check.
 *
 * Mirrors `src/live/easyeda-smoke.ts`: disabled by default, gated behind an explicit env
 * var, never run as part of the normal `pnpm test` suite (see `scripts/live-ngspice-smoke.mts`).
 * When enabled, this runs the RC-charge golden deck through a *real* ngspice binary and
 * checks the result against the same analytic expectation the mocked golden test in
 * `tests/unit/simulation/golden.test.ts` uses — the one place in this codebase where the
 * `src/simulation/parser.ts` output-format assumptions get validated against real ngspice
 * output, since no ngspice binary is available in this development environment.
 *
 * @module
 */

import { buildSpiceDeck } from '../simulation/netlist.js';
import { detectNgspice, runNgspiceDeck } from '../simulation/runner.js';
import { parseTransientOutput } from '../simulation/parser.js';
import type { SimCircuit } from '../simulation/types.js';

export interface NgspiceLiveConfig {
  enabled: boolean;
  timeoutMs: number;
}

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function parseNgspiceLiveConfig(env: Record<string, string | undefined>): NgspiceLiveConfig {
  return {
    enabled: parseBooleanEnv(env.NGSPICE_LIVE_TESTS),
    timeoutMs: Number(env.NGSPICE_LIVE_TIMEOUT_MS ?? '15000'),
  };
}

export interface NgspiceLiveReport {
  status: 'skipped' | 'unavailable' | 'passed' | 'failed';
  detail: string;
  ngspiceVersion?: string;
  observedVoltage?: number;
  expectedVoltage?: number;
}

const R = 1000;
const C = 1e-6;
const VFINAL = 5;
const RC_CIRCUIT: SimCircuit = {
  title: 'live smoke: RC charge',
  groundNode: '0',
  components: [
    {
      ref: '1',
      kind: 'pulse-voltage-source',
      nodes: ['in', '0'],
      initialVoltage: 0,
      pulsedVoltage: VFINAL,
      delaySeconds: 0,
      riseSeconds: 1e-9,
      fallSeconds: 1e-9,
      pulseWidthSeconds: 1,
      periodSeconds: 2,
    },
    { ref: '1', kind: 'resistor', nodes: ['in', 'out'], value: R },
    { ref: '1', kind: 'capacitor', nodes: ['out', '0'], value: C },
  ],
};
const TARGET_TIME_SECONDS = 1e-3; // 1 RC time constant
const TOLERANCE_VOLTS = 0.05;

export async function runNgspiceLiveSmoke(config: NgspiceLiveConfig): Promise<NgspiceLiveReport> {
  if (!config.enabled) {
    return { status: 'skipped', detail: 'NGSPICE_LIVE_TESTS is not enabled.' };
  }

  const availability = await detectNgspice();
  if (!availability.available) {
    return {
      status: 'unavailable',
      detail: availability.error ?? 'ngspice binary not found.',
    };
  }

  const deck = buildSpiceDeck(RC_CIRCUIT, {
    kind: 'transient',
    stepSeconds: TARGET_TIME_SECONDS / 10,
    stopTimeSeconds: TARGET_TIME_SECONDS * 1.2,
  });

  try {
    const { stdout } = await runNgspiceDeck(deck, { timeoutMs: config.timeoutMs });
    const result = parseTransientOutput(stdout);
    const closest = result.samples.reduce<(typeof result.samples)[number] | undefined>(
      (best, sample) =>
        !best ||
        Math.abs(sample.timeSeconds - TARGET_TIME_SECONDS) <
          Math.abs(best.timeSeconds - TARGET_TIME_SECONDS)
          ? sample
          : best,
      undefined,
    );
    const expectedVoltage = VFINAL * (1 - Math.exp(-TARGET_TIME_SECONDS / (R * C)));
    const observedVoltage = closest?.nodeVoltages.out;

    if (observedVoltage === undefined) {
      return {
        status: 'failed',
        detail: 'Could not parse an "out" node voltage from ngspice output.',
        ngspiceVersion: availability.version,
        expectedVoltage,
      };
    }

    const passed = Math.abs(observedVoltage - expectedVoltage) <= TOLERANCE_VOLTS;
    return {
      status: passed ? 'passed' : 'failed',
      detail: passed
        ? 'Live ngspice RC-charge result matched the analytic expectation.'
        : `Live ngspice result (${observedVoltage}V) diverged from the analytic expectation (${expectedVoltage}V) by more than ${TOLERANCE_VOLTS}V.`,
      ngspiceVersion: availability.version,
      observedVoltage,
      expectedVoltage,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
      ngspiceVersion: availability.version,
    };
  }
}

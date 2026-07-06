/**
 * Golden simulation scenarios, asserted against hand-computed analytic expectations.
 *
 * These tests mock the ngspice runner (no live ngspice is available in this environment)
 * by feeding stdout text in the exact format `src/simulation/parser.ts` targets — see that
 * file's module doc for the format's provenance and the live-validation caveat.
 */
import { describe, expect, it } from 'vitest';
import { buildSpiceDeck } from '../../../src/simulation/netlist.js';
import { parseOperatingPointOutput, parseTransientOutput } from '../../../src/simulation/parser.js';
import { verifyRailAgainstSpec } from '../../../src/simulation/verify.js';
import type { SimCircuit } from '../../../src/simulation/types.js';

function analyticRcCharge(vFinal: number, r: number, c: number, t: number): number {
  return vFinal * (1 - Math.exp(-t / (r * c)));
}

describe('golden simulation: RC divider transient charge', () => {
  const circuit: SimCircuit = {
    title: 'RC charge',
    groundNode: '0',
    components: [
      {
        ref: '1',
        kind: 'pulse-voltage-source',
        nodes: ['in', '0'],
        initialVoltage: 0,
        pulsedVoltage: 5,
        delaySeconds: 0,
        riseSeconds: 1e-9,
        fallSeconds: 1e-9,
        pulseWidthSeconds: 1,
        periodSeconds: 2,
      },
      { ref: '1', kind: 'resistor', nodes: ['in', 'out'], value: 1000 },
      { ref: '1', kind: 'capacitor', nodes: ['out', '0'], value: 1e-6 },
    ],
  };
  const R = 1000;
  const C = 1e-6;
  const VFINAL = 5;

  it('builds a deck matching the circuit', () => {
    const deck = buildSpiceDeck(circuit, {
      kind: 'transient',
      stepSeconds: 1e-5,
      stopTimeSeconds: 5e-3,
    });
    expect(deck).toContain('R1 in out 1000');
    expect(deck).toContain('C1 out 0 0.000001');
    expect(deck).toContain('.tran 0.00001 0.005');
  });

  it('matches the analytic RC charging curve at one and five time constants', () => {
    // Hand-computed: tau = R*C = 1e-3s. V(t) = 5*(1 - e^(-t/tau)).
    // t=1ms (1 tau)  -> 5*(1-e^-1) ~= 3.160603V
    // t=5ms (5 tau)  -> 5*(1-e^-5) ~= 4.966310V
    const oneTau = analyticRcCharge(VFINAL, R, C, 1e-3);
    const fiveTau = analyticRcCharge(VFINAL, R, C, 5e-3);
    expect(oneTau).toBeCloseTo(3.160603, 5);
    expect(fiveTau).toBeCloseTo(4.96631, 5);

    const mockedStdout = [
      'Index   time            v(out)          v(in)',
      `0       0.000000e+00    0.000000e+00    ${VFINAL.toExponential(6)}`,
      `1       1.000000e-03    ${oneTau.toExponential(6)}    ${VFINAL.toExponential(6)}`,
      `2       5.000000e-03    ${fiveTau.toExponential(6)}    ${VFINAL.toExponential(6)}`,
    ].join('\n');

    const result = parseTransientOutput(mockedStdout);
    expect(result.samples).toHaveLength(3);
    expect(result.samples[1]!.nodeVoltages.out).toBeCloseTo(oneTau, 5);
    expect(result.samples[2]!.nodeVoltages.out).toBeCloseTo(fiveTau, 5);
  });
});

describe('golden simulation: simplified LDO rail under load', () => {
  const VIN = 5;
  const TARGET = 3.3;
  const DROPOUT = 0.3;
  const ROUT = 0.1;
  const circuit: SimCircuit = {
    title: 'ldo under load',
    groundNode: '0',
    components: [
      { ref: '1', kind: 'dc-voltage-source', nodes: ['vin', '0'], voltage: VIN },
      {
        ref: '1',
        kind: 'ldo-behavioral',
        nodes: ['vin', 'vout', '0'],
        targetVoltage: TARGET,
        dropoutVoltage: DROPOUT,
        outputResistanceOhms: ROUT,
      },
      { ref: '1', kind: 'dc-current-source', nodes: ['vout', '0'], current: 1 },
    ],
  };

  it('builds a deck matching the LDO model', () => {
    const deck = buildSpiceDeck(circuit, { kind: 'operating-point' });
    expect(deck).toContain('Bideal_1 ideal_1 0 V=min(V(vin)-0.3,3.3)');
    expect(deck).toContain('Rout_1 ideal_1 vout 0.1');
    expect(deck).toContain('I1 vout 0 DC 1');
  });

  it('matches the analytic model under 1A load and passes rail-spec verification', () => {
    // Hand-computed: ideal = min(Vin - dropout, target) = min(5-0.3, 3.3) = min(4.7, 3.3) = 3.3
    // Vout = ideal - I_load * Rout = 3.3 - 1*0.1 = 3.2V
    const idealVoltage = Math.min(VIN - DROPOUT, TARGET);
    const loadCurrentA = 1;
    const expectedVout = idealVoltage - loadCurrentA * ROUT;
    expect(idealVoltage).toBe(3.3);
    expect(expectedVout).toBeCloseTo(3.2, 10);

    const mockedStdout = [
      'v(vin) = 5.000000e+00',
      `v(vout) = ${expectedVout.toExponential(6)}`,
    ].join('\n');
    const result = parseOperatingPointOutput(mockedStdout);
    expect(result.nodeVoltages.vout).toBeCloseTo(3.2, 6);

    const verdict = verifyRailAgainstSpec(result.nodeVoltages, {
      nodeName: 'vout',
      nominalVoltage: 3.3,
      tolerancePercent: 5,
    });
    // 3.2V is ~3% below 3.3V nominal — inside a 5% tolerance band, but this also
    // demonstrates the model's built-in load-regulation droop, not just noise.
    expect(verdict.withinTolerance).toBe(true);
  });

  it('drops out of tolerance once the load current pushes past the tolerance band', () => {
    // With a tighter 1% tolerance, the same 3.2V result must fail — this proves the
    // verifier is actually comparing values, not just returning true unconditionally.
    const idealVoltage = Math.min(VIN - DROPOUT, TARGET);
    const expectedVout = idealVoltage - 1 * ROUT;
    const verdict = verifyRailAgainstSpec(
      { vout: expectedVout },
      { nodeName: 'vout', nominalVoltage: 3.3, tolerancePercent: 1 },
    );
    expect(verdict.withinTolerance).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parseOperatingPointOutput, parseTransientOutput } from '../../../src/simulation/parser.js';

describe('parseOperatingPointOutput', () => {
  it('parses "name = value" lines into a node-voltage map', () => {
    const stdout = ['v(in) = 5.000000e+00', 'v(out) = 3.200000e+00', ''].join('\n');
    const result = parseOperatingPointOutput(stdout);
    expect(result.nodeVoltages).toEqual({ in: 5, out: 3.2 });
  });

  it('ignores unrelated stdout noise', () => {
    const stdout = [
      'Circuit: * test',
      'Doing analysis at TEMP = 27.000000',
      'v(out) = 3.300000e+00',
      'Note: some warning',
    ].join('\n');
    const result = parseOperatingPointOutput(stdout);
    expect(result.nodeVoltages).toEqual({ out: 3.3 });
  });

  it('returns an empty map for unrecognized output rather than throwing', () => {
    expect(() => parseOperatingPointOutput('garbage nonsense output')).not.toThrow();
    expect(parseOperatingPointOutput('garbage nonsense output').nodeVoltages).toEqual({});
  });
});

describe('parseTransientOutput', () => {
  it('parses an Index/time/vector table into samples', () => {
    const stdout = [
      'Index   time            v(out)          v(in)',
      '0       0.000000e+00    0.000000e+00    5.000000e+00',
      '1       1.000000e-03    3.160602e+00    5.000000e+00',
      '2       5.000000e-03    4.966310e+00    5.000000e+00',
    ].join('\n');
    const result = parseTransientOutput(stdout);
    expect(result.samples).toHaveLength(3);
    expect(result.samples[0]).toEqual({ timeSeconds: 0, nodeVoltages: { out: 0, in: 5 } });
    expect(result.samples[1]!.timeSeconds).toBeCloseTo(1e-3, 9);
    expect(result.samples[1]!.nodeVoltages.out).toBeCloseTo(3.160602, 5);
    expect(result.samples[2]!.nodeVoltages.out).toBeCloseTo(4.96631, 5);
  });

  it('returns no samples for output with no recognizable header', () => {
    const result = parseTransientOutput('garbage nonsense output');
    expect(result.samples).toEqual([]);
  });
});

import { bench, describe } from 'vitest';

import { buildSpiceDeck } from '../../src/simulation/netlist.js';
import { parseOperatingPointOutput, parseTransientOutput } from '../../src/simulation/parser.js';
import type { SimCircuit, SimComponent } from '../../src/simulation/types.js';

/** A resistor ladder with `stages` RC sections driven by a DC source. */
function rcLadder(stages: number): SimCircuit {
  const components: SimComponent[] = [
    { ref: '1', kind: 'dc-voltage-source', nodes: ['n0', '0'], voltage: 5 },
  ];
  for (let i = 0; i < stages; i += 1) {
    components.push({
      ref: String(i + 1),
      kind: 'resistor',
      nodes: [`n${i}`, `n${i + 1}`],
      value: 1000,
    });
    components.push({
      ref: String(i + 1),
      kind: 'capacitor',
      nodes: [`n${i + 1}`, '0'],
      value: 1e-6,
    });
  }
  return { title: `rc ladder ${stages}`, groundNode: '0', components };
}

const ladder = rcLadder(200);

const operatingPointStdout = [
  'Circuit: * rc ladder',
  'Doing analysis at TEMP = 27.000000',
  ...Array.from({ length: 200 }, (_, i) => `v(n${i}) = ${(5 - i * 0.01).toExponential(6)}`),
].join('\n');

const transientStdout = [
  'Index   time            v(out)          v(in)',
  ...Array.from({ length: 2000 }, (_, i) => {
    const t = i * 1e-5;
    const out = 5 * (1 - Math.exp(-t / 1e-3));
    return `${i}\t${t.toExponential(6)}\t${out.toExponential(6)}\t${(5).toExponential(6)}`;
  }),
].join('\n');

describe('SPICE simulation helpers', () => {
  bench('buildSpiceDeck - 200-stage RC ladder transient', () => {
    buildSpiceDeck(ladder, { kind: 'transient', stepSeconds: 1e-5, stopTimeSeconds: 1e-2 });
  });

  bench('parseOperatingPointOutput - 200 nodes', () => {
    parseOperatingPointOutput(operatingPointStdout);
  });

  bench('parseTransientOutput - 2000 samples', () => {
    parseTransientOutput(transientStdout);
  });
});

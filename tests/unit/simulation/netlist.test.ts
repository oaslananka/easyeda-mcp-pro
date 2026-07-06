import { describe, expect, it } from 'vitest';
import { buildSpiceDeck, assertSafeIdentifier } from '../../../src/simulation/netlist.js';
import type { SimCircuit } from '../../../src/simulation/types.js';

describe('assertSafeIdentifier', () => {
  it('accepts alphanumeric/underscore identifiers, including purely numeric ones', () => {
    expect(() => assertSafeIdentifier('out', 'node')).not.toThrow();
    expect(() => assertSafeIdentifier('V_out_1', 'node')).not.toThrow();
    expect(() => assertSafeIdentifier('1', 'ref')).not.toThrow();
    expect(() => assertSafeIdentifier('1out', 'node')).not.toThrow();
  });

  it('rejects identifiers that could inject additional SPICE syntax', () => {
    expect(() => assertSafeIdentifier('out\n.control\nshell rm -rf /\n.endc', 'node')).toThrow();
    expect(() => assertSafeIdentifier('out; shell ls', 'node')).toThrow();
    expect(() => assertSafeIdentifier('out(injected)', 'node')).toThrow();
    expect(() => assertSafeIdentifier('', 'node')).toThrow();
  });
});

describe('buildSpiceDeck', () => {
  it('rejects a groundNode other than "0"', () => {
    const circuit: SimCircuit = { title: 't', groundNode: 'gnd', components: [] };
    expect(() => buildSpiceDeck(circuit, { kind: 'operating-point' })).toThrow(/groundNode/);
  });

  it('rejects a component with an unsafe ref or node name', () => {
    const circuit: SimCircuit = {
      title: 't',
      groundNode: '0',
      components: [{ ref: 'r1; shell ls', kind: 'resistor', nodes: ['a', '0'], value: 1000 }],
    };
    expect(() => buildSpiceDeck(circuit, { kind: 'operating-point' })).toThrow();
  });

  it('builds a resistor-divider deck with an .op analysis line', () => {
    const circuit: SimCircuit = {
      title: 'resistor divider',
      groundNode: '0',
      components: [
        { ref: '1', kind: 'dc-voltage-source', nodes: ['in', '0'], voltage: 5 },
        { ref: '1', kind: 'resistor', nodes: ['in', 'out'], value: 1000 },
        { ref: '2', kind: 'resistor', nodes: ['out', '0'], value: 1000 },
      ],
    };
    const deck = buildSpiceDeck(circuit, { kind: 'operating-point' });
    expect(deck).toContain('V1 in 0 DC 5');
    expect(deck).toContain('R1 in out 1000');
    expect(deck).toContain('R2 out 0 1000');
    expect(deck).toContain('.op');
    expect(deck).toContain('print v(in) v(out)');
    expect(deck).not.toContain('shell');
  });

  it('builds a transient deck with a .tran analysis line', () => {
    const circuit: SimCircuit = {
      title: 'rc charge',
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
    const deck = buildSpiceDeck(circuit, {
      kind: 'transient',
      stepSeconds: 1e-5,
      stopTimeSeconds: 5e-3,
    });
    expect(deck).toContain('.tran 0.00001 0.005');
  });

  it('generates a diode .model card exactly once even with multiple diode instances', () => {
    const circuit: SimCircuit = {
      title: 'two diodes',
      groundNode: '0',
      components: [
        { ref: '1', kind: 'diode', nodes: ['a', '0'], modelName: 'generic-silicon-switching' },
        { ref: '2', kind: 'diode', nodes: ['b', '0'], modelName: 'generic-silicon-switching' },
      ],
    };
    const deck = buildSpiceDeck(circuit, { kind: 'operating-point' });
    const modelOccurrences = deck.split('.model').length - 1;
    expect(modelOccurrences).toBe(1);
  });

  it('builds an LDO-behavioral deck with an ideal node and series output resistance', () => {
    const circuit: SimCircuit = {
      title: 'ldo',
      groundNode: '0',
      components: [
        { ref: '1', kind: 'dc-voltage-source', nodes: ['vin', '0'], voltage: 5 },
        {
          ref: '1',
          kind: 'ldo-behavioral',
          nodes: ['vin', 'vout', '0'],
          targetVoltage: 3.3,
          dropoutVoltage: 0.3,
          outputResistanceOhms: 0.1,
        },
        { ref: '1', kind: 'dc-current-source', nodes: ['vout', '0'], current: 1 },
      ],
    };
    const deck = buildSpiceDeck(circuit, { kind: 'operating-point' });
    expect(deck).toContain('Bideal_1 ideal_1 0 V=min(V(vin)-0.3,3.3)');
    expect(deck).toContain('Rout_1 ideal_1 vout 0.1');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerSimulationTools } from '../../../src/tools/L2_simulation.js';
import { EnvSchema } from '../../../src/config/env.js';
import * as runner from '../../../src/simulation/runner.js';

const resistorDivider = {
  title: 'divider',
  groundNode: '0',
  components: [
    { ref: '1', kind: 'dc-voltage-source', nodes: ['in', '0'], voltage: 5 },
    { ref: '1', kind: 'resistor', nodes: ['in', 'out'], value: 1000 },
    { ref: '2', kind: 'resistor', nodes: ['out', '0'], value: 1000 },
  ],
};

describe('Simulation Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerSimulationTools(registry, config);

    context = {
      profile: 'pro',
      bridge: { connected: false, call: vi.fn() },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  describe('easyeda_simulate_operating_point', () => {
    it('reports a capability gap rather than failing when ngspice is unavailable', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: false, error: 'not found' });
      const tool = registry.get('easyeda_simulate_operating_point');
      const result = (await tool?.handler(context, { circuit: resistorDivider })) as any;
      expect(result.available).toBe(false);
      expect(result.not_available).toBe(true);
      expect(result.error).toMatch(/not installed/);
    });

    it('parses node voltages and rail verdicts when ngspice succeeds', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: true, version: '40.0' });
      vi.spyOn(runner, 'runNgspiceDeck').mockResolvedValue({
        stdout: 'v(in) = 5.000000e+00\nv(out) = 2.500000e+00\n',
        stderr: '',
      });
      const tool = registry.get('easyeda_simulate_operating_point');
      const result = (await tool?.handler(context, {
        circuit: resistorDivider,
        railSpecs: [{ nodeName: 'out', nominalVoltage: 2.5, tolerancePercent: 5 }],
      })) as any;
      expect(result.available).toBe(true);
      expect(result.node_voltages).toEqual({ in: 5, out: 2.5 });
      expect(result.rail_verdicts[0].withinTolerance).toBe(true);
    });

    it('surfaces a deck-build error (e.g. unsafe identifier) without crashing', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: true });
      const tool = registry.get('easyeda_simulate_operating_point');
      const badCircuit = {
        title: 't',
        groundNode: '0',
        components: [{ ref: '1;shell ls', kind: 'resistor', nodes: ['a', '0'], value: 1000 }],
      };
      const result = (await tool?.handler(context, { circuit: badCircuit })) as any;
      expect(result.not_available).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe('easyeda_simulate_transient', () => {
    it('reports a capability gap rather than failing when ngspice is unavailable', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: false, error: 'not found' });
      const tool = registry.get('easyeda_simulate_transient');
      const result = (await tool?.handler(context, {
        circuit: resistorDivider,
        stepSeconds: 1e-5,
        stopTimeSeconds: 1e-3,
      })) as any;
      expect(result.available).toBe(false);
      expect(result.not_available).toBe(true);
    });

    it('parses transient samples and evaluates rail verdicts at the final sample', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: true, version: '40.0' });
      vi.spyOn(runner, 'runNgspiceDeck').mockResolvedValue({
        stdout: [
          'Index   time            v(out)',
          '0       0.000000e+00    0.000000e+00',
          '1       1.000000e-03    2.400000e+00',
          '2       5.000000e-03    2.500000e+00',
        ].join('\n'),
        stderr: '',
      });
      const tool = registry.get('easyeda_simulate_transient');
      const result = (await tool?.handler(context, {
        circuit: resistorDivider,
        stepSeconds: 1e-3,
        stopTimeSeconds: 5e-3,
        railSpecs: [{ nodeName: 'out', nominalVoltage: 2.5, tolerancePercent: 5 }],
      })) as any;
      expect(result.samples).toHaveLength(3);
      expect(result.truncated).toBe(false);
      expect(result.rail_verdicts[0].observedVoltage).toBeCloseTo(2.5, 6);
      expect(result.rail_verdicts[0].withinTolerance).toBe(true);
    });

    it('truncates very long sample sets and reports truncated: true', async () => {
      vi.spyOn(runner, 'detectNgspice').mockResolvedValue({ available: true });
      const rows = Array.from({ length: 250 }, (_, i) => `${i}       ${i}e-6    1.0`).join('\n');
      vi.spyOn(runner, 'runNgspiceDeck').mockResolvedValue({
        stdout: `Index   time            v(out)\n${rows}`,
        stderr: '',
      });
      const tool = registry.get('easyeda_simulate_transient');
      const result = (await tool?.handler(context, {
        circuit: resistorDivider,
        stepSeconds: 1e-6,
        stopTimeSeconds: 250e-6,
      })) as any;
      expect(result.truncated).toBe(true);
      expect(result.samples.length).toBeLessThan(250);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildLedBlinkerTemplate,
  calculateLedBlinker,
} from '../../../src/workflows/led-blinker-template.js';

const devices = {
  resistor: { libraryUuid: 'lib-res', uuid: 'dev-res' },
  led: { libraryUuid: 'lib-led', uuid: 'dev-led' },
  switch: { libraryUuid: 'lib-sw', uuid: 'dev-sw' },
};

describe('LED Blinker Template', () => {
  describe('calculateLedBlinker', () => {
    it('correctly calculates current and power constraints', () => {
      const values = {
        supplyVoltage: 5,
        ledForwardVoltage: 2.0,
        ledForwardCurrentMa: 20,
        resistorOhms: 150,
      };

      const result = calculateLedBlinker(values);
      expect(result.currentMa).toBe(20.0);
      expect(result.resistorPowerMw).toBe(60.0); // (5 - 2) * 0.02 * 1000 = 60
      expect(result.ledPowerMw).toBe(40.0); // 2 * 0.02 * 1000 = 40
      expect(result.totalPowerMw).toBe(100.0);
    });
  });

  describe('buildLedBlinkerTemplate', () => {
    it('creates correct workflow input block with expected placements and stubs', () => {
      const plan = buildLedBlinkerTemplate({
        projectId: 'proj-led',
        devices,
        anchor: { x: 100, y: 100 },
      });

      expect(plan.componentCount).toBe(3);
      expect(plan.workflowInput.components).toHaveLength(3);
      expect(plan.workflowInput.wires).toHaveLength(0);

      const comps = plan.workflowInput.components!;
      expect(comps[0].ref).toBe('SW1');
      expect(comps[0].placementOffset).toEqual({ dx: 0, dy: -50 });

      expect(comps[1].ref).toBe('R1');
      expect(comps[1].placementOffset).toEqual({ dx: 130, dy: -50 });

      expect(comps[2].ref).toBe('D1');
      expect(comps[2].placementOffset).toEqual({ dx: 260, dy: -50 });
    });

    it('uses custom refs and values if provided', () => {
      const plan = buildLedBlinkerTemplate({
        projectId: 'proj-led',
        devices,
        refs: {
          switch: 'SW_PWR',
          resistor: 'R_LIMIT',
          led: 'D_INDICATOR',
        },
        values: {
          resistorOhms: 220,
        },
      });

      expect(plan.refs.switch).toBe('SW_PWR');
      expect(plan.refs.resistor).toBe('R_LIMIT');
      expect(plan.refs.led).toBe('D_INDICATOR');
      expect(plan.values.resistorOhms).toBe(220);
    });

    it('respects createWireStubs option', () => {
      const planNoStubs = buildLedBlinkerTemplate({
        projectId: 'proj-led',
        devices,
        createWireStubs: false,
      });
      expect(planNoStubs.workflowInput.wires).toHaveLength(0);

      const planWithStubs = buildLedBlinkerTemplate({
        projectId: 'proj-led',
        devices,
        createWireStubs: true,
      });
      expect(planWithStubs.workflowInput.wires).toHaveLength(6);
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildNe555AstableTemplate,
  calculateNe555Astable,
} from '../../../src/workflows/ne555-astable-template.js';

const deviceItem = { libraryUuid: 'lib-1', uuid: 'dev-1' };
const devices = {
  timer: deviceItem,
  resistor: deviceItem,
  timingCapacitor: deviceItem,
  bypassCapacitor: deviceItem,
  led: deviceItem,
};

describe('NE555 astable template', () => {
  it('calculates the default astable timing near 1 Hz', () => {
    const result = calculateNe555Astable({
      supplyVoltage: 5,
      r1Ohms: 1000,
      r2Ohms: 68000,
      timingCapacitanceUf: 10,
      controlCapacitanceNf: 10,
      decouplingCapacitanceNf: 100,
      ledSeriesOhms: 330,
    });

    expect(result.frequencyHz).toBeCloseTo(1.053, 3);
    expect(result.periodSeconds).toBeCloseTo(0.949, 3);
    expect(result.dutyCyclePercent).toBeCloseTo(50.4, 1);
  });

  it('builds a safe upper-left professional placement plan', () => {
    const result = buildNe555AstableTemplate({ projectId: 'proj-555', devices });

    expect(result.safeRegion.blocked).toBe(false);
    expect(result.safeRegion.preferredRegion).toBe('upper-left');
    expect(result.workflowInput.anchor.y).toBeGreaterThan(700);
    expect(result.workflowInput.components).toHaveLength(8);
    expect(result.workflowInput.netPorts).toHaveLength(6);

    const byRef = new Map(result.workflowInput.components?.map((c) => [c.ref, c]));
    expect(byRef.get('U1')?.placementOffset).toEqual({ dx: 280, dy: -150 });
    expect(byRef.get('R1')?.placementOffset).toEqual({ dx: 120, dy: -70 });
    expect(byRef.get('D1')?.placementOffset).toEqual({ dx: 560, dy: -150 });
  });

  it('wires NE555 pins to the correct astable nets', () => {
    const result = buildNe555AstableTemplate({ projectId: 'proj-555', devices });
    const timer = result.workflowInput.components?.find((c) => c.ref === 'U1');

    expect(timer?.pinConnections).toEqual([
      { pin: '1', netName: 'GND' },
      { pin: '2', netName: 'TIMING' },
      { pin: '3', netName: 'OUT' },
      { pin: '4', netName: '+5V' },
      { pin: '5', netName: 'CTRL' },
      { pin: '6', netName: 'TIMING' },
      { pin: '7', netName: 'DISCH' },
      { pin: '8', netName: '+5V' },
    ]);
  });

  it('supports custom nets, pins, and values without changing topology', () => {
    const result = buildNe555AstableTemplate({
      projectId: 'proj-555',
      devices,
      nets: { vcc: 'VCC_12V', output: 'BLINK_OUT' },
      values: { supplyVoltage: 12, r2Ohms: 100000 },
      pinMaps: { led: { anode: 'A', cathode: 'K' } },
    });

    expect(result.values.supplyVoltage).toBe(12);
    expect(result.values.r2Ohms).toBe(100000);
    expect(result.nets.vcc).toBe('VCC_12V');
    expect(result.workflowInput.netPorts?.some((port) => port.netName === 'BLINK_OUT')).toBe(true);

    const led = result.workflowInput.components?.find((c) => c.ref === 'D1');
    expect(led?.pinConnections).toContainEqual({ pin: 'A', netName: 'LED_A' });
    expect(led?.pinConnections).toContainEqual({ pin: 'K', netName: 'GND' });
  });
});

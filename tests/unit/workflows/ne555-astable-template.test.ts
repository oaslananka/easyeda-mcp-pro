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
    expect(result.workflowInput.netPorts).toHaveLength(0);

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

  it('supports per-reference device items so visual values can differ', () => {
    const r1 = { libraryUuid: 'lib-r', uuid: 'r1-1k' };
    const r2 = { libraryUuid: 'lib-r', uuid: 'r2-68k' };
    const rLed = { libraryUuid: 'lib-r', uuid: 'r3-330r' };
    const cCtrl = { libraryUuid: 'lib-c', uuid: 'c2-10n' };
    const cDecouple = { libraryUuid: 'lib-c', uuid: 'c3-100n' };
    const result = buildNe555AstableTemplate({
      projectId: 'proj-555',
      devices: { ...devices, r1, r2, rLed, cCtrl, cDecouple },
    });
    const byRef = new Map(
      result.workflowInput.components?.map((component) => [component.ref, component]),
    );

    expect(byRef.get('R1')?.deviceItem).toBe(r1);
    expect(byRef.get('R2')?.deviceItem).toBe(r2);
    expect(byRef.get('R3')?.deviceItem).toBe(rLed);
    expect(byRef.get('C2')?.deviceItem).toBe(cCtrl);
    expect(byRef.get('C3')?.deviceItem).toBe(cDecouple);
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
    expect(
      result.workflowInput.components?.some((component) =>
        component.pinConnections.some((connection) => connection.netName === 'BLINK_OUT'),
      ),
    ).toBe(true);

    const led = result.workflowInput.components?.find((c) => c.ref === 'D1');
    expect(led?.pinConnections).toContainEqual({ pin: 'A', netName: 'LED_A' });
    expect(led?.pinConnections).toContainEqual({ pin: 'K', netName: 'GND' });
  });
});

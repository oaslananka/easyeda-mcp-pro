import { describe, expect, it } from 'vitest';
import { buildRp2040ServoModuleScaffold } from '../../../src/workflows/rp2040-servo-module-scaffold.js';

const deviceItem = { libraryUuid: 'lib', uuid: 'dev' };
const devices = {
  resistor0402: deviceItem,
  capacitor0402: deviceItem,
  capacitor0603: deviceItem,
  capacitorPolarized: deviceItem,
  rp2040: deviceItem,
  drv8244: deviceItem,
  w25q16: deviceItem,
  txs0102: deviceItem,
  regulator3v3: deviceItem,
  usbC: deviceItem,
  ws2812b: deviceItem,
  conn01x10: deviceItem,
  conn01x06: deviceItem,
  conn01x03: deviceItem,
  crystal: deviceItem,
  switchSmd: deviceItem,
  fuse: deviceItem,
  diode: deviceItem,
};

describe('RP2040 servo-module scaffold', () => {
  it('builds the expected BOM scaffold without netlist wiring', () => {
    const result = buildRp2040ServoModuleScaffold({
      projectId: 'servo',
      devices,
      sheetInfo: { currentPage: { width: 1682, height: 1189 } },
    });

    expect(result.safeRegion.blocked).toBe(false);
    expect(result.blocks.map((block) => block.id)).toEqual([
      'power_usb',
      'rp2040_core',
      'decoupling',
      'motor_driver',
      'level_shifter',
      'leds',
      'connectors',
    ]);
    expect(result.bom.referenceCount).toBe(56);
    expect(result.workflowInput.components).toHaveLength(56);
    expect(result.workflowInput.netPorts).toEqual([]);
    expect(result.workflowInput.wires).toEqual([]);
    expect(result.warnings.join('\n')).toContain('exact pin-to-net wiring is not inferred');
  });

  it('places major components in deterministic functional blocks', () => {
    const result = buildRp2040ServoModuleScaffold({
      projectId: 'servo',
      devices,
      anchor: { x: 100, y: 900 },
    });
    const byRef = new Map(
      result.workflowInput.components?.map((component) => [component.ref, component]),
    );

    expect(byRef.get('P1')?.placementOffset).toEqual({ dx: 90, dy: -170 });
    expect(byRef.get('U3')?.placementOffset).toEqual({ dx: 720, dy: -220 });
    expect(byRef.get('U4')?.placementOffset).toEqual({ dx: 220, dy: -485 });
    expect(byRef.get('LED4')?.placementOffset).toEqual({ dx: 750, dy: -675 });
    expect(byRef.get('J4')?.placementOffset).toEqual({ dx: 700, dy: -790 });

    expect(result.blocks.find((block) => block.id === 'power_usb')).toMatchObject({
      title: 'power and usb',
      origin: { x: 100, y: 860 },
    });
    expect(result.blocks.find((block) => block.id === 'rp2040_core')?.refs).toContain('U3');
  });

  it('maps representative references to the correct device buckets', () => {
    const unique = (uuid: string) => ({ libraryUuid: 'lib', uuid });
    const result = buildRp2040ServoModuleScaffold({
      projectId: 'servo',
      devices: {
        ...devices,
        resistor0402: unique('res'),
        capacitor0402: unique('cap0402'),
        capacitor0603: unique('cap0603'),
        capacitorPolarized: unique('cap-pol'),
        rp2040: unique('rp2040'),
        usbC: unique('usb-c'),
      },
    });
    const byRef = new Map(
      result.workflowInput.components?.map((component) => [component.ref, component]),
    );

    expect(byRef.get('R10')?.deviceItem.uuid).toBe('res');
    expect(byRef.get('C11')?.deviceItem.uuid).toBe('cap0402');
    expect(byRef.get('C5')?.deviceItem.uuid).toBe('cap0603');
    expect(byRef.get('C7')?.deviceItem.uuid).toBe('cap-pol');
    expect(byRef.get('U3')?.deviceItem.uuid).toBe('rp2040');
    expect(byRef.get('P1')?.deviceItem.uuid).toBe('usb-c');
  });
});

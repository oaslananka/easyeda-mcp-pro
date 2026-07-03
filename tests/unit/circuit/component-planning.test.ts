import { describe, it, expect } from 'vitest';
import {
  determineComponentRole,
  planComponents,
  getDeviceRole,
  ROLE_REFDES_PREFIX,
  ROLE_PACKAGE_HINT,
} from '../../../src/circuit/component-planning.js';
import { BlockType } from '../../../src/circuit/types.js';
import type { Block } from '../../../src/circuit/circuit-ir.js';

function makeBlock(overrides: Partial<Block> & Pick<Block, 'id' | 'name' | 'type'>): Block {
  return {
    description: undefined,
    designIntentRef: [{ requirementId: `req-${overrides.id}` }],
    children: [],
    ...overrides,
  };
}

describe('determineComponentRole', () => {
  it('classifies a power-management block as a power regulator', () => {
    const plan = determineComponentRole({ type: BlockType.PowerManagement });
    expect(plan).toEqual({ role: 'power-regulator', confidence: 'high' });
  });

  it('classifies a microcontroller block as an MCU module', () => {
    const plan = determineComponentRole({ type: BlockType.Microcontroller });
    expect(plan).toEqual({ role: 'mcu-module', confidence: 'high' });
  });

  it('classifies a sensor block', () => {
    const plan = determineComponentRole({ type: BlockType.Sensor });
    expect(plan).toEqual({ role: 'sensor', confidence: 'high' });
  });

  it('classifies a communication block', () => {
    const plan = determineComponentRole({ type: BlockType.Communication });
    expect(plan).toEqual({ role: 'communication-ic', confidence: 'high' });
  });

  it('classifies an analog block', () => {
    const plan = determineComponentRole({ type: BlockType.Analog });
    expect(plan).toEqual({ role: 'analog-ic', confidence: 'high' });
  });

  it('classifies an interface block as a connector', () => {
    const plan = determineComponentRole({ type: BlockType.Interface });
    expect(plan).toEqual({ role: 'connector', confidence: 'high' });
  });

  it('classifies a protection block as a protection diode', () => {
    const plan = determineComponentRole({ type: BlockType.Protection });
    expect(plan).toEqual({ role: 'protection-diode', confidence: 'high' });
  });

  it('falls back to a low-confidence generic role for unclassified types', () => {
    const plan = determineComponentRole({ type: 'custom' });
    expect(plan).toEqual({ role: 'generic-ic', confidence: 'low' });
  });

  it('prioritizes connector keywords over the coarse type field', () => {
    const plan = determineComponentRole({
      type: 'custom',
      description: 'USB-C connector for host interface',
    });
    expect(plan.role).toBe('connector');
    expect(plan.confidence).toBe('high');
  });

  it('detects a fuse from keywords even on a protection-typed block', () => {
    const plan = determineComponentRole({
      type: BlockType.Protection,
      description: 'Resettable polyfuse on the input rail',
    });
    expect(plan.role).toBe('fuse');
  });

  it('detects a passive filter/decoupling block from keywords', () => {
    const plan = determineComponentRole({
      type: BlockType.PowerManagement,
      description: 'Output ripple filtering and decoupling',
    });
    expect(plan).toEqual({ role: 'passive-support', confidence: 'high' });
  });

  it('is case-insensitive when matching keywords', () => {
    const plan = determineComponentRole({ type: 'custom', description: 'USB Header' });
    expect(plan.role).toBe('connector');
  });
});

describe('ROLE_REFDES_PREFIX / ROLE_PACKAGE_HINT', () => {
  it('defines a refdes prefix and package hint for every role', () => {
    for (const role of Object.keys(ROLE_REFDES_PREFIX) as Array<keyof typeof ROLE_REFDES_PREFIX>) {
      expect(ROLE_REFDES_PREFIX[role]).toMatch(/^[A-Z]$/);
      expect(ROLE_PACKAGE_HINT[role]).toBeTruthy();
    }
  });
});

describe('planComponents', () => {
  it('assigns deterministic, sequential refdes numbers per prefix family', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'a', name: 'Regulator A', type: BlockType.PowerManagement }),
      makeBlock({ id: 'b', name: 'Regulator B', type: BlockType.PowerManagement }),
      makeBlock({ id: 'c', name: 'Connector', type: BlockType.Interface }),
    ];

    const { devices } = planComponents(blocks);
    expect(devices.map((d) => d.ref)).toEqual(['U1', 'U2', 'J1']);
  });

  it('is stable across repeated compiles of the same blocks', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'a', name: 'MCU', type: BlockType.Microcontroller }),
      makeBlock({ id: 'b', name: 'Sensor', type: BlockType.Sensor }),
    ];

    const first = planComponents(blocks);
    const second = planComponents(blocks);
    expect(first.devices.map((d) => d.ref)).toEqual(second.devices.map((d) => d.ref));
  });

  it('does not fabricate mpn, manufacturer, or package fields', () => {
    const blocks: Block[] = [makeBlock({ id: 'a', name: 'MCU', type: BlockType.Microcontroller })];
    const { devices } = planComponents(blocks);
    expect(devices[0].mpn).toBeUndefined();
    expect(devices[0].manufacturer).toBeUndefined();
    expect(devices[0].package).toBeUndefined();
  });

  it('marks high-confidence roles as candidate and low-confidence roles as placeholder', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'a', name: 'MCU', type: BlockType.Microcontroller }),
      makeBlock({ id: 'b', name: 'Mystery', type: 'custom' }),
    ];
    const { devices, warnings } = planComponents(blocks);

    const mcuDevice = devices.find((d) => d.blockRef === 'a')!;
    const mysteryDevice = devices.find((d) => d.blockRef === 'b')!;
    expect(mcuDevice.metadata).toContainEqual({ key: 'planningState', value: 'candidate' });
    expect(mysteryDevice.metadata).toContainEqual({ key: 'planningState', value: 'placeholder' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Mystery');
  });

  it('records the role and package hint as device metadata', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'a', name: 'Regulator', type: BlockType.PowerManagement }),
    ];
    const { devices } = planComponents(blocks);
    const device = devices[0];
    expect(getDeviceRole(device)).toBe('power-regulator');
    expect(device.metadata.find((m) => m.key === 'packageHint')?.value).toBe(
      ROLE_PACKAGE_HINT['power-regulator'],
    );
  });
});

describe('getDeviceRole', () => {
  it('returns undefined when the device has no role metadata', () => {
    const device = {
      id: 'dev-1',
      ref: 'U1',
      datasheet: '',
      designIntentRef: [],
      metadata: [],
    } as const;
    expect(getDeviceRole(device)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  detectFunctionalBlocks,
  inferFunctionalBlockKind,
} from '../../../src/layout/block-detector.js';
import type {
  ExplicitFunctionalBlock,
  LayoutComponentInput,
  SchematicLayoutGraph,
} from '../../../src/layout/types.js';

function component(
  overrides: Partial<LayoutComponentInput> & Pick<LayoutComponentInput, 'id' | 'reference'>,
): LayoutComponentInput {
  return { width: 40, height: 20, ...overrides };
}

function emptyGraph(componentIds: readonly string[]): SchematicLayoutGraph {
  const adjacency: Record<string, readonly string[]> = {};
  for (const id of componentIds) adjacency[id] = [];
  return { nodes: [], edges: [], adjacency };
}

describe('inferFunctionalBlockKind', () => {
  it.each([
    ['usb', { deviceName: 'USB-C connector' }],
    ['debug', { deviceName: 'JTAG header' }],
    ['regulation', { deviceName: 'AMS1117 LDO regulator' }],
    ['power-input', { deviceName: 'DC barrel jack power input' }],
    ['mcu', { deviceName: 'STM32 microcontroller' }],
    ['memory', { deviceName: '25Q64 flash eeprom' }],
    ['crystal', { deviceName: '16MHz crystal oscillator' }],
    ['motor-driver', { deviceName: 'DRV8825 stepper driver' }],
    ['led-chain', { deviceName: 'WS2812 addressable LED' }],
    ['sensor', { deviceName: 'BME280 pressure sensor' }],
    ['analog-front-end', { deviceName: 'INA128 instrumentation amplifier' }],
  ] as const)('classifies %s components by description', (kind, extra) => {
    expect(inferFunctionalBlockKind(component({ id: 'U1', reference: 'U1', ...extra }))).toBe(kind);
  });

  it('classifies connectors by reference prefix when text does not match', () => {
    expect(inferFunctionalBlockKind(component({ id: 'J1', reference: 'J1' }))).toBe('connector');
    expect(inferFunctionalBlockKind(component({ id: 'CN1', reference: 'CN1' }))).toBe('connector');
  });

  it('classifies crystals by reference prefix when text does not match', () => {
    expect(inferFunctionalBlockKind(component({ id: 'X1', reference: 'X1' }))).toBe('crystal');
    expect(inferFunctionalBlockKind(component({ id: 'Y1', reference: 'Y1' }))).toBe('crystal');
  });

  it('falls back to led-chain for a bare LED reference/description', () => {
    expect(inferFunctionalBlockKind(component({ id: 'D1', reference: 'D1' }))).toBe('led-chain');
    expect(
      inferFunctionalBlockKind(component({ id: 'D2', reference: 'D2', deviceName: 'red LED' })),
    ).toBe('led-chain');
  });

  it('returns other when nothing matches', () => {
    expect(
      inferFunctionalBlockKind(
        component({ id: 'R1', reference: 'R1', deviceName: '10k resistor' }),
      ),
    ).toBe('other');
  });

  it('searches value, description, category, and tags in addition to deviceName', () => {
    expect(
      inferFunctionalBlockKind(component({ id: 'U1', reference: 'U1', value: 'usb connector' })),
    ).toBe('usb');
    expect(
      inferFunctionalBlockKind(
        component({ id: 'U1', reference: 'U1', description: 'microcontroller' }),
      ),
    ).toBe('mcu');
    expect(
      inferFunctionalBlockKind(
        component({ id: 'U1', reference: 'U1', category: 'buck converter' }),
      ),
    ).toBe('regulation');
    expect(
      inferFunctionalBlockKind(component({ id: 'U1', reference: 'U1', tags: ['h-bridge'] })),
    ).toBe('motor-driver');
  });
});

describe('detectFunctionalBlocks', () => {
  it('keeps explicit blocks and drops unknown/duplicate component ids from them', () => {
    const components = [
      component({ id: 'U1', reference: 'U1' }),
      component({ id: 'R1', reference: 'R1' }),
    ];
    const explicit: ExplicitFunctionalBlock[] = [
      { id: 'explicit-1', kind: 'mcu', componentIds: ['U1', 'U1', 'missing'] },
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1', 'R1']), explicit);
    const explicitBlock = blocks.find((block) => block.id === 'explicit-1');
    expect(explicitBlock).toBeDefined();
    expect(explicitBlock?.componentIds).toEqual(['U1']);
    expect(explicitBlock?.source).toBe('explicit');
  });

  it('drops an explicit block whose component ids are all unknown', () => {
    const components = [component({ id: 'U1', reference: 'U1' })];
    const explicit: ExplicitFunctionalBlock[] = [
      { id: 'explicit-1', kind: 'mcu', componentIds: ['missing'] },
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1']), explicit);
    expect(blocks.some((block) => block.id === 'explicit-1')).toBe(false);
  });

  it('groups components sharing a declared blockId under one inferred block', () => {
    const components = [
      component({ id: 'U1', reference: 'U1', deviceName: 'STM32', blockId: 'mcu-block' }),
      component({ id: 'C1', reference: 'C1', blockId: 'mcu-block' }),
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1', 'C1']));
    const grouped = blocks.find((block) => block.id === 'inferred:mcu-block');
    expect(grouped).toBeDefined();
    expect(grouped?.componentIds).toEqual(['C1', 'U1']);
    expect(grouped?.kind).toBe('mcu');
  });

  it('creates a solo inferred block for a recognizable component with no declared group', () => {
    const components = [
      component({ id: 'U1', reference: 'U1', deviceName: 'STM32 microcontroller' }),
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1']));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('mcu');
    expect(blocks[0]?.source).toBe('inferred');
  });

  it('attaches an unrecognized neighbor to the nearest anchor block via the graph', () => {
    const components = [
      component({ id: 'U1', reference: 'U1', deviceName: 'STM32 microcontroller' }),
      component({ id: 'C1', reference: 'C1', deviceName: '100nF capacitor' }),
    ];
    const graph: SchematicLayoutGraph = {
      nodes: [],
      edges: [],
      adjacency: { U1: ['C1'], C1: ['U1'] },
    };
    const blocks = detectFunctionalBlocks(components, graph);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.componentIds.sort()).toEqual(['C1', 'U1']);
  });

  it('creates its own "other" block for an unrecognized component with no graph neighbor', () => {
    const components = [component({ id: 'C1', reference: 'C1', deviceName: '100nF capacitor' })];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['C1']));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('other');
    expect(blocks[0]?.componentIds).toEqual(['C1']);
  });

  it('tags repeated same-kind/same-part blocks with a shared repeatedGroupId', () => {
    const components = [
      component({ id: 'U1', reference: 'U1', deviceName: 'AMS1117 regulator', value: 'AMS1117' }),
      component({ id: 'U2', reference: 'U2', deviceName: 'AMS1117 regulator', value: 'AMS1117' }),
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1', 'U2']));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.repeatedGroupId).toBeDefined();
    expect(blocks[0]?.repeatedGroupId).toBe(blocks[1]?.repeatedGroupId);
  });

  it('does not assign a repeatedGroupId to a single instance of a kind', () => {
    const components = [
      component({ id: 'U1', reference: 'U1', deviceName: 'STM32 microcontroller' }),
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1']));
    expect(blocks[0]?.repeatedGroupId).toBeUndefined();
  });

  it('returns blocks sorted by id', () => {
    const components = [
      component({ id: 'U2', reference: 'U2', deviceName: 'STM32 microcontroller' }),
      component({ id: 'U1', reference: 'U1', deviceName: 'ESP32 microcontroller' }),
    ];
    const blocks = detectFunctionalBlocks(components, emptyGraph(['U1', 'U2']));
    const ids = blocks.map((block) => block.id);
    expect(ids).toEqual([...ids].sort());
  });
});

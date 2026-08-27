import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRuntimeInventorySnapshot,
  createRuntimeInventorySnapshot,
  diffRuntimeInventorySnapshots,
  parseRuntimeInventoryCaptureConfig,
  readRuntimeInventorySnapshot,
  writeRuntimeInventorySnapshot,
  type RuntimeInventoryCaptureConfig,
} from '../../../src/easyeda-runtime/inventory.js';

function captureConfig(
  overrides: Partial<RuntimeInventoryCaptureConfig> = {},
): RuntimeInventoryCaptureConfig {
  return {
    enabled: true,
    outputPath: '.easyeda-mcp-pro/runtime-inventory/latest.json',
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('runtime inventory snapshots', () => {
  it('should parse disabled capture config by default', () => {
    const config = parseRuntimeInventoryCaptureConfig({});
    expect(config.enabled).toBe(false);
    expect(config.outputPath).toBe('.easyeda-mcp-pro/runtime-inventory/latest.json');
  });

  it('should normalize class methods and runtime paths deterministically', () => {
    const snapshot = createRuntimeInventorySnapshot({
      generatedAt: '2026-01-01T00:00:00.000Z',
      classes: [
        {
          className: ' SCH_PrimitiveWire ',
          runtimePaths: ['eda.SCH_PrimitiveWire', 'eda.SCH_PrimitiveWire'],
          methods: ['getAll', ' add ', 'getAll'],
        },
        { className: 'SCH_Document', runtimePaths: ['eda.SCH_Document'], methods: ['save'] },
      ],
    });

    expect(snapshot.total).toBe(2);
    expect(snapshot.classes.map((entry) => entry.className)).toEqual([
      'SCH_Document',
      'SCH_PrimitiveWire',
    ]);
    expect(snapshot.classes[1]?.methods).toEqual(['add', 'getAll']);
  });

  it('sorts normalized runtime identifiers alphabetically with an explicit locale', () => {
    const snapshot = createRuntimeInventorySnapshot({
      generatedAt: '2026-01-01T00:00:00.000Z',
      classes: [
        {
          className: 'SCH_Document',
          runtimePaths: ['eda.zeta', 'eda.äther', 'eda.Alpha'],
          methods: ['zeta', 'äther', 'Alpha'],
        },
      ],
    });

    expect(snapshot.classes[0]!.runtimePaths).toEqual(['eda.Alpha', 'eda.äther', 'eda.zeta']);
    expect(snapshot.classes[0]!.methods).toEqual(['Alpha', 'äther', 'zeta']);
  });

  it('should capture runtime inventory through the bridge when enabled', async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      call: vi.fn(async () => ({
        total: 1,
        classes: [
          { className: 'SCH_Document', runtimePaths: ['eda.SCH_Document'], methods: ['save'] },
        ],
      })),
      hello: {
        type: 'hello' as const,
        bridgeVersion: '0.5.3',
        contractVersion: 1 as const,
        supportedProtocolVersions: ['1.0.0' as const],
        easyedaVersion: '2026.1',
        capabilities: [],
        methodRegistryHash: 'hash123',
        devMode: false,
      },
      methodRegistryHash: 'hash123',
    };

    const snapshot = await captureRuntimeInventorySnapshot(
      bridge,
      captureConfig({ filter: 'sch' }),
    );

    expect(snapshot?.total).toBe(1);
    expect(snapshot?.filter).toBe('sch');
    expect(snapshot?.easyedaVersion).toBe('2026.1');
    expect(bridge.call).toHaveBeenCalledWith(
      'system.apiInventory',
      { filter: 'sch' },
      { timeoutMs: 30_000 },
    );
    expect(bridge.disconnect).toHaveBeenCalledWith('runtime inventory capture complete');
  });

  it('should skip capture when disabled', async () => {
    const bridge = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      call: vi.fn(),
      hello: null,
      methodRegistryHash: 'hash123',
    };

    await expect(
      captureRuntimeInventorySnapshot(bridge, captureConfig({ enabled: false })),
    ).resolves.toBeNull();
    expect(bridge.connect).not.toHaveBeenCalled();
  });

  it('should diff added removed and changed classes', () => {
    const base = createRuntimeInventorySnapshot({
      generatedAt: '2026-01-01T00:00:00.000Z',
      classes: [
        { className: 'SCH_Document', runtimePaths: ['eda.SCH_Document'], methods: ['save'] },
        { className: 'PCB_Document', runtimePaths: ['eda.PCB_Document'], methods: ['route'] },
      ],
    });
    const current = createRuntimeInventorySnapshot({
      generatedAt: '2026-01-02T00:00:00.000Z',
      classes: [
        {
          className: 'SCH_Document',
          runtimePaths: ['eda.SCH_Document', 'EDA.SCH_Document'],
          methods: ['save', 'export'],
        },
        { className: 'BOM_Table', runtimePaths: ['eda.BOM_Table'], methods: ['generate'] },
      ],
    });

    const diff = diffRuntimeInventorySnapshots(base, current);

    expect(diff.status).toBe('changed');
    expect(diff.addedClasses.map((entry) => entry.className)).toEqual(['BOM_Table']);
    expect(diff.removedClasses.map((entry) => entry.className)).toEqual(['PCB_Document']);
    expect(diff.changedClasses[0]).toMatchObject({
      className: 'SCH_Document',
      addedMethods: ['export'],
      removedMethods: [],
      addedRuntimePaths: ['EDA.SCH_Document'],
    });
  });

  it('should read and write snapshot files', async () => {
    const dir = await mkdir(join(tmpdir(), `easyeda-inventory-${Date.now()}`), { recursive: true });
    const path = join(dir ?? tmpdir(), 'snapshot.json');
    const snapshot = createRuntimeInventorySnapshot({
      generatedAt: '2026-01-01T00:00:00.000Z',
      classes: [{ className: 'SCH_Document', runtimePaths: [], methods: [] }],
    });

    await writeRuntimeInventorySnapshot(path, snapshot);
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw, 'utf8');

    await expect(readRuntimeInventorySnapshot(path)).resolves.toMatchObject({ total: 1 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createSystemApiOperations } from '../src/system-api-operations.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function createToolkit(overrides: Partial<DispatcherToolkit> = {}): DispatcherToolkit {
  return {
    getEda: () => ({ answer: 42, DMT_Schematic: {}, sch_PrimitiveComponent: {} }),
    getEDA: () => null,
    getApi: () => ({ runtime: true }),
    getGlobal: () => null,
    log: vi.fn(),
    showToast: vi.fn(),
    getBridgeMaxPayloadSize: () => 1024,
    getBridgeVersion: () => 'test-bridge',
    ...overrides,
  };
}

function createDependencies(overrides: Record<string, unknown> = {}) {
  return {
    toolkit: createToolkit(),
    methodList: ['api.call', 'system.getStatus'],
    buildId: 'build-test',
    inspectApiInventory: vi.fn(async (filter?: string) => ({ filter })),
    callAllowedApi: vi.fn(async (path: string, args: unknown[]) => ({ path, args })),
    readFirstPath: vi.fn(() => undefined),
    summarizeWirePrimitive: vi.fn((wire: unknown) => ({ wire })),
    createBridgeError: vi.fn((code: string, message: string, suggestion: string) => {
      const error = new Error(message);
      Object.assign(error, { code, suggestion });
      return error;
    }),
    logRecoverableError: vi.fn(),
    ...overrides,
  };
}

describe('system API operations', () => {
  it('forwards allowlisted API calls without changing path or args', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await expect(
      operations.apiCall({ path: 'SCH_PrimitiveWire.getAll', args: ['a', 2] }),
    ).resolves.toEqual({ path: 'SCH_PrimitiveWire.getAll', args: ['a', 2] });
    expect(dependencies.callAllowedApi).toHaveBeenCalledWith('SCH_PrimitiveWire.getAll', ['a', 2]);
  });

  it('preserves api.execute validation, eda injection, and normalized result shape', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.apiExecute({ code: '   ' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'code is required',
    });
    await expect(
      operations.apiExecute({ code: 'return { answer: eda.answer, nested: [1, 2] };' }),
    ).resolves.toEqual({ result: { answer: 42, nested: [1, 2] } });
  });

  it('forwards the optional inventory filter', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.apiInventory({ filter: 'SCH_' })).resolves.toEqual({ filter: 'SCH_' });
    expect(dependencies.inspectApiInventory).toHaveBeenCalledWith('SCH_');
  });

  it('inspects schematic components with the existing bounded sample behavior', async () => {
    const getAll = vi.fn(async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const dependencies = createDependencies({
      readFirstPath: vi.fn(() => ({ getAll })),
    });
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.inspectComponents({ limit: 2 })).resolves.toEqual({
      total: 3,
      samples: [{ id: 'a' }, { id: 'b' }],
    });
    expect(getAll).toHaveBeenCalledWith(undefined, true);
  });

  it('inspects wires with offset/limit coercion and the injected summarizer', async () => {
    const getAll = vi.fn(async () => ['wire-a', 'wire-b', 'wire-c']);
    const summarizeWirePrimitive = vi.fn((wire: unknown) => ({ summarized: wire }));
    const dependencies = createDependencies({
      readFirstPath: vi.fn(() => ({ getAll })),
      summarizeWirePrimitive,
    });
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.inspectWires({ offset: 1, limit: 1 })).resolves.toEqual({
      total: 3,
      samples: [{ summarized: 'wire-b' }],
    });
    expect(summarizeWirePrimitive).toHaveBeenCalledTimes(1);
  });

  it('reports status with the full dispatcher capability list and build id', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.getStatus()).resolves.toMatchObject({
      bridgeVersion: 'test-bridge',
      capabilities: ['api.call', 'system.getStatus'],
      devMode: false,
      hasEda: true,
      hasDMT: true,
      dispatcherBuildId: 'build-test',
      globals: {
        typeof_local_api: 'object',
        typeof_local_eda: 'object',
      },
    });
  });
});

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

describe('system API operation fallbacks', () => {
  it('uses empty defaults for malformed api.call and api inventory inputs', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.apiCall({ path: 123, args: 'not-an-array' })).resolves.toEqual({
      path: '',
      args: [],
    });
    expect(dependencies.callAllowedApi).toHaveBeenCalledWith('', []);

    await expect(operations.apiInventory({ filter: 123 })).resolves.toEqual({
      filter: undefined,
    });
    expect(dependencies.inspectApiInventory).toHaveBeenCalledWith(undefined);
  });

  it('rejects non-string execute code and falls back to global eda when toolkit eda is absent', async () => {
    const previousEda = (globalThis as { eda?: unknown }).eda;
    const dependencies = createDependencies({
      toolkit: createToolkit({ getEda: () => null }),
    });
    const operations = createSystemApiOperations(dependencies);

    try {
      await expect(operations.apiExecute({ code: 123 })).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
      (globalThis as { eda?: unknown }).eda = { answer: 17 };
      await expect(operations.apiExecute({ code: 'return eda.answer;' })).resolves.toEqual({
        result: 17,
      });
    } finally {
      if (previousEda === undefined) delete (globalThis as { eda?: unknown }).eda;
      else (globalThis as { eda?: unknown }).eda = previousEda;
    }
  });

  it('reports an EDA-only runtime as available and detects DMT there', async () => {
    const dependencies = createDependencies({
      toolkit: createToolkit({
        getEda: () => null,
        getEDA: () => ({ DMT_Schematic: {}, other: true }),
        getApi: () => null,
      }),
    });
    const operations = createSystemApiOperations(dependencies);

    await expect(operations.getStatus()).resolves.toMatchObject({
      hasEda: true,
      hasDMT: true,
      globals: {
        typeof_local_api: 'object',
        typeof_local_eda: 'object',
        typeof_local_EDA: 'object',
        EDA_keys: expect.arrayContaining(['DMT_Schematic', 'other']),
        EDA_for_in_keys: expect.arrayContaining(['DMT_Schematic', 'other']),
      },
    });
  });

  it('keeps debug status resilient when EDA objects reject key and class inspection', async () => {
    const runtimeClass = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('runtime ownKeys blocked');
        },
        getPrototypeOf() {
          throw new Error('runtime prototype blocked');
        },
      },
    );
    const eda = new Proxy(
      { sch_PrimitiveComponent: runtimeClass },
      {
        ownKeys() {
          throw new Error('eda ownKeys blocked');
        },
        get(target, property, receiver) {
          if (property === 'sch_Document') throw new Error('runtime property blocked');
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const dependencies = createDependencies({
      toolkit: createToolkit({ getEda: () => eda }),
    });
    const operations = createSystemApiOperations(dependencies);

    const status = (await operations.getStatus()) as { globals: Record<string, unknown> };
    expect(status.globals.eda_keys_err).toContain('eda ownKeys blocked');
    expect(status.globals.eda_for_in_keys_err).toContain('eda ownKeys blocked');
    expect(status.globals.sch_Document_err).toContain('runtime property blocked');
    expect(dependencies.logRecoverableError).toHaveBeenCalledWith(
      'failed to read debug probe property names',
      expect.any(Error),
    );
    expect(dependencies.logRecoverableError).toHaveBeenCalledWith(
      'failed to read debug probe prototype',
      expect.any(Error),
    );
  });

  it('filters built-in runtime class property names from debug status', async () => {
    function RuntimeClass() {}
    Object.assign(RuntimeClass, { customDiagnosticMember: true });
    const dependencies = createDependencies({
      toolkit: createToolkit({
        getEda: () => ({ sch_PrimitiveComponent: RuntimeClass }),
      }),
    });
    const operations = createSystemApiOperations(dependencies);

    const status = (await operations.getStatus()) as { globals: Record<string, unknown> };
    expect(status.globals.sch_PrimitiveComponent_all_keys).toContain('customDiagnosticMember');
    expect(status.globals.sch_PrimitiveComponent_all_keys).not.toContain('length');
    expect(status.globals.sch_PrimitiveComponent_all_keys).not.toContain('name');
    expect(status.globals.sch_PrimitiveComponent_all_keys).not.toContain('prototype');
  });

  it('records global diagnostic key lookup failures without failing status', async () => {
    const original = Object.getOwnPropertyNames;
    const spy = vi.spyOn(Object, 'getOwnPropertyNames').mockImplementation((value: object) => {
      if (value === globalThis) throw new Error('global key lookup blocked');
      return original(value);
    });
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    try {
      const status = (await operations.getStatus()) as { globals: Record<string, unknown> };
      expect(status.globals.globalThis_keys_err).toContain('global key lookup blocked');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails component inspection for missing APIs and handles non-array native results', async () => {
    const missingDependencies = createDependencies({ readFirstPath: vi.fn(() => undefined) });
    await expect(
      createSystemApiOperations(missingDependencies).inspectComponents({}),
    ).rejects.toThrow('SCH_PrimitiveComponent.getAll is not available');

    const malformedDependencies = createDependencies({ readFirstPath: vi.fn(() => ({})) });
    await expect(
      createSystemApiOperations(malformedDependencies).inspectComponents({}),
    ).rejects.toThrow('SCH_PrimitiveComponent.getAll is not available');

    const getAll = vi.fn(async () => ({ not: 'an array' }));
    const nonArrayDependencies = createDependencies({ readFirstPath: vi.fn(() => ({ getAll })) });
    await expect(
      createSystemApiOperations(nonArrayDependencies).inspectComponents({ limit: 'bad' }),
    ).resolves.toEqual({ total: 0, samples: [] });
  });

  it('fails wire inspection for missing APIs and handles non-array native results/defaults', async () => {
    const missingDependencies = createDependencies({ readFirstPath: vi.fn(() => undefined) });
    await expect(createSystemApiOperations(missingDependencies).inspectWires({})).rejects.toThrow(
      'SCH_PrimitiveWire.getAll is not available',
    );

    const malformedDependencies = createDependencies({ readFirstPath: vi.fn(() => ({})) });
    await expect(createSystemApiOperations(malformedDependencies).inspectWires({})).rejects.toThrow(
      'SCH_PrimitiveWire.getAll is not available',
    );

    const getAll = vi.fn(async () => ({ not: 'an array' }));
    const nonArrayDependencies = createDependencies({ readFirstPath: vi.fn(() => ({ getAll })) });
    await expect(
      createSystemApiOperations(nonArrayDependencies).inspectWires({ limit: 'bad', offset: 'bad' }),
    ).resolves.toEqual({ total: 0, samples: [] });
  });
});

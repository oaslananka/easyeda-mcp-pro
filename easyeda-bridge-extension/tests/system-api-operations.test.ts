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
    callReadOnlyApi: vi.fn(async (path: string, args: unknown[]) => ({ path, args })),
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
    expect(dependencies.callAllowedApi).toHaveBeenCalledWith(
      'SCH_PrimitiveWire.getAll',
      ['a', 2],
      undefined,
      false,
    );
  });

  it('forwards an optional result depth', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);

    await operations.apiCall({ path: 'PCB_Drc.check', args: [true, false, true], maxDepth: 10 });
    expect(dependencies.callAllowedApi).toHaveBeenCalledWith(
      'PCB_Drc.check',
      [true, false, true],
      10,
      false,
    );
  });

  it('keeps the read operation separate and forwards the compact default', async () => {
    const dependencies = createDependencies();
    const operations = createSystemApiOperations(dependencies);
    await expect(
      operations.apiRead({ path: 'PCB_PrimitiveVia.getAll', args: [], maxDepth: 8 }),
    ).resolves.toMatchObject({ path: 'PCB_PrimitiveVia.getAll', args: [] });
    expect(dependencies.callReadOnlyApi).toHaveBeenCalledWith(
      'PCB_PrimitiveVia.getAll',
      [],
      8,
      false,
    );
    expect(dependencies.callAllowedApi).not.toHaveBeenCalled();
    await expect(
      operations.apiRead({
        path: 123,
        args: 'unexpected',
        includeMethods: true,
      }),
    ).resolves.toEqual({ path: '', args: [] });
    expect(dependencies.callReadOnlyApi).toHaveBeenLastCalledWith('', [], undefined, true);
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

  it('exposes a live loader-reported editor version in status without trusting static build metadata', async () => {
    const getEasyedaVersion = vi.fn(() => '3.2.209');
    const toolkit = createToolkit({ getEasyedaVersion });
    const operations = createSystemApiOperations(createDependencies({ toolkit }));
    await expect(operations.getStatus()).resolves.toMatchObject({
      easyedaVersion: '3.2.209',
      bridgeVersion: 'test-bridge',
    });
    expect(getEasyedaVersion).toHaveBeenCalledOnce();
  });

  it('reports native-zone storage capability read-only, but never claims public apply is ready', async () => {
    const getExtensionUserConfig = vi.fn(() => undefined);
    const setExtensionUserConfig = vi.fn(async () => true);
    const readFirstPath = vi.fn(() => ({ getExtensionUserConfig, setExtensionUserConfig }));
    const operations = createSystemApiOperations(createDependencies({ readFirstPath }));
    await expect(operations.getStatus()).resolves.toMatchObject({
      nativeZoneSafety: {
        storage: 'readable',
        pendingFence: 'absent',
        coordinator: 'unavailable',
        publicApplyEnabled: false,
      },
    });
    expect(getExtensionUserConfig).toHaveBeenCalledOnce();
    expect(setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('does not treat invalid native storage marker values as safely absent', async () => {
    const readFirstPath = vi.fn(() => ({
      getExtensionUserConfig: vi.fn(() => ({ bad: 'nonstring-marker' })),
      setExtensionUserConfig: vi.fn(async () => true),
    }));
    const status = await createSystemApiOperations(
      createDependencies({ readFirstPath }),
    ).getStatus();
    expect(status).toMatchObject({
      nativeZoneSafety: {
        storage: 'readable',
        pendingFence: 'present',
        coordinator: 'unavailable',
        publicApplyEnabled: false,
      },
    });
    expect(JSON.stringify(status)).not.toContain('nonstring-marker');
  });

  it('reports a present pending native-zone fence without disclosing its contents', async () => {
    const marker = 'secret-do-not-return-' + 'x'.repeat(40);
    const readFirstPath = vi.fn(() => ({
      getExtensionUserConfig: vi.fn(() => marker),
      setExtensionUserConfig: vi.fn(async () => true),
    }));
    const status = await createSystemApiOperations(
      createDependencies({ readFirstPath }),
    ).getStatus();
    expect(status).toMatchObject({
      nativeZoneSafety: {
        storage: 'readable',
        pendingFence: 'present',
        publicApplyEnabled: false,
      },
    });
    expect(JSON.stringify(status)).not.toContain(marker);
  });

  it('reports an inaccessible extension storage API without throwing or claiming an absent fence', async () => {
    const readFirstPath = vi.fn(() => ({
      getExtensionUserConfig: () => {
        throw new TypeError('extension-only');
      },
      setExtensionUserConfig: vi.fn(async () => true),
    }));
    await expect(
      createSystemApiOperations(createDependencies({ readFirstPath })).getStatus(),
    ).resolves.toMatchObject({
      nativeZoneSafety: {
        storage: 'unavailable',
        pendingFence: 'unknown',
        coordinator: 'unavailable',
        publicApplyEnabled: false,
      },
    });
  });

  it('denies confidence when the storage provider returns a Promise or lacks its setter', async () => {
    const wrongGet = createDependencies({
      readFirstPath: vi.fn(() => ({
        getExtensionUserConfig: async () => undefined,
        setExtensionUserConfig: async () => true,
      })),
    });
    const missingSetter = createDependencies({
      readFirstPath: vi.fn(() => ({ getExtensionUserConfig: () => undefined })),
    });
    for (const deps of [wrongGet, missingSetter]) {
      await expect(createSystemApiOperations(deps).getStatus()).resolves.toMatchObject({
        nativeZoneSafety: {
          pendingFence: 'unknown',
          storage: 'unavailable',
          publicApplyEnabled: false,
        },
      });
    }
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
    expect(dependencies.callAllowedApi).toHaveBeenCalledWith('', [], undefined, false);

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

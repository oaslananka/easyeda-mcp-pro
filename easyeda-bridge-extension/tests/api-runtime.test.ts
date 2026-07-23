import { describe, expect, it, vi } from 'vitest';
import { createApiRuntime, type BridgeErrorFactory } from '../src/api-runtime.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function mutableRoots() {
  let eda: unknown;
  let EDA: unknown;
  let api: unknown;
  const toolkit: Pick<DispatcherToolkit, 'getEda' | 'getEDA' | 'getApi'> = {
    getEda: () => eda,
    getEDA: () => EDA,
    getApi: () => api,
  };
  return {
    toolkit,
    setEda: (value: unknown) => {
      eda = value;
    },
    setEDA: (value: unknown) => {
      EDA = value;
    },
    setApi: (value: unknown) => {
      api = value;
    },
  };
}

describe('EasyEDA API runtime', () => {
  it('re-reads roots, preserves precedence, class variants, and method receivers', async () => {
    const roots = mutableRoots();
    const globalRoot = {
      SCH_Service: {
        source: 'global',
        identify() {
          return this.source;
        },
      },
    };
    const runtime = createApiRuntime(roots.toolkit, bridgeError, globalRoot);

    await expect(runtime.callFirst(['sch_Service.identify'])).resolves.toBe('global');

    roots.setApi({ SCH_Service: { identify: () => 'api' } });
    roots.setEDA({ SCH_Service: { identify: () => 'EDA' } });
    roots.setEda({ SCH_Service: { identify: () => 'eda' } });

    await expect(runtime.callFirst(['SCH_Service.identify'])).resolves.toBe('eda');
  });

  it('reads the first defined class value and keeps null as a resolved value', () => {
    const roots = mutableRoots();
    roots.setEda({ SCH_Missing: undefined, SCH_Nullable: null });
    roots.setEDA({ SCH_Missing: { source: 'EDA' }, SCH_Nullable: { source: 'EDA' } });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    expect(runtime.readFirstPath<{ source: string }>(['SCH_Missing'])).toEqual({ source: 'EDA' });
    expect(runtime.readFirstPath(['SCH_Nullable'])).toBeNull();
    expect(runtime.readFirstPath(['SCH_Absent'])).toBeUndefined();
  });

  it('ignores unavailable and non-record runtime roots in inventory', () => {
    const roots = mutableRoots();
    roots.setEda('not-an-object');
    roots.setEDA(0);
    roots.setApi(false);
    const runtime = createApiRuntime(roots.toolkit, bridgeError, null);

    expect(runtime.inspectApiInventory()).toEqual({ classes: [], total: 0 });
  });

  it('builds a normalized, filtered, deduplicated API inventory', () => {
    const roots = mutableRoots();
    roots.setEda({
      sch_PrimitiveWire: {
        create() {},
        getAll() {},
      },
      SYS_Shell: { exec() {} },
    });
    roots.setEDA({
      SCH_PrimitiveWire: {
        get() {},
        getAll() {},
      },
      PCB_PrimitiveVia: { getAll() {} },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    expect(runtime.inspectApiInventory(' primitivewire ')).toEqual({
      classes: [
        {
          className: 'SCH_PrimitiveWire',
          runtimePaths: ['eda.sch_PrimitiveWire', 'EDA.SCH_PrimitiveWire'],
          methods: ['create', 'get', 'getAll'],
        },
      ],
      total: 1,
    });
    expect(runtime.inspectApiInventory()).toMatchObject({ total: 2 });
  });

  it('authorizes API calls, binds the receiver, and normalizes the result', async () => {
    const roots = mutableRoots();
    roots.setEda({
      SCH_Service: {
        value: 7,
        read(extra: number) {
          return { total: this.value + extra, getState_Name: () => 'service' };
        },
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(runtime.callAllowedApi('sch_Service.read', [5])).resolves.toEqual({
      path: 'sch_Service.read',
      resolvedPath: 'eda.SCH_Service.read',
      result: expect.objectContaining({
        total: 12,
        state: { Name: 'service' },
        __methods: ['getState_Name'],
      }),
    });
  });

  it('returns bounded bridge errors for denied and missing methods', async () => {
    const roots = mutableRoots();
    const errorFactory = vi.fn<BridgeErrorFactory>(bridgeError);
    const runtime = createApiRuntime(roots.toolkit, errorFactory, {});

    await expect(runtime.callAllowedApi('SYS_Shell.exec', [])).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'API path is not allowed: SYS_Shell.exec',
    });
    await expect(runtime.callAllowedApi('SCH_Service.missing', [])).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
      message: 'No EasyEDA API implementation found for SCH_Service.missing',
    });
    await expect(
      runtime.callFirst(['SCH_Service.first', 'SCH_Service.second']),
    ).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
      message: 'No EasyEDA API implementation found for SCH_Service.first or SCH_Service.second',
    });
    expect(errorFactory).toHaveBeenCalledTimes(3);
  });
});

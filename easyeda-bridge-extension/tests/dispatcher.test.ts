import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatcher.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function makeToolkit(edaGlobal: Record<string, unknown>): DispatcherToolkit {
  return {
    getEda: () => edaGlobal,
    getEDA: () => undefined,
    getApi: () => undefined,
    getGlobal: () => edaGlobal,
    log: () => {},
    showToast: () => {},
    getBridgeMaxPayloadSize: () => 1_048_576,
    getBridgeVersion: () => '1.0.0',
  };
}

/** Minimal wire primitive exposing the getState_* getters the dispatcher reads. */
function fakeWire(id: string, net: string, line: number[]): Record<string, unknown> {
  return {
    getState_PrimitiveType: () => 'Wire',
    getState_PrimitiveId: () => id,
    getState_Line: () => line,
    getState_Net: () => net,
    getState_Color: () => '#000000',
    getState_LineWidth: () => 1,
    getState_LineType: () => 0,
  };
}

describe('createDispatcher', () => {
  it('returns a dispatcher with a sorted, non-empty method list and a build id', () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    expect(dispatcher.methodList.length).toBeGreaterThan(40);
    expect(dispatcher.methodList).toEqual([...dispatcher.methodList].sort());
    expect(dispatcher.buildId).toBeTruthy();
    expect(dispatcher.methodList).toContain('schematic.addWire');
    expect(dispatcher.methodList).toContain('system.inspectWires');
  });

  it('rejects unknown methods with METHOD_NOT_ALLOWED', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(dispatcher.dispatch('nope.nothing')).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
    });
  });

  it('resolves EasyEDA classes through the toolkit, not bare globals', async () => {
    const getAll = vi.fn(async () => [fakeWire('w1', 'NET_A', [0, 0, 10, 0])]);
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveWire: { getAll } }));
    const result = (await dispatcher.dispatch('system.inspectWires', {})) as {
      total: number;
      samples: Array<Record<string, unknown>>;
    };
    expect(getAll).toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.samples[0].net).toBe('NET_A');
  });

  it('refuses addWire when a point collides with a wire on a different net', async () => {
    const create = vi.fn();
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: {
          getAll: async () => [fakeWire('w1', 'NET_B', [10, 20, 30, 20])],
          create,
        },
      }),
    );
    await expect(
      dispatcher.dispatch('schematic.addWire', {
        netName: 'NET_A',
        points: [
          { x: 10, y: 20 },
          { x: 10, y: 40 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NET_COLLISION' });
    expect(create).not.toHaveBeenCalled();
  });

  it('allows addWire on the same net and flattens points for create()', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'w2' }));
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: {
          getAll: async () => [fakeWire('w1', 'NET_A', [10, 20, 30, 20])],
          create,
        },
      }),
    );
    await dispatcher.dispatch('schematic.addWire', {
      netName: 'NET_A',
      points: [
        { x: 10, y: 20 },
        { x: 10, y: 40 },
      ],
    });
    expect(create).toHaveBeenCalledWith([10, 20, 10, 40], 'NET_A', undefined, undefined, undefined);
  });

  it('rejects api.call paths outside the allowed class prefixes', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(
      dispatcher.dispatch('api.call', { path: 'SYS_Shell.exec', args: [] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('api.call resolves an allowed class method and normalizes the result', async () => {
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: { getAll: async () => [] },
      }),
    );
    const result = (await dispatcher.dispatch('api.call', {
      path: 'SCH_PrimitiveWire.getAll',
      args: [],
    })) as { resolvedPath: string };
    expect(result.resolvedPath).toBe('eda.SCH_PrimitiveWire.getAll');
  });

  it('system.getStatus reports capabilities equal to methodList and the build id', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    const status = (await dispatcher.dispatch('system.getStatus', {})) as {
      capabilities: string[];
      bridgeVersion: string;
      dispatcherBuildId: string;
    };
    expect(status.capabilities).toEqual(dispatcher.methodList);
    expect(status.bridgeVersion).toBe('1.0.0');
    expect(status.dispatcherBuildId).toBe(dispatcher.buildId);
  });
});

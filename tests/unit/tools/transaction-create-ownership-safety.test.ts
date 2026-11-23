import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerSchematicWriteTools } from '../../../src/tools/L1_schematic_write.js';
import { registerTransactionTools } from '../../../src/tools/L1_transactions.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/index.js';

describe('schematic create ownership safety (separate from unsupported typed delete)', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
    registry = new ToolRegistry();
    const env = EnvSchema.parse({ NODE_ENV: 'test' });
    registerSchematicWriteTools(registry, env);
    registerTransactionTools(registry, env);
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    } as ToolContext;
  });

  const nativeFocus = (path: string) => ({
    result:
      path === 'DMT_Project.getCurrentProjectInfo'
        ? { uuid: 'proj-1' }
        : { uuid: 'page-1', parentProjectUuid: 'proj-1', documentType: 1 },
  });

  it('never deletes a concurrently created unrelated part during timed-out create or retry rollback', async () => {
    let listCalls = 0;
    bridgeCall.mockImplementation(async (method: string, p: any) => {
      if (method === 'api.read') return nativeFocus(p.path);
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listPrimitiveIds') {
        listCalls++;
        return { primitiveIds: listCalls === 1 ? [] : ['foreign-1'] };
      }
      if (method === 'schematic.placeComponent') throw new Error('Bridge timed out');
      if (method === 'schematic.getPrimitiveSnapshot')
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'foreign-1',
          primitiveKind: 'component',
          property: { x: 800, y: 900 },
        };
      if (method === 'schematic.deletePrimitive') throw new Error('UNSAFE FOREIGN DELETE');
      throw new Error('Unexpected bridge call: ' + method);
    });
    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const rollback = registry.get('easyeda_project_rollback_transaction');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;
    const created = await place?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });
    expect(created).toMatchObject({ success: false, error_code: 'TRANSACTION_OPERATION_FAILED' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    await rollback?.handler(context, { transactionId: started.transaction.id, confirmWrite: true });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('never accepts an unrelated newly discovered native component as a successful create', async () => {
    let placed = false;
    bridgeCall.mockImplementation(async (method: string, p: any) => {
      if (method === 'api.read') return nativeFocus(p.path);
      if (method === 'schematic.listPrimitiveIds')
        return { primitiveIds: placed ? ['foreign-2'] : [] };
      if (method === 'schematic.listComponents')
        return placed
          ? {
              total: 1,
              items: [
                {
                  primitiveId: 'foreign-2',
                  deviceUuid: 'unrelated',
                  deviceLibraryUuid: 'foreign-lib',
                  x: 800,
                  y: 900,
                  reference: 'U3',
                },
              ],
            }
          : { total: 0, items: [] };
      if (method === 'schematic.placeComponent') {
        placed = true;
        return { componentId: 'foreign-2' };
      }
      if (method === 'schematic.getPrimitiveSnapshot')
        return {
          primitiveId: 'foreign-2',
          primitiveKind: 'component',
          property: { x: 800, y: 900 },
        };
      if (method === 'schematic.deletePrimitive') throw new Error('UNSAFE FOREIGN DELETE');
      throw new Error('Unexpected bridge call: ' + method);
    });
    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;
    const created = await place?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });
    expect(created).toMatchObject({ success: false, error_code: 'TRANSACTION_OPERATION_FAILED' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('does not misreport a pre-existing colocated part as a new standalone placement on timeout', async () => {
    const existing = {
      primitiveId: 'existing-1',
      deviceUuid: 'dev-1',
      deviceLibraryUuid: 'lib-1',
      x: 10,
      y: 20,
    };
    bridgeCall
      .mockResolvedValueOnce({ total: 1, items: [existing] })
      .mockRejectedValueOnce(new Error('Bridge timed out'))
      .mockResolvedValueOnce({ total: 1, items: [existing] });
    const place = registry.get('easyeda_schematic_place_component');
    const created = await place?.handler(context, {
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      verifyAfterWrite: true,
      confirmWrite: true,
    });
    expect(created).toMatchObject({ success: false, unconfirmed: true });
    expect(created).not.toHaveProperty('reconciled', true);
  });

  it.each([
    ['truncated native component inventory', 'truncated'],
    ['existing native component disappears during creation', 'removed'],
    ['returned native ID differs from the only new component', 'wrong-response'],
    ['fresh native snapshot reports a different primitive kind', 'wrong-snapshot'],
  ] as const)('refuses unsafe transaction state: %s', async (_description, scenario) => {
    let placed = false;
    const existing = {
      primitiveId: 'old-1',
      deviceUuid: 'dev-previous',
      deviceLibraryUuid: 'lib-previous',
      x: 100,
      y: 200,
    };
    const created = {
      primitiveId: 'new-1',
      deviceUuid: 'dev-1',
      deviceLibraryUuid: 'lib-1',
      x: 10,
      y: 20,
    };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params.path);
      if (method === 'schematic.listComponents') {
        if (!placed) {
          return scenario === 'truncated'
            ? { total: 2, items: [existing] }
            : { total: 1, items: [existing] };
        }
        const items = scenario === 'removed' ? [created] : [existing, created];
        return { total: items.length, items };
      }
      if (method === 'schematic.listPrimitiveIds')
        return { primitiveIds: placed ? ['new-1'] : ['old-1'] };
      if (method === 'schematic.placeComponent') {
        placed = true;
        return { componentId: scenario === 'wrong-response' ? 'another-1' : 'new-1' };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'new-1',
          primitiveKind: scenario === 'wrong-snapshot' ? 'wire' : 'component',
          property: { x: 10, y: 20 },
        };
      }
      if (method === 'schematic.deletePrimitive') {
        throw new Error('UNSAFE: native component identity cannot be proved');
      }
      throw new Error('Unexpected bridge call: ' + method);
    });

    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;
    const result = await place?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });
    expect(result).toMatchObject({
      success: false,
      error_code:
        scenario === 'truncated' ? 'TRANSACTION_INVALID_STATE' : 'TRANSACTION_OPERATION_FAILED',
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    if (scenario === 'truncated')
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.placeComponent', expect.anything());
  });
});

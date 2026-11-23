import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerSchematicWriteTools } from '../../../src/tools/L1_schematic_write.js';
import { registerTransactionTools } from '../../../src/tools/L1_transactions.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/index.js';

type Snapshot = {
  schemaVersion: 'schematic-primitive-snapshot/v1';
  primitiveId: string;
  primitiveKind: string;
  property: Record<string, unknown>;
};

describe('standalone schematic writes with project transactions', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerSchematicWriteTools(registry, config);
    registerTransactionTools(registry, config);
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    } as ToolContext;
  });

  const nativeFocus = (params: { path?: string }) => ({
    result:
      params.path === 'DMT_Project.getCurrentProjectInfo'
        ? { uuid: 'proj-1' }
        : { uuid: 'page-1', parentProjectUuid: 'proj-1', documentType: 1 },
  });

  it('requires projectId when transactionId is supplied to standalone placement or deletion', () => {
    const place = registry.get('easyeda_schematic_place_component');
    const remove = registry.get('easyeda_schematic_delete_primitive');

    expect(
      place?.inputSchema.safeParse({
        transactionId: 'tx-1',
        deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
        x: 10,
        y: 20,
        confirmWrite: true,
      }).success,
    ).toBe(false);
    expect(
      remove?.inputSchema.safeParse({
        transactionId: 'tx-1',
        primitiveIds: ['wire-1'],
        confirmWrite: true,
      }).success,
    ).toBe(false);
  });

  it('records standalone component placement and removes it on project rollback', async () => {
    const components = new Map<string, Snapshot>();
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params);
      if (method === 'schematic.listComponents') {
        const items = [...components.entries()].map(([primitiveId, snapshot]) => ({
          primitiveId,
          deviceUuid: 'dev-1',
          deviceLibraryUuid: 'lib-1',
          x: snapshot.property.x,
          y: snapshot.property.y,
        }));
        return { total: items.length, items };
      }
      if (method === 'schematic.listPrimitiveIds') {
        return { primitiveIds: [...components.keys()] };
      }
      if (method === 'schematic.placeComponent') {
        components.set('comp-1', {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'comp-1',
          primitiveKind: 'component',
          property: { x: params.x, y: params.y },
        });
        return { componentId: 'comp-1' };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = components.get(params.primitiveId);
        if (!snapshot) {
          throw Object.assign(new Error(`Primitive ${params.primitiveId} not found`), {
            code: 'PRIMITIVE_NOT_FOUND',
          });
        }
        return structuredClone(snapshot);
      }
      if (method === 'schematic.deletePrimitive') {
        expect(params).toMatchObject({
          expectedProjectUuid: 'proj-1',
          expectedSchematicPageUuid: 'page-1',
          expectedPrimitiveSnapshot: {
            primitiveId: 'comp-1',
            primitiveKind: 'component',
            property: { x: 10, y: 20 },
          },
        });
        for (const id of params.primitiveIds as string[]) components.delete(id);
        return { deleted: params.primitiveIds, notFound: [] };
      }
      throw new Error(`unexpected ${method}`);
    });

    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const rollback = registry.get('easyeda_project_rollback_transaction');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;

    const placed = await place?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });

    expect(placed).toMatchObject({
      success: true,
      transaction: {
        id: started.transaction.id,
        operation_state: 'applied',
        target_id: 'comp-1',
      },
    });
    expect(components.has('comp-1')).toBe(true);

    const rolledBack = await rollback?.handler(context, {
      transactionId: started.transaction.id,
      confirmWrite: true,
    });

    expect(rolledBack).toMatchObject({
      success: true,
      transaction: { state: 'rolled-back', rollback_complete: true, operation_count: 1 },
    });
    expect(components.has('comp-1')).toBe(false);
  });

  it('refuses to delete a verified transaction-created component whose native attributes changed before rollback', async () => {
    let created = false;
    let mutated = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params);
      if (method === 'schematic.listComponents') {
        const items = created
          ? [
              {
                primitiveId: 'new-1',
                deviceUuid: 'dev-1',
                deviceLibraryUuid: 'lib-1',
                x: 10,
                y: 20,
              },
            ]
          : [];
        return { total: items.length, items };
      }
      if (method === 'schematic.listPrimitiveIds') {
        return { primitiveIds: created ? ['new-1'] : [] };
      }
      if (method === 'schematic.placeComponent') {
        created = true;
        return { componentId: 'new-1' };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'new-1',
          primitiveKind: 'component',
          property: { x: mutated ? 999 : 10, y: 20 },
        };
      }
      if (method === 'schematic.deletePrimitive')
        throw new Error('UNSAFE: edited component deleted without snapshot readback');
      throw new Error(`unexpected ${method}`);
    });
    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const rollback = registry.get('easyeda_project_rollback_transaction');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;
    const placed = await place?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });
    expect(placed).toMatchObject({ success: true, transaction: { target_id: 'new-1' } });
    mutated = true; // Concurrent user edit after placement, before rollback.
    const result = await rollback?.handler(context, {
      transactionId: started.transaction.id,
      confirmWrite: true,
    });
    expect(result).toMatchObject({ success: false, error_code: 'TRANSACTION_ROLLBACK_FAILED' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('records standalone safe primitive deletion and recreates it on project rollback', async () => {
    const primitives = new Map<string, Snapshot>([
      [
        'wire-1',
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        },
      ],
    ]);
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = primitives.get(params.primitiveId);
        if (!snapshot) {
          throw Object.assign(new Error(`Primitive ${params.primitiveId} not found`), {
            code: 'PRIMITIVE_NOT_FOUND',
          });
        }
        return structuredClone(snapshot);
      }
      if (method === 'schematic.deletePrimitive') {
        const deleted: string[] = [];
        const notFound: string[] = [];
        for (const id of params.primitiveIds as string[]) {
          if (primitives.delete(id)) deleted.push(id);
          else notFound.push(id);
        }
        return { deleted, notFound };
      }
      if (method === 'schematic.recreatePrimitiveSnapshot') {
        const before = params.snapshot as Snapshot;
        const recreated = { ...structuredClone(before), primitiveId: 'wire-2' };
        primitives.set('wire-2', recreated);
        return { primitiveId: 'wire-2', snapshot: structuredClone(recreated) };
      }
      throw new Error(`unexpected ${method}`);
    });

    const begin = registry.get('easyeda_project_begin_transaction');
    const remove = registry.get('easyeda_schematic_delete_primitive');
    const rollback = registry.get('easyeda_project_rollback_transaction');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;

    const deleted = await remove?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      primitiveIds: ['wire-1'],
      confirmWrite: true,
    });

    expect(deleted).toMatchObject({
      success: true,
      transaction: {
        id: started.transaction.id,
        operations: [{ target_id: 'wire-1', operation_state: 'applied' }],
      },
    });
    expect(primitives.has('wire-1')).toBe(false);

    const rolledBack = await rollback?.handler(context, {
      transactionId: started.transaction.id,
      confirmWrite: true,
    });

    expect(rolledBack).toMatchObject({
      success: true,
      transaction: {
        state: 'rolled-back',
        rollback_complete: true,
        operation_count: 1,
        operations: [{ restored_target_id: 'wire-2' }],
      },
    });
    expect(primitives.get('wire-2')).toMatchObject({
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    });
  });

  it('rejects a transaction bound to another project before standalone placement mutates EasyEDA', async () => {
    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const started = (await begin?.handler(context, { projectId: 'proj-A' })) as any;

    const result = await place?.handler(context, {
      projectId: 'proj-B',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('fails closed before deleting a component that cannot be transactionally recreated', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: params.primitiveId,
          primitiveKind: 'component',
          property: { x: 10, y: 20 },
        };
      }
      throw new Error(`unexpected mutation ${method}`);
    });

    const begin = registry.get('easyeda_project_begin_transaction');
    const remove = registry.get('easyeda_schematic_delete_primitive');
    const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;

    const result = await remove?.handler(context, {
      projectId: 'proj-1',
      transactionId: started.transaction.id,
      primitiveIds: ['comp-1'],
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_INVALID_STATE',
      details: {
        primitiveId: 'comp-1',
        primitiveKind: 'component',
      },
    });
    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(bridgeCall).toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'comp-1',
    });
  });

  it('preserves standalone placement error and timeout reconciliation semantics', async () => {
    const place = registry.get('easyeda_schematic_place_component');

    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.placeComponent') throw new Error('bridge exploded');
      throw new Error(`unexpected ${method}`);
    });
    await expect(
      place?.handler(context, {
        deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
        x: 10,
        y: 20,
        confirmWrite: true,
      }),
    ).resolves.toEqual({ success: false, error: 'bridge exploded' });

    bridgeCall.mockReset();
    let componentReads = 0;
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.placeComponent') throw new Error('Bridge timeout');
      if (method === 'schematic.listComponents') {
        componentReads += 1;
        // Success after timeout is supported ONLY when the unique native ID
        // was not present in the complete pre-write inventory.
        return {
          total: componentReads === 1 ? 0 : 1,
          items:
            componentReads === 1
              ? []
              : [
                  {
                    primitiveId: 'comp-timeout',
                    deviceUuid: 'dev-1',
                    position: { x: 10, y: 20 },
                  },
                ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    await expect(
      place?.handler(context, {
        deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
        x: 10,
        y: 20,
        verifyAfterWrite: true,
        confirmWrite: true,
      }),
    ).resolves.toMatchObject({
      success: true,
      reconciled: true,
      component: { primitiveId: 'comp-timeout' },
    });
    expect(componentReads).toBe(2);

    bridgeCall.mockReset();
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.placeComponent') throw new Error('Bridge timed out');
      if (method === 'schematic.listComponents') return { items: [] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(
      place?.handler(context, {
        deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
        x: 10,
        y: 20,
        confirmWrite: true,
      }),
    ).resolves.toMatchObject({ success: false, unconfirmed: true, error: 'Bridge timed out' });
  });

  it("never deletes another editor's newly discovered component after a timed-out transactional create", async () => {
    let listCalls = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params);
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listPrimitiveIds') {
        listCalls += 1;
        return { primitiveIds: listCalls === 1 ? [] : ['unrelated-1'] };
      }
      if (method === 'schematic.placeComponent') throw new Error('Bridge timeout');
      if (method === 'schematic.getPrimitiveSnapshot') {
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'unrelated-1',
          primitiveKind: 'component',
          property: { x: 400, y: 500 },
        };
      }
      if (method === 'schematic.deletePrimitive') {
        throw new Error('UNSAFE: unrelated component deletion was attempted');
      }
      throw new Error(`unexpected ${method}`);
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
    expect(result).toMatchObject({ success: false, error_code: 'TRANSACTION_OPERATION_FAILED' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    const rollback = registry.get('easyeda_project_rollback_transaction');
    const rollbackResult = await rollback?.handler(context, {
      transactionId: started.transaction.id,
      confirmWrite: true,
    });
    expect(rollbackResult).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_ROLLBACK_FAILED',
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('does not accept an unrelated native component as a successful transactional create', async () => {
    let calls = 0;
    let placed = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params);
      if (method === 'schematic.listPrimitiveIds') {
        calls += 1;
        return { primitiveIds: calls === 1 ? [] : ['unrelated-2'] };
      }
      if (method === 'schematic.placeComponent') {
        placed = true;
        return { componentId: 'unrelated-2' };
      }
      if (method === 'schematic.listComponents') {
        if (!placed) return { total: 0, items: [] };
        return {
          total: 1,
          items: [
            {
              primitiveId: 'unrelated-2',
              deviceUuid: 'other-library-device',
              deviceLibraryUuid: 'other-library',
              reference: 'U3',
              x: 400,
              y: 500,
            },
          ],
        };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        return { primitiveId: 'unrelated-2', primitiveKind: 'component', property: { x: 400 } };
      }
      if (method === 'schematic.deletePrimitive')
        throw new Error('UNSAFE: unrelated component deletion was attempted');
      throw new Error(`unexpected ${method}`);
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
    expect(result).toMatchObject({ success: false, error_code: 'TRANSACTION_OPERATION_FAILED' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('refuses the wrong focused native project before creating a transactional component', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params); // native proj-1, transaction proj-foreign
      if (method === 'schematic.placeComponent') throw new Error('WRONG PROJECT MUTATED');
      throw new Error(`unexpected ${method}`);
    });
    const begin = registry.get('easyeda_project_begin_transaction');
    const place = registry.get('easyeda_schematic_place_component');
    const started = (await begin?.handler(context, { projectId: 'proj-foreign' })) as any;
    const result = await place?.handler(context, {
      projectId: 'proj-foreign',
      transactionId: started.transaction.id,
      deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
      x: 10,
      y: 20,
      confirmWrite: true,
    });
    expect(result).toMatchObject({ success: false, error_code: 'TRANSACTION_INVALID_STATE' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.placeComponent', expect.anything());
  });

  it('refuses a native focused-page switch during transactional placement preflight', async () => {
    let pageReads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') {
        if (params.path === 'DMT_Project.getCurrentProjectInfo')
          return { result: { uuid: 'proj-1' } };
        pageReads += 1;
        return {
          result: {
            uuid: pageReads === 1 ? 'page-1' : 'page-2',
            parentProjectUuid: 'proj-1',
            documentType: 1,
          },
        };
      }
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.placeComponent') throw new Error('WRONG PAGE MUTATED');
      throw new Error(`unexpected ${method}`);
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
    expect(result).toMatchObject({ success: false, error_code: 'TRANSACTION_INVALID_STATE' });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.placeComponent', expect.anything());
  });

  it('fails transactional placement when create reconciliation is ambiguous', async () => {
    let placed = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return nativeFocus(params);
      if (method === 'schematic.listComponents')
        return {
          total: placed ? 2 : 0,
          items: placed
            ? [
                { primitiveId: 'comp-1', deviceUuid: 'dev-1', x: 10, y: 20 },
                { primitiveId: 'comp-2', deviceUuid: 'dev-1', x: 10, y: 20 },
              ]
            : [],
        };
      if (method === 'schematic.listPrimitiveIds') {
        return { primitiveIds: placed ? ['comp-1', 'comp-2'] : [] };
      }
      if (method === 'schematic.placeComponent') {
        placed = true;
        return { componentId: 'ambiguous' };
      }
      throw new Error(`unexpected ${method}`);
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
      error_code: 'TRANSACTION_OPERATION_FAILED',
    });
  });

  it('fails transactional placement without a discoverable created primitive', async () => {
    vi.useFakeTimers();
    try {
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'api.read') return nativeFocus(params);
        if (method === 'schematic.listComponents') return { total: 0, items: [] };
        if (method === 'schematic.listPrimitiveIds') return { primitiveIds: [] };
        if (method === 'schematic.placeComponent') return { componentId: 'not-addressable' };
        throw new Error(`unexpected ${method}`);
      });

      const begin = registry.get('easyeda_project_begin_transaction');
      const place = registry.get('easyeda_schematic_place_component');
      const started = (await begin?.handler(context, { projectId: 'proj-1' })) as any;
      const pending = place?.handler(context, {
        projectId: 'proj-1',
        transactionId: started.transaction.id,
        deviceItem: { libraryUuid: 'lib-1', uuid: 'dev-1' },
        x: 10,
        y: 20,
        confirmWrite: true,
      });

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({
        success: false,
        error_code: 'TRANSACTION_OPERATION_FAILED',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

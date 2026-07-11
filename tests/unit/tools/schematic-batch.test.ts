import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/index.js';
import { registerSchematicBatchTools } from '../../../src/tools/L1_schematic_batch.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

function primitiveNotFound(id: string): Error {
  return Object.assign(new Error(`Primitive ${id} not found`), { code: 'PRIMITIVE_NOT_FOUND' });
}

describe('easyeda_schematic_batch_write', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
    registry = new ToolRegistry();
    registerSchematicBatchTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('rejects text create/modify alignment outside the documented 1..9 enum', async () => {
    const tool = registry.get('easyeda_schematic_batch_write');

    await expect(
      tool?.handler(context, {
        projectId: 'project-1',
        operations: [
          {
            operationId: 'invalid-text',
            action: 'create',
            primitiveKind: 'text',
            x: 10,
            y: 20,
            content: 'INVALID',
            alignMode: 11,
          },
        ],
        atomic: true,
        dryRun: true,
        confirmWrite: true,
      }),
    ).rejects.toThrow();

    await expect(
      tool?.handler(context, {
        projectId: 'project-1',
        operations: [
          {
            operationId: 'invalid-modify',
            action: 'modify',
            primitiveId: 'text-1',
            property: { alignMode: 0 },
          },
        ],
        atomic: true,
        dryRun: true,
        confirmWrite: true,
      }),
    ).rejects.toThrow();
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('returns a write-free deterministic dry-run plan', async () => {
    const tool = registry.get('easyeda_schematic_batch_write');
    const result = await tool?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'create-wire',
          action: 'create',
          primitiveKind: 'wire',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          netName: 'N1',
        },
      ],
      atomic: true,
      dryRun: true,
      confirmWrite: true,
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      atomic: true,
      dry_run: true,
      internally_managed_transaction: false,
      committed: false,
      rolled_back: false,
      results: [
        {
          operation_id: 'create-wire',
          action: 'create',
          status: 'planned',
          primitive_id: undefined,
        },
      ],
    });
  });

  it('creates and commits an internally managed transaction', async () => {
    const snapshots = new Map<string, Record<string, unknown>>();
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listPrimitiveIds') {
        return { primitiveKind: params.primitiveKind, primitiveIds: [...snapshots.keys()] };
      }
      if (method === 'schematic.addWire') {
        const snapshot = {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        };
        snapshots.set('wire-1', snapshot);
        return { primitiveId: 'wire-1' };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = snapshots.get(params.primitiveId);
        if (!snapshot) throw primitiveNotFound(params.primitiveId);
        return structuredClone(snapshot);
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'create-wire',
          action: 'create',
          primitiveKind: 'wire',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          netName: 'N1',
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: true,
      internally_managed_transaction: true,
      transaction_state: 'committed',
      committed: true,
      rolled_back: false,
      results: [
        {
          operation_id: 'create-wire',
          action: 'create',
          status: 'applied',
          primitive_id: 'wire-1',
        },
      ],
    });
  });

  it('waits for an eventually visible primitive ID after create returns no ID', async () => {
    const snapshots = new Map<string, Record<string, unknown>>();
    let textInventoryReads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listPrimitiveIds') {
        textInventoryReads += 1;
        return {
          primitiveKind: params.primitiveKind,
          primitiveIds: textInventoryReads >= 3 ? [...snapshots.keys()] : [],
        };
      }
      if (method === 'schematic.addText') {
        snapshots.set('text-delayed-1', {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'text-delayed-1',
          primitiveKind: 'text',
          property: { x: 10, y: 20, content: 'DELAYED', alignMode: 3 },
        });
        return undefined;
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = snapshots.get(params.primitiveId);
        if (!snapshot) throw primitiveNotFound(params.primitiveId);
        return structuredClone(snapshot);
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'create-delayed-text',
          action: 'create',
          primitiveKind: 'text',
          x: 10,
          y: 20,
          content: 'DELAYED',
          alignMode: 3,
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(textInventoryReads).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({
      success: true,
      committed: true,
      results: [
        {
          operation_id: 'create-delayed-text',
          status: 'applied',
          primitive_id: 'text-delayed-1',
        },
      ],
    });
  });

  it('prefers the expected-kind inventory delta over an unrelated ID returned by create', async () => {
    const snapshots = new Map<string, Record<string, unknown>>([
      [
        'text-unrelated',
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'text-unrelated',
          primitiveKind: 'text',
          property: { x: 1, y: 1, content: 'existing', alignMode: 3 },
        },
      ],
    ]);
    let rectangleCreated = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listPrimitiveIds') {
        if (params.primitiveKind === 'rectangle') {
          return {
            primitiveKind: 'rectangle',
            primitiveIds: rectangleCreated ? ['rectangle-new'] : [],
          };
        }
        return { primitiveKind: params.primitiveKind, primitiveIds: [] };
      }
      if (method === 'schematic.addRectangle') {
        rectangleCreated = true;
        snapshots.set('rectangle-new', {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'rectangle-new',
          primitiveKind: 'rectangle',
          property: { x: 10, y: 20, width: 30, height: 40 },
        });
        return { text: { primitiveId: 'text-unrelated' } };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = snapshots.get(params.primitiveId);
        if (!snapshot) throw primitiveNotFound(params.primitiveId);
        return structuredClone(snapshot);
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'create-rectangle',
          action: 'create',
          primitiveKind: 'rectangle',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: true,
      committed: true,
      results: [
        {
          operation_id: 'create-rectangle',
          status: 'applied',
          primitive_id: 'rectangle-new',
        },
      ],
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'text-unrelated',
      expectedPrimitiveKind: 'rectangle',
    });
    expect(bridgeCall).toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'rectangle-new',
      expectedPrimitiveKind: 'rectangle',
    });
  });

  it('rolls back an earlier create when a later modify fails', async () => {
    const snapshots = new Map<string, Record<string, unknown>>([
      [
        'text-1',
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'text-1',
          primitiveKind: 'text',
          property: { x: 5, y: 5, content: 'before' },
        },
      ],
    ]);
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listPrimitiveIds') {
        return {
          primitiveKind: params.primitiveKind,
          primitiveIds: [...snapshots.values()]
            .filter((snapshot) => snapshot.primitiveKind === params.primitiveKind)
            .map((snapshot) => snapshot.primitiveId),
        };
      }
      if (method === 'schematic.addWire') {
        snapshots.set('wire-1', {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        });
        return { primitiveId: 'wire-1' };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = snapshots.get(params.primitiveId);
        if (!snapshot) throw primitiveNotFound(params.primitiveId);
        return structuredClone(snapshot);
      }
      if (method === 'schematic.modifyPrimitive') throw new Error('write rejected');
      if (method === 'schematic.deletePrimitive') {
        for (const id of params.primitiveIds) snapshots.delete(id);
        return { success: true, deleted: params.primitiveIds, notFound: [] };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'create-wire',
          action: 'create',
          primitiveKind: 'wire',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          netName: 'N1',
        },
        {
          operationId: 'modify-text',
          action: 'modify',
          primitiveId: 'text-1',
          property: { content: 'after' },
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(snapshots.has('wire-1')).toBe(false);
    expect(result).toMatchObject({
      success: false,
      transaction_state: 'rolled-back',
      committed: false,
      rolled_back: true,
      results: [
        { operation_id: 'create-wire', status: 'rolled-back' },
        { operation_id: 'modify-text', status: 'failed' },
      ],
    });
  });

  it('recreates a deleted drawing primitive when the batch rolls back', async () => {
    const snapshots = new Map<string, Record<string, unknown>>([
      [
        'wire-old',
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-old',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        },
      ],
      [
        'text-1',
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'text-1',
          primitiveKind: 'text',
          property: { x: 5, y: 5, content: 'before' },
        },
      ],
    ]);
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        const snapshot = snapshots.get(params.primitiveId);
        if (!snapshot) throw primitiveNotFound(params.primitiveId);
        return structuredClone(snapshot);
      }
      if (method === 'schematic.deletePrimitive') {
        for (const id of params.primitiveIds) snapshots.delete(id);
        return { success: true, deleted: params.primitiveIds, notFound: [] };
      }
      if (method === 'schematic.modifyPrimitive') throw new Error('later write failed');
      if (method === 'schematic.recreatePrimitiveSnapshot') {
        const recreated = {
          ...(structuredClone(params.snapshot) as Record<string, unknown>),
          primitiveId: 'wire-restored',
        };
        snapshots.set('wire-restored', recreated);
        return { primitiveId: 'wire-restored', snapshot: structuredClone(recreated) };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        { operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-old' },
        {
          operationId: 'modify-text',
          action: 'modify',
          primitiveId: 'text-1',
          property: { content: 'after' },
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(snapshots.has('wire-old')).toBe(false);
    expect(snapshots.has('wire-restored')).toBe(true);
    expect(result).toMatchObject({
      success: false,
      transaction_state: 'rolled-back',
      rolled_back: true,
      results: [
        { operation_id: 'delete-wire', status: 'rolled-back' },
        { operation_id: 'modify-text', status: 'failed' },
      ],
    });
  });

  it('rejects unsupported component delete before issuing a write', async () => {
    bridgeCall.mockResolvedValue({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'u1',
      primitiveKind: 'component',
      property: { designator: 'U1' },
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [{ operationId: 'delete-u1', action: 'delete', primitiveId: 'u1' }],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(bridgeCall).toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'u1',
    });
    expect(result).toMatchObject({
      success: false,
      committed: false,
      rolled_back: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
  });

  it('leaves a caller-owned transaction active after a successful batch', async () => {
    const manager = resetGlobalTransactionManagerForTests();
    const transaction = manager.begin({ documentId: 'project-1' });
    const snapshot = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'text-1',
      primitiveKind: 'text',
      property: { x: 5, y: 5, content: 'before' },
    };
    const current = structuredClone(snapshot);
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPrimitiveSnapshot') return structuredClone(current);
      if (method === 'schematic.modifyPrimitive') {
        current.property.content = params.property.content;
        return true;
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      transactionId: transaction.id,
      operations: [
        {
          operationId: 'modify-text',
          action: 'modify',
          primitiveId: 'text-1',
          property: { content: 'after' },
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(current.property.content).toBe('after');
    expect(result).toMatchObject({
      success: true,
      internally_managed_transaction: false,
      transaction_id: transaction.id,
      transaction_state: 'active',
      committed: false,
      rolled_back: false,
    });
  });

  it('does not roll back a caller transaction that belongs to another project', async () => {
    const manager = resetGlobalTransactionManagerForTests();
    const transaction = manager.begin({ documentId: 'other-project' });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      transactionId: transaction.id,
      operations: [
        {
          operationId: 'modify-text',
          action: 'modify',
          primitiveId: 'text-1',
          property: { content: 'after' },
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(manager.get(transaction.id).state).toBe('active');
    expect(result).toMatchObject({
      success: false,
      transaction_id: transaction.id,
      committed: false,
      rolled_back: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
  });
});

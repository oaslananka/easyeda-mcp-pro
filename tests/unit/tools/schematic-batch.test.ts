import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/index.js';
import { registerSchematicBatchTools } from '../../../src/tools/L1_schematic_batch.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

function primitiveNotFound(id: string): Error {
  return Object.assign(new Error(`Primitive ${id} not found`), { code: 'PRIMITIVE_NOT_FOUND' });
}

function verifiedSchematicFocus(method: string, params: { path?: string }): unknown {
  if (method !== 'api.read') return undefined;
  if (params.path === 'DMT_Project.getCurrentProjectInfo') {
    return { result: { uuid: 'project-1' } };
  }
  if (params.path === 'DMT_SelectControl.getCurrentDocumentInfo') {
    return { result: { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 } };
  }
  throw new Error('Unexpected native identity reader ' + String(params.path));
}

function verifiedDrawingStatus() {
  return { documentTargetGuard: true, documentProjectGuard: true, verifiedDrawingCreate: true };
}
function drawingAck(primitiveId: string) {
  return {
    primitiveId,
    verifiedDrawingCreate: true,
    targetDocument: {
      uuid: 'page-1',
      projectUuid: 'project-1',
      documentType: 'schematic',
    },
  };
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
      bridge: {
        connected: true,
        // The native dispatcher appends targetDocument to a guarded snapshot
        // response. Preserve explicitly supplied evidence for negative tests.
        call: (async (...args: [string, Record<string, unknown>?, unknown?]) => {
          const value = await bridgeCall(...args);
          const [method, params] = args;
          if (
            method === 'schematic.getPrimitiveSnapshot' &&
            params?.expectedProjectUuid === 'project-1' &&
            params.expectedSchematicPageUuid === 'page-1' &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !Object.hasOwn(value, 'targetDocument')
          ) {
            return {
              ...value,
              targetDocument: {
                uuid: 'page-1',
                projectUuid: 'project-1',
                name: 'P1',
                documentType: 'schematic',
              },
            };
          }
          return value;
        }) as ToolContext['bridge']['call'],
      },
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

  it('plans a pin no-connect mutation without issuing a write', async () => {
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'mark-u1-7-nc',
          action: 'setPinNoConnect',
          primitiveId: 'comp-1',
          pinNumber: '7',
          noConnected: true,
        },
      ],
      atomic: true,
      dryRun: true,
      confirmWrite: true,
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      dry_run: true,
      results: [
        {
          operation_id: 'mark-u1-7-nc',
          action: 'setPinNoConnect',
          status: 'planned',
          primitive_id: 'comp-1',
          pin_number: '7',
        },
      ],
    });
  });

  it('sets native pin no-connect state in an internally managed transaction', async () => {
    let noConnected = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPinNoConnect') {
        return {
          componentPrimitiveId: params.primitiveId,
          pinPrimitiveId: 'pin-7',
          pinNumber: params.pinNumber,
          noConnected,
        };
      }
      if (method === 'schematic.setPinNoConnect') {
        const previousNoConnected = noConnected;
        noConnected = params.noConnected;
        return {
          componentPrimitiveId: params.primitiveId,
          pinPrimitiveId: 'pin-7',
          pinNumber: params.pinNumber,
          previousNoConnected,
          noConnected,
          changed: previousNoConnected !== noConnected,
          verified: true,
        };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'mark-u1-7-nc',
          action: 'setPinNoConnect',
          primitiveId: 'comp-1',
          pinNumber: '7',
          noConnected: true,
        },
      ],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });

    expect(noConnected).toBe(true);
    expect(result).toMatchObject({
      success: true,
      committed: true,
      results: [
        {
          operation_id: 'mark-u1-7-nc',
          action: 'setPinNoConnect',
          status: 'applied',
          primitive_id: 'comp-1',
          pin_primitive_id: 'pin-7',
          pin_number: '7',
        },
      ],
    });
  });

  it('restores the prior pin no-connect state when a later batch operation fails', async () => {
    let noConnected = false;
    const textSnapshot = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'text-1',
      primitiveKind: 'text',
      property: { x: 5, y: 5, content: 'before' },
    };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPinNoConnect') {
        return {
          componentPrimitiveId: params.primitiveId,
          pinPrimitiveId: 'pin-7',
          pinNumber: params.pinNumber,
          noConnected,
        };
      }
      if (method === 'schematic.setPinNoConnect') {
        const previousNoConnected = noConnected;
        noConnected = params.noConnected;
        return {
          componentPrimitiveId: params.primitiveId,
          pinPrimitiveId: 'pin-7',
          pinNumber: params.pinNumber,
          previousNoConnected,
          noConnected,
          changed: previousNoConnected !== noConnected,
          verified: true,
        };
      }
      if (method === 'schematic.getPrimitiveSnapshot') return structuredClone(textSnapshot);
      if (method === 'schematic.modifyPrimitive') throw new Error('later write failed');
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'mark-u1-7-nc',
          action: 'setPinNoConnect',
          primitiveId: 'comp-1',
          pinNumber: '7',
          noConnected: true,
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

    expect(noConnected).toBe(false);
    expect(result).toMatchObject({
      success: false,
      transaction_state: 'rolled-back',
      rolled_back: true,
      results: [
        { operation_id: 'mark-u1-7-nc', status: 'rolled-back' },
        { operation_id: 'modify-text', status: 'failed' },
      ],
    });
  });

  it.each(['wrong-project', 'wrong-page-type', 'unrelated-success', 'unrelated-timeout'])(
    'does not claim or remove an unowned batch create (%s)',
    async (scenario) => {
      const snapshots = new Map<string, Record<string, unknown>>();
      const unrelated = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'other-editor-text',
        primitiveKind: 'text',
        property: { x: 900, y: 950, content: 'another editor owns this' },
      };
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'system.getStatus') return verifiedDrawingStatus();
        if (method === 'api.read') {
          const response = verifiedSchematicFocus(method, params) as {
            result: Record<string, unknown>;
          };
          if (scenario === 'wrong-project') {
            if (params.path === 'DMT_Project.getCurrentProjectInfo')
              return { result: { uuid: 'foreign-project' } };
            return { result: { ...response.result, parentProjectUuid: 'foreign-project' } };
          }
          if (
            scenario === 'wrong-page-type' &&
            params.path === 'DMT_SelectControl.getCurrentDocumentInfo'
          )
            return { result: { ...response.result, documentType: 3 } };
          return response;
        }
        if (method === 'schematic.listPrimitiveIds')
          return {
            inventoryVerified: true,
            primitiveKind: params.primitiveKind,
            primitiveIds: [...snapshots.keys()],
          };
        if (method === 'schematic.addText') {
          snapshots.set('other-editor-text', structuredClone(unrelated));
          if (scenario === 'unrelated-timeout') throw new Error('native create timed out');
          return drawingAck('other-editor-text');
        }
        if (method === 'schematic.getPrimitiveSnapshot') {
          const snapshot = snapshots.get(params.primitiveId);
          if (!snapshot) throw primitiveNotFound(params.primitiveId);
          return structuredClone(snapshot);
        }
        if (method === 'schematic.deletePrimitive') {
          for (const id of params.primitiveIds) snapshots.delete(id);
          return { deleted: params.primitiveIds, notFound: [] };
        }
        throw new Error('Unexpected bridge method ' + method);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        operations: [
          {
            operationId: 'requested-text',
            action: 'create',
            primitiveKind: 'text',
            x: 10,
            y: 20,
            content: 'requested text',
          },
        ],
        atomic: true,
        dryRun: false,
        confirmWrite: true,
      });
      if (scenario === 'wrong-project' || scenario === 'wrong-page-type') {
        expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.addText')).toBe(
          false,
        );
      } else {
        expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.addText')).toBe(true);
        expect(snapshots.get('other-editor-text')).toEqual(unrelated);
        expect(
          bridgeCall.mock.calls.some(([method]) => method === 'schematic.deletePrimitive'),
        ).toBe(false);
      }
      expect(result).toMatchObject({ success: false, committed: false, rolled_back: false });
    },
  );

  it.each([
    'no-ack',
    'explicit-failure-ack',
    'wrong-target-ack',
    'lost-old-id',
    'wrong-kind',
    'never-visible',
    'old-extension',
    'missing-inventory',
    'duplicate-inventory',
    'foreign-delta',
    'existing-id',
    'changed-focus',
  ])('fails closed when batch creation evidence is incomplete (%s)', async (scenario) => {
    let created = false;
    const snapshot = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'new-text',
      primitiveKind: 'text',
      property: { x: 10, y: 20, content: 'requested' },
    };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'system.getStatus')
        return { ...verifiedDrawingStatus(), verifiedDrawingCreate: scenario !== 'old-extension' };
      if (method === 'api.read') {
        if (
          scenario === 'changed-focus' &&
          created &&
          params.path === 'DMT_SelectControl.getCurrentDocumentInfo'
        )
          return { result: { uuid: 'page-2', parentProjectUuid: 'project-1', documentType: 1 } };
        return verifiedSchematicFocus(method, params);
      }
      if (method === 'schematic.listPrimitiveIds')
        return {
          primitiveKind: 'text',
          inventoryVerified: scenario !== 'missing-inventory',
          primitiveIds:
            scenario === 'lost-old-id'
              ? created
                ? ['new-text']
                : ['old']
              : scenario === 'never-visible'
                ? []
                : scenario === 'duplicate-inventory'
                  ? ['old', 'old']
                  : scenario === 'existing-id'
                    ? ['new-text']
                    : created
                      ? scenario === 'foreign-delta'
                        ? ['new-text', 'other']
                        : ['new-text']
                      : [],
        };
      if (method === 'schematic.addText') {
        created = true;
        if (scenario === 'no-ack') return undefined;
        const ack = drawingAck('new-text');
        if (scenario === 'explicit-failure-ack') return { ...ack, success: false };
        if (scenario === 'wrong-target-ack') ack.targetDocument.uuid = 'page-2';
        return ack;
      }
      if (method === 'schematic.getPrimitiveSnapshot')
        return scenario === 'wrong-kind' ? { ...snapshot, primitiveKind: 'rectangle' } : snapshot;
      throw new Error('Unexpected method ' + method);
    });
    if (scenario === 'never-visible') vi.useFakeTimers();
    const pending = registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [
        {
          operationId: 'text',
          action: 'create',
          primitiveKind: 'text',
          x: 10,
          y: 20,
          content: 'requested',
        },
      ],
      atomic: true,
      confirmWrite: true,
    });
    if (scenario === 'never-visible') {
      await vi.advanceTimersByTimeAsync(3000);
      vi.useRealTimers();
    }
    const result = await pending;
    expect(result).toMatchObject({
      success: false,
      committed: false,
      rolled_back: ['missing-inventory', 'duplicate-inventory'].includes(scenario),
    });
    expect(created).toBe(
      !['old-extension', 'missing-inventory', 'duplicate-inventory'].includes(scenario),
    );
    expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.deletePrimitive')).toBe(
      false,
    );
  });

  it.each([
    { primitiveKind: 'component', deviceItem: { uuid: 'dev', libraryUuid: 'lib' }, x: 1, y: 2 },
    { primitiveKind: 'netflag', netName: 'GND', identification: 'Ground', x: 1, y: 2 },
    { primitiveKind: 'netport', netName: 'N1', portType: 'input', x: 1, y: 2 },
  ])('refuses unsupported atomic ownership before any native write (%j)', async (operation) => {
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      atomic: true,
      confirmWrite: true,
      operations: [
        {
          operationId: 'first',
          action: 'create',
          primitiveKind: 'text',
          x: 1,
          y: 2,
          content: 'first',
        },
        { operationId: 'unsupported', action: 'create', ...operation },
      ],
    });
    expect(result).toMatchObject({ success: false, committed: false });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'text',
      method: 'schematic.addText',
      args: { x: 10, y: 20, content: 'test' },
      property: { x: 10, y: 20, content: 'test' },
    },
    {
      kind: 'rectangle',
      method: 'schematic.addRectangle',
      args: { x: 10, y: 20, width: 30, height: 40 },
      property: { x: 10, y: 20, width: 30, height: 40 },
    },
    {
      kind: 'circle',
      method: 'schematic.addCircle',
      args: { centerX: 10, centerY: 20, radius: 5 },
      property: { centerX: 10, centerY: 20, radius: 5 },
    },
    {
      kind: 'polygon',
      method: 'schematic.addPolygon',
      args: {
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      },
      property: { line: [1, 2, 3, 4, 5, 6] },
    },
    {
      kind: 'wire',
      method: 'schematic.addWire',
      args: {
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        netName: 'N1',
      },
      property: { line: [1, 2, 3, 4], net: 'N1' },
    },
  ])(
    'rolls back a verified unchanged $kind with scoped snapshot evidence',
    async ({ kind, method, args, property }) => {
      const manager = resetGlobalTransactionManagerForTests();
      const transaction = manager.begin({ documentId: 'project-1' });
      const snapshot = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'new-drawing',
        primitiveKind: kind,
        property,
      };
      let exists = false;
      let callerTargetWrapper = true;
      bridgeCall.mockImplementation(async (name: string, params: any) => {
        if (name === 'system.getStatus') return verifiedDrawingStatus();
        if (name === 'api.read') return verifiedSchematicFocus(name, params);
        if (name === 'schematic.listPrimitiveIds')
          return {
            primitiveKind: kind,
            inventoryVerified: true,
            primitiveIds: exists ? ['new-drawing'] : [],
          };
        if (name === method) {
          expect(params).toMatchObject({
            expectedProjectUuid: 'project-1',
            expectedSchematicPageUuid: 'page-1',
            verifiedDrawingCreate: true,
          });
          exists = true;
          return drawingAck('new-drawing');
        }
        if (name === 'schematic.getPrimitiveSnapshot') {
          if (!exists) throw primitiveNotFound('new-drawing');
          // The public tool registry adds targetDocument transport evidence
          // during explicitly targeted calls, but not on a separate rollback.
          return {
            ...structuredClone(snapshot),
            ...(callerTargetWrapper || params.expectedSchematicPageUuid
              ? {
                  targetDocument: {
                    uuid: 'page-1',
                    documentType: 'schematic',
                    name: 'P1',
                    ...(params.expectedProjectUuid ? { projectUuid: 'project-1' } : {}),
                  },
                }
              : {}),
          };
        }
        if (name === 'schematic.deletePrimitive') {
          expect(params).toMatchObject({
            primitiveIds: ['new-drawing'],
            expectedProjectUuid: 'project-1',
            expectedSchematicPageUuid: 'page-1',
            expectedPrimitiveSnapshot: snapshot,
          });
          expect(params.expectedPrimitiveSnapshot).toEqual(snapshot);
          exists = false;
          return { deleted: ['new-drawing'], notFound: [] };
        }
        throw new Error('Unexpected method ' + name);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        transactionId: transaction.id,
        atomic: true,
        confirmWrite: true,
        operations: [{ operationId: 'drawing', action: 'create', primitiveKind: kind, ...args }],
      });
      expect(result).toMatchObject({ success: true, transaction_state: 'active' });
      expect(exists).toBe(true);
      callerTargetWrapper = false;
      const { rollbackEasyedaTransaction } = await import('../../../src/transactions/index.js');
      const rb = await rollbackEasyedaTransaction(manager, transaction.id, context.bridge);
      expect(rb.transaction.rollbackComplete).toBe(true);
      expect(exists).toBe(false);
    },
  );

  it.each([
    { line: [10, 0, 0, 0], net: 'N1', accepted: true },
    { line: [0, 0, 10, 0], net: 'N1', accepted: true },
    { line: [10, 0, 0, 0], net: 'N2', accepted: false },
    { line: [11, 0, 0, 0], net: 'N1', accepted: false },
    { line: [10, 0, 5, 0, 0, 0], net: 'N1', accepted: false },
  ])(
    'verifies only equivalent single-segment wire geometry (%j)',
    async ({ line, net, accepted }) => {
      let exists = false;
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'system.getStatus') return verifiedDrawingStatus();
        if (method === 'api.read') return verifiedSchematicFocus(method, params);
        if (method === 'schematic.listPrimitiveIds')
          return {
            primitiveKind: 'wire',
            inventoryVerified: true,
            primitiveIds: exists ? ['new-wire'] : [],
          };
        if (method === 'schematic.addWire') {
          exists = true;
          return drawingAck('new-wire');
        }
        if (method === 'schematic.getPrimitiveSnapshot')
          return {
            schemaVersion: 'schematic-primitive-snapshot/v1',
            primitiveId: 'new-wire',
            primitiveKind: 'wire',
            property: { line, net },
          };
        throw new Error('Unexpected method ' + method);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        atomic: true,
        confirmWrite: true,
        operations: [
          {
            operationId: 'wire',
            action: 'create',
            primitiveKind: 'wire',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
            netName: 'N1',
          },
        ],
      });
      expect(result).toMatchObject({ success: accepted, committed: accepted });
      expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.deletePrimitive')).toBe(
        false,
      );
    },
  );

  it.each(['changed-snapshot', 'changed-page'])(
    'refuses rollback of an owned drawing after %s',
    async (scenario) => {
      const manager = resetGlobalTransactionManagerForTests();
      const transaction = manager.begin({ documentId: 'project-1' });
      let created = false;
      let changed = false;
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'system.getStatus') return verifiedDrawingStatus();
        if (method === 'api.read') {
          if (
            changed &&
            scenario === 'changed-page' &&
            params.path === 'DMT_SelectControl.getCurrentDocumentInfo'
          )
            return { result: { uuid: 'page-2', parentProjectUuid: 'project-1', documentType: 1 } };
          return verifiedSchematicFocus(method, params);
        }
        if (method === 'schematic.listPrimitiveIds')
          return {
            primitiveKind: 'text',
            inventoryVerified: true,
            primitiveIds: created ? ['new-text'] : [],
          };
        if (method === 'schematic.addText') {
          created = true;
          return drawingAck('new-text');
        }
        if (method === 'schematic.getPrimitiveSnapshot')
          return {
            schemaVersion: 'schematic-primitive-snapshot/v1',
            primitiveId: 'new-text',
            primitiveKind: 'text',
            property: {
              x: 1,
              y: 2,
              content:
                changed && scenario === 'changed-snapshot' ? 'edited by another owner' : 'test',
            },
          };
        throw new Error('Unexpected method ' + method);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        transactionId: transaction.id,
        atomic: true,
        confirmWrite: true,
        operations: [
          {
            operationId: 'drawing',
            action: 'create',
            primitiveKind: 'text',
            x: 1,
            y: 2,
            content: 'test',
          },
        ],
      });
      expect(result).toMatchObject({ success: true });
      changed = true;
      const { rollbackEasyedaTransaction } = await import('../../../src/transactions/index.js');
      await expect(
        rollbackEasyedaTransaction(manager, transaction.id, context.bridge),
      ).rejects.toMatchObject({
        code: 'TRANSACTION_ROLLBACK_FAILED',
      });
      expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.deletePrimitive')).toBe(
        false,
      );
    },
  );

  it.each([{ connected: false }, { registryMismatch: true }, { extensionVersionMismatch: true }])(
    'blocks creation on incompatible bridge (%j)',
    async (state) => {
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(
        {
          ...context,
          bridge: { ...context.bridge, ...state },
        },
        {
          projectId: 'project-1',
          atomic: true,
          confirmWrite: true,
          operations: [
            {
              operationId: 'text',
              action: 'create',
              primitiveKind: 'text',
              x: 1,
              y: 2,
              content: 'test',
            },
          ],
        },
      );
      expect(result).toMatchObject({ success: false, committed: false });
      expect(bridgeCall).not.toHaveBeenCalled();
    },
  );

  it('blocks a PCB expectation on a schematic create before any bridge call', async () => {
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      expectedPcbUuid: 'pcb-1',
      atomic: true,
      confirmWrite: true,
      operations: [
        {
          operationId: 'text',
          action: 'create',
          primitiveKind: 'text',
          x: 1,
          y: 2,
          content: 'test',
        },
      ],
    });
    expect(result).toMatchObject({ success: false, committed: false });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('refuses mixed drawing creation and deletion when the preflight page changes', async () => {
    let page = 'page-1';
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'system.getStatus') {
        page = 'page-2';
        return verifiedDrawingStatus();
      }
      if (method === 'api.read') {
        if (params.path === 'DMT_SelectControl.getCurrentDocumentInfo')
          return { result: { uuid: page, parentProjectUuid: 'project-1', documentType: 1 } };
        return verifiedSchematicFocus(method, params);
      }
      if (method === 'schematic.getPrimitiveSnapshot')
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'old-text',
          primitiveKind: 'text',
          property: { x: 1, y: 2, content: 'old' },
        };
      throw new Error('Unexpected method ' + method);
    });
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      atomic: true,
      confirmWrite: true,
      operations: [
        { operationId: 'delete', action: 'delete', primitiveId: 'old-text' },
        {
          operationId: 'create',
          action: 'create',
          primitiveKind: 'text',
          x: 1,
          y: 2,
          content: 'new',
        },
      ],
    });
    expect(result).toMatchObject({ success: false, committed: false });
    expect(result).toMatchObject({
      error: expect.stringContaining('same verified native schematic page'),
    });
    expect(
      bridgeCall.mock.calls.some(([method]) =>
        ['schematic.addText', 'schematic.deletePrimitive'].includes(method),
      ),
    ).toBe(false);
  });

  it.each(['snapshot-too-large', 'changed-after-ack'])(
    'compensates only the unchanged verified owned drawing (%s)',
    async (scenario) => {
      const snapshot = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'new-text',
        primitiveKind: 'text',
        property: {
          x: 1,
          y: 2,
          content: 'test',
          extra: scenario === 'snapshot-too-large' ? 'x'.repeat(2 * 1024 * 1024) : '',
        },
      };
      let exists = false;
      let reads = 0;
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'system.getStatus') return verifiedDrawingStatus();
        if (method === 'api.read') return verifiedSchematicFocus(method, params);
        if (method === 'schematic.listPrimitiveIds')
          return {
            primitiveKind: 'text',
            inventoryVerified: true,
            primitiveIds: exists ? ['new-text'] : [],
          };
        if (method === 'schematic.addText') {
          exists = true;
          return drawingAck('new-text');
        }
        if (method === 'schematic.getPrimitiveSnapshot') {
          if (!exists) throw primitiveNotFound('new-text');
          reads++;
          if (scenario === 'changed-after-ack' && reads >= 2)
            return { ...snapshot, property: { ...snapshot.property, content: 'foreign edit' } };
          return structuredClone(snapshot);
        }
        if (method === 'schematic.deletePrimitive') {
          expect(params).toMatchObject({
            primitiveIds: ['new-text'],
            expectedProjectUuid: 'project-1',
            expectedSchematicPageUuid: 'page-1',
            expectedPrimitiveSnapshot: snapshot,
          });
          exists = false;
          return { deleted: ['new-text'], notFound: [] };
        }
        throw new Error('Unexpected method ' + method);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        atomic: true,
        confirmWrite: true,
        operations: [
          {
            operationId: 'text',
            action: 'create',
            primitiveKind: 'text',
            x: 1,
            y: 2,
            content: 'test',
          },
        ],
      });
      const compensated = scenario === 'snapshot-too-large';
      expect(result).toMatchObject({ success: false, committed: false, rolled_back: compensated });
      expect(exists).toBe(!compensated);
      expect(
        bridgeCall.mock.calls.filter(([method]) => method === 'schematic.deletePrimitive'),
      ).toHaveLength(compensated ? 1 : 0);
    },
  );

  it('refuses a caller-selected foreign page before any create even in direct handler invocation', async () => {
    let created = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'system.getStatus') return verifiedDrawingStatus();
      if (method === 'api.read') return verifiedSchematicFocus(method, params);
      if (method === 'schematic.listPrimitiveIds')
        return {
          primitiveKind: 'text',
          inventoryVerified: true,
          primitiveIds: created ? ['new-text'] : [],
        };
      if (method === 'schematic.addText') {
        created = true;
        return drawingAck('new-text');
      }
      if (method === 'schematic.getPrimitiveSnapshot')
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'new-text',
          primitiveKind: 'text',
          property: { x: 1, y: 2, content: 'test' },
        };
      throw new Error('Unexpected method ' + method);
    });
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      expectedSchematicPageUuid: 'page-2',
      atomic: true,
      confirmWrite: true,
      operations: [
        {
          operationId: 'drawing',
          action: 'create',
          primitiveKind: 'text',
          x: 1,
          y: 2,
          content: 'test',
        },
      ],
    });
    expect(result).toMatchObject({ success: false, committed: false });
    expect(created).toBe(false);
  });

  it('creates and commits an internally managed transaction', async () => {
    const snapshots = new Map<string, Record<string, unknown>>();
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'system.getStatus') return verifiedDrawingStatus();
      if (method === 'api.read') return verifiedSchematicFocus(method, params);

      if (method === 'schematic.listPrimitiveIds') {
        return {
          inventoryVerified: true,
          primitiveKind: params.primitiveKind,
          primitiveIds: [...snapshots.keys()],
        };
      }
      if (method === 'schematic.addWire') {
        const snapshot = {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        };
        snapshots.set('wire-1', snapshot);
        return drawingAck('wire-1');
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

  it('waits for an eventually visible primitive ID after an exact native acknowledgement', async () => {
    const snapshots = new Map<string, Record<string, unknown>>();
    let textInventoryReads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'system.getStatus') return verifiedDrawingStatus();
      if (method === 'api.read') return verifiedSchematicFocus(method, params);

      if (method === 'schematic.listPrimitiveIds') {
        textInventoryReads += 1;
        return {
          inventoryVerified: true,
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
        return drawingAck('text-delayed-1');
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

  it('refuses a contradictory returned ID rather than adopting the inventory delta', async () => {
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
      if (method === 'system.getStatus') return verifiedDrawingStatus();
      if (method === 'api.read') return verifiedSchematicFocus(method, params);

      if (method === 'schematic.listPrimitiveIds') {
        if (params.primitiveKind === 'rectangle') {
          return {
            inventoryVerified: true,
            primitiveKind: 'rectangle',
            primitiveIds: rectangleCreated ? ['rectangle-new'] : [],
          };
        }
        return { inventoryVerified: true, primitiveKind: params.primitiveKind, primitiveIds: [] };
      }
      if (method === 'schematic.addRectangle') {
        rectangleCreated = true;
        snapshots.set('rectangle-new', {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'rectangle-new',
          primitiveKind: 'rectangle',
          property: { x: 10, y: 20, width: 30, height: 40 },
        });
        return drawingAck('text-unrelated');
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

    expect(result).toMatchObject({ success: false, committed: false, rolled_back: false });
    expect(snapshots.has('text-unrelated')).toBe(true);
    expect(snapshots.has('rectangle-new')).toBe(true);
    expect(bridgeCall.mock.calls.some(([method]) => method === 'schematic.deletePrimitive')).toBe(
      false,
    );
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
      if (method === 'system.getStatus') return verifiedDrawingStatus();
      if (method === 'api.read') return verifiedSchematicFocus(method, params);

      if (method === 'schematic.listPrimitiveIds') {
        return {
          inventoryVerified: true,
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
        return drawingAck('wire-1');
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
      if (method === 'api.read') return verifiedSchematicFocus(method, params);
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

    expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
      primitiveIds: ['wire-old'],
      expectedProjectUuid: 'project-1',
      expectedSchematicPageUuid: 'page-1',
      expectedPrimitiveSnapshot: {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'wire-old',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      },
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

  it.each([
    ['primitive subtype', { primitiveKind: 'netflag', property: { net: 'GND' } }],
    ['net property', { primitiveKind: 'wire', property: { line: [0, 0, 10, 0], net: 'N2' } }],
  ] as const)(
    'refuses deletion when the %s changes between batch preflight and transaction snapshot',
    async (_reason, changed) => {
      const before = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'wire-1',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      };
      let snapshotReads = 0;
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'api.read') return verifiedSchematicFocus(method, params);
        if (method === 'schematic.getPrimitiveSnapshot') {
          expect(params.primitiveId).toBe('wire-1');
          snapshotReads += 1;
          return structuredClone(snapshotReads === 1 ? before : { ...before, ...changed });
        }
        if (method === 'schematic.deletePrimitive') {
          return { deleted: params.primitiveIds, notFound: [] };
        }
        throw new Error(`Unexpected bridge method ${method}`);
      });

      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
        atomic: true,
        dryRun: false,
        confirmWrite: true,
      });
      expect(snapshotReads).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({
        success: false,
        committed: false,
        error_code: 'TRANSACTION_INVALID_STATE',
      });
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    },
  );

  it.each([
    ['wrong active project', 'other-project', 'project-1', 1],
    ['wrong parent project', 'project-1', 'other-project', 1],
    ['wrong focused document type', 'project-1', 'project-1', 3],
  ] as const)(
    'refuses a transactional wire delete in the %s before native mutation',
    async (_reason, activeProject, parentProject, documentType) => {
      const snapshot = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'wire-1',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      };
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'api.read' && params.path === 'DMT_Project.getCurrentProjectInfo')
          return { result: { uuid: activeProject } };
        if (method === 'api.read' && params.path === 'DMT_SelectControl.getCurrentDocumentInfo')
          return { result: { uuid: 'page-1', parentProjectUuid: parentProject, documentType } };
        if (method === 'schematic.getPrimitiveSnapshot') return structuredClone(snapshot);
        if (method === 'schematic.deletePrimitive')
          return { deleted: params.primitiveIds, notFound: [] };
        throw new Error(`Unexpected bridge method ${method}`);
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
        atomic: true,
        dryRun: false,
        confirmWrite: true,
      });
      expect(result).toMatchObject({
        success: false,
        committed: false,
        error_code: 'TRANSACTION_INVALID_STATE',
      });
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    },
  );

  it('refuses a page switch after preflight and before the native delete boundary', async () => {
    const snapshot = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-1',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    };
    let pageReads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read' && params.path === 'DMT_Project.getCurrentProjectInfo')
        return { result: { uuid: 'project-1' } };
      if (method === 'api.read' && params.path === 'DMT_SelectControl.getCurrentDocumentInfo') {
        pageReads++;
        return {
          result: {
            uuid: pageReads > 4 ? 'page-2' : 'page-1',
            parentProjectUuid: 'project-1',
            documentType: 1,
          },
        };
      }
      if (method === 'schematic.getPrimitiveSnapshot') return structuredClone(snapshot);
      if (method === 'schematic.deletePrimitive') return { deleted: ['wire-1'], notFound: [] };
      throw new Error(`Unexpected native bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });
    expect(pageReads).toBeGreaterThan(4);
    expect(result).toMatchObject({
      success: false,
      committed: false,
      error_code: 'TRANSACTION_OPERATION_FAILED',
    });
    // The transaction is reserved by this point. Since focus changed, the
    // manager conservatively reports an unresolved compensation rather than
    // claiming a safe rollback against the wrong page.
    expect(result?.transaction_state).toBe('failed');
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('refuses a batch delete when native project/page readers are absent', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        };
      }
      throw new Error('Native scope reader unavailable');
    });
    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });
    expect(result).toMatchObject({
      success: false,
      committed: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('rejects a native snapshot mutated while binding the focused schematic page', async () => {
    const shared = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-1',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    };
    let snapshotReads = 0;
    let documentReads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read' && params.path === 'DMT_Project.getCurrentProjectInfo')
        return { result: { uuid: 'project-1' } };
      if (method === 'api.read' && params.path === 'DMT_SelectControl.getCurrentDocumentInfo') {
        documentReads++;
        if (documentReads === 2) shared.property.net = 'N2';
        return { result: { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 } };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        snapshotReads++;
        return shared;
      }
      if (method === 'schematic.deletePrimitive')
        return { deleted: params.primitiveIds, notFound: [] };
      throw new Error('Unexpected native bridge method ' + method);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });
    expect(snapshotReads).toBeGreaterThanOrEqual(2);
    expect(documentReads).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      success: false,
      committed: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('keeps an immutable preflight witness when the bridge reuses its snapshot object', async () => {
    const shared = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-1',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    };
    let reads = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'api.read') return verifiedSchematicFocus(method, params);
      if (method === 'schematic.getPrimitiveSnapshot') {
        reads++;
        if (reads === 2) shared.property.net = 'N2';
        return shared;
      }
      if (method === 'schematic.deletePrimitive') {
        return { deleted: params.primitiveIds, notFound: [] };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
      projectId: 'project-1',
      operations: [{ operationId: 'delete-wire', action: 'delete', primitiveId: 'wire-1' }],
      atomic: true,
      dryRun: false,
      confirmWrite: true,
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      success: false,
      committed: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
  });

  it('rejects duplicate delete targets before any native mutation', async () => {
    await expect(
      registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        operations: [
          { operationId: 'first-delete', action: 'delete', primitiveId: 'wire-1' },
          { operationId: 'duplicate-delete', action: 'delete', primitiveId: 'wire-1' },
        ],
        atomic: true,
        dryRun: false,
        confirmWrite: true,
      }),
    ).rejects.toThrow(/only once per atomic batch/);
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it.each([
    ['netflag', { identification: 'Ground', net: 'GND', x: 1, y: 2, rotation: 0, mirror: false }],
    ['netport', { direction: 'IN', net: 'N1', x: 1, y: 2, rotation: 0, mirror: false }],
  ] as const)(
    'keeps unaccepted beta $kind deletion disabled even with a complete descriptor',
    async (kind, property) => {
      bridgeCall.mockResolvedValue({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'marker-1',
        primitiveKind: kind,
        componentType: kind,
        property,
      });
      const result = await registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        operations: [{ operationId: 'delete-marker', action: 'delete', primitiveId: 'marker-1' }],
        atomic: true,
        dryRun: false,
        confirmWrite: true,
      });
      expect(result).toMatchObject({
        success: false,
        error_code: 'TRANSACTION_INVALID_STATE',
        committed: false,
        rolled_back: false,
      });
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.deletePrimitive', expect.anything());
    },
  );

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

  it('never reports a successful batch when its caller transaction expired during a native write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    try {
      const manager = resetGlobalTransactionManagerForTests();
      const transaction = manager.begin({ documentId: 'project-1', ttlMs: 60_000 });
      const wireSnapshot = {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'wire-expired',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      };
      const existing = new Map<string, typeof wireSnapshot>();
      let beginNativeWrite!: () => void;
      let finishNativeWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        beginNativeWrite = resolve;
      });
      const release = new Promise<void>((resolve) => {
        finishNativeWrite = resolve;
      });

      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'system.getStatus') return verifiedDrawingStatus();
        if (method === 'api.read') return verifiedSchematicFocus(method, params);

        if (method === 'schematic.listPrimitiveIds') {
          return {
            inventoryVerified: true,
            primitiveKind: params.primitiveKind,
            primitiveIds: [...existing.keys()],
          };
        }
        if (method === 'schematic.addWire') {
          beginNativeWrite();
          await release;
          existing.set('wire-expired', structuredClone(wireSnapshot));
          return drawingAck('wire-expired');
        }
        if (method === 'schematic.getPrimitiveSnapshot') {
          const value = existing.get(params.primitiveId);
          if (!value) throw primitiveNotFound(params.primitiveId);
          return structuredClone(value);
        }
        if (method === 'schematic.deletePrimitive') {
          existing.delete(params.primitiveIds[0]);
          return { deleted: params.primitiveIds, notFound: [] };
        }
        throw new Error('Unexpected bridge method ' + method);
      });

      const pending = registry.get('easyeda_schematic_batch_write')?.handler(context, {
        projectId: 'project-1',
        transactionId: transaction.id,
        operations: [
          {
            operationId: 'create-expiring-wire',
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
      await started;
      vi.advanceTimersByTime(60_001);
      expect(manager.get(transaction.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
      });
      expect(() => manager.begin({ documentId: 'project-1' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      finishNativeWrite();
      const result = await pending;
      expect(result).toMatchObject({
        success: false,
        transaction_state: 'rolled-back',
        rolled_back: true,
        committed: false,
        error_code: 'TRANSACTION_INVALID_STATE',
      });
      expect(existing.size).toBe(0);
      expect(manager.begin({ documentId: 'project-1' }).state).toBe('active');
    } finally {
      vi.useRealTimers();
    }
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

import { describe, expect, it } from 'vitest';
import {
  applyLayoutAutofix,
  type ApplyLayoutAutofixOptions,
  type LayoutAutofixPreview,
} from '../../../src/layout/autofix.js';
import { TransactionManager } from '../../../src/transactions/manager.js';
import type { TransactionBridgeCaller } from '../../../src/transactions/easyeda.js';
import type { ConnectivityFingerprint } from '../../../src/schematic-model/connectivity-fingerprint.js';

function fingerprint(hash: string): ConnectivityFingerprint {
  return {
    schemaVersion: 1,
    hash,
    normalized: { pinNetMembership: [], wireEndpoints: [], labelsAndPorts: [], noConnects: [] },
  };
}

function preview(overrides: Partial<LayoutAutofixPreview> = {}): LayoutAutofixPreview {
  return {
    mode: 'preview',
    requiresConfirmWrite: true,
    violations: [],
    moves: [
      {
        id: 'move-1',
        primitiveId: 'prim-1',
        primitiveType: 'component',
        property: 'position',
        from: { x: 0, y: 0 },
        to: { x: 10, y: 10 },
        reason: 'test violation',
        expectedQaImprovement: 'test',
        resolvesViolationIds: [],
      },
    ],
    report: { fixed: [], skipped: [], remaining: [] },
    allowlist: { primitiveTypes: ['component'], properties: ['position'] },
    ...overrides,
  };
}

function fakeBridge(snapshots: Map<string, { primitiveId: string; property: unknown }>): {
  bridge: TransactionBridgeCaller;
  modifyCalls: () => number;
  restoreCalls: () => number;
} {
  let modifyCalls = 0;
  let restoreCalls = 0;
  const bridge: TransactionBridgeCaller = {
    call: async <TParams, TResult>(method: string, params?: TParams): Promise<TResult> => {
      const input = params as Record<string, unknown>;
      if (method === 'schematic.getPrimitiveSnapshot') {
        const id = input.primitiveId as string;
        const snapshot = snapshots.get(id);
        if (!snapshot) throw new Error(`no snapshot for ${id}`);
        return snapshot as TResult;
      }
      if (method === 'schematic.modifyPrimitive') {
        modifyCalls += 1;
        const id = input.primitiveId as string;
        snapshots.set(id, { primitiveId: id, property: input.property });
        return { success: true } as TResult;
      }
      if (method === 'schematic.restorePrimitiveSnapshot') {
        restoreCalls += 1;
        const snapshot = input.snapshot as { primitiveId: string; property: unknown };
        snapshots.set(snapshot.primitiveId, snapshot);
        return { success: true } as TResult;
      }
      throw new Error(`unexpected bridge call ${method}`);
    },
  };
  return { bridge, modifyCalls: () => modifyCalls, restoreCalls: () => restoreCalls };
}

function baseOptions(
  overrides: Partial<ApplyLayoutAutofixOptions> = {},
): ApplyLayoutAutofixOptions {
  return {
    confirmWrite: true,
    documentId: 'doc-1',
    transactionManager: new TransactionManager(),
    bridge: overrides.bridge as TransactionBridgeCaller,
    readConnectivity: async () => fingerprint('stable'),
    stableRead: { attempts: 2, delayMs: 0 },
    ...overrides,
  };
}

describe('applyLayoutAutofix', () => {
  it('applies the batch, commits the transaction, and writes through the bridge', async () => {
    const snapshots = new Map([['prim-1', { primitiveId: 'prim-1', property: { position: { x: 0, y: 0 } } }]]);
    const { bridge, modifyCalls } = fakeBridge(snapshots);

    const result = await applyLayoutAutofix(
      preview(),
      baseOptions({
        bridge,
        readConnectivity: async () => fingerprint('stable'),
      }),
    );

    expect(result.applied).toBe(true);
    expect(result.transaction?.state).toBe('committed');
    expect(result.batchesVerified).toBe(1);
    expect(modifyCalls()).toBe(1);
    expect(snapshots.get('prim-1')?.property).toEqual({ position: { x: 10, y: 10 } });
  });

  it('rolls back every applied operation when connectivity drifts after a batch', async () => {
    const snapshots = new Map([['prim-1', { primitiveId: 'prim-1', property: { position: { x: 0, y: 0 } } }]]);
    const { bridge, restoreCalls } = fakeBridge(snapshots);

    let readCalls = 0;
    const readConnectivity = async () => {
      readCalls += 1;
      // First 2 calls (the "before" stability read) return a stable hash; every
      // call after the batch applies returns a different-but-mutually-stable hash,
      // simulating an unintended electrical change caused by the cosmetic move.
      return fingerprint(readCalls <= 2 ? 'before' : 'after-changed');
    };

    await expect(
      applyLayoutAutofix(preview(), baseOptions({ bridge, readConnectivity })),
    ).rejects.toMatchObject({
      name: 'LayoutAutofixConnectivityError',
      result: { applied: false, connectivityDiff: { equal: false } },
    });

    expect(restoreCalls()).toBe(1);
    expect(snapshots.get('prim-1')?.property).toEqual({ position: { x: 0, y: 0 } });
  });

  it('compensates and rolls back when a bridge write fails mid-batch', async () => {
    const snapshots = new Map([['prim-1', { primitiveId: 'prim-1', property: { position: { x: 0, y: 0 } } }]]);
    const bridge: TransactionBridgeCaller = {
      call: async <TParams, TResult>(method: string, params?: TParams): Promise<TResult> => {
        const input = params as Record<string, unknown>;
        if (method === 'schematic.getPrimitiveSnapshot') {
          return snapshots.get(input.primitiveId as string) as TResult;
        }
        if (method === 'schematic.modifyPrimitive') {
          throw new Error('bridge write failed');
        }
        if (method === 'schematic.restorePrimitiveSnapshot') {
          const snapshot = input.snapshot as { primitiveId: string; property: unknown };
          snapshots.set(snapshot.primitiveId, snapshot);
          return { success: true } as TResult;
        }
        throw new Error(`unexpected bridge call ${method}`);
      },
    };

    await expect(
      applyLayoutAutofix(
        preview(),
        baseOptions({ bridge, readConnectivity: async () => fingerprint('stable') }),
      ),
    ).rejects.toMatchObject({
      name: 'LayoutAutofixConnectivityError',
      result: { applied: false },
    });

    expect(snapshots.get('prim-1')?.property).toEqual({ position: { x: 0, y: 0 } });
  });
});

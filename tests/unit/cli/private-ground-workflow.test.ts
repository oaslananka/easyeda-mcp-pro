import { describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
// @ts-expect-error Internal bundled JavaScript workflow.
import {
  createGroundWorkflow,
  runInteractiveGround,
} from '../../../scripts/private-ground/interactive.mjs';
// @ts-expect-error Internal bundled JavaScript session boundary.
import { createGroundSession } from '../../../scripts/private-ground/host-session.mjs';

function fixture() {
  const before = {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId: 'old',
    primitiveKind: 'netflag',
    property: { identification: 'Ground', net: 'GND' },
    nativeIsolation: {
      kind: 'verified-disconnected-ground/v2',
      markerId: 'old',
      attributeFingerprint: 'a'.repeat(64),
    },
  };
  const after = {
    ...before,
    primitiveId: 'new',
    nativeIsolation: { ...before.nativeIsolation, markerId: 'new' },
  };
  const survivorState = { sheetId: null, attributes: [] };
  const baseline = {
    projectId: 'project',
    markerId: 'old',
    groundProfile: { sheetCount: 0 },
    snapshot: before,
    survivors: structuredClone(survivorState),
  };
  const adapter = {
    invoke: vi.fn(async (method: string) => {
      if (method === 'inventory') return { components: [], attributeCount: 0 };
      if (method === 'privateGround.survivors') return structuredClone(survivorState);
      return true;
    }),
  };
  const bridge = {
    preflight: vi.fn(async () => before),
    call: vi.fn(async (_method: string, params: { primitiveId: string }) =>
      params.primitiveId === 'old' ? before : after,
    ),
  };
  const tool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'easyeda_schematic_batch_write')
      return args.dryRun ? { dry_run: true } : { committed: false, transaction_state: 'active' };
    if (name === 'easyeda_project_begin_transaction') return { transaction: { id: 'tx' } };
    if (name === 'easyeda_project_validate_transaction')
      return {
        transaction: {
          id: 'tx',
          state: 'validated',
          operations: [{ kind: 'delete', state: 'applied' }],
        },
      };
    if (name === 'easyeda_project_commit_transaction')
      return {
        transaction: {
          id: 'tx',
          state: 'committed',
          operations: [{ kind: 'delete', state: 'applied' }],
        },
      };
    if (name === 'easyeda_project_rollback_transaction')
      return {
        transaction: {
          id: 'tx',
          state: 'rolled-back',
          rollback_complete: true,
          operations: [{ restored_target_id: 'new' }],
        },
      };
    throw new Error('Unexpected tool');
  });
  const context = { adapter, baseline, bridge, tool };
  return { ...context, before, after, context, workflow: createGroundWorkflow(context) };
}

async function throughDelete(workflow: ReturnType<typeof createGroundWorkflow>) {
  for (const name of ['preview', 'begin', 'delete'])
    expect((await workflow.call(name)).success).toBe(true);
}

describe('interactive private Ground workflow', () => {
  it('requires preview, scopes the real transaction calls, and stages only after verified rollback', async () => {
    const f = fixture();
    for (const action of ['begin', 'delete', 'rollback', 'publish', '__proto__'])
      expect((await f.workflow.call(action)).success).toBe(false);
    expect(f.tool).not.toHaveBeenCalled();
    expect(await f.workflow.call('inspect')).toMatchObject({
      success: true,
      present: true,
      snapshot: f.before,
    });
    await throughDelete(f.workflow);
    expect(await f.workflow.call('inspect')).toMatchObject({
      success: true,
      phase: 'deleted',
      present: false,
    });
    expect(await f.workflow.call('publish')).toMatchObject({ success: false });
    expect(await f.workflow.call('delete')).toMatchObject({ success: false });
    expect(await f.workflow.call('rollback')).toMatchObject({
      success: true,
      phase: 'restored',
      restoredId: 'new',
      published: false,
    });
    expect(f.adapter.invoke).not.toHaveBeenCalledWith('schematic.save');
    const result = await f.workflow.call('publish');
    expect(result).toMatchObject({ success: true, phase: 'staged', save: true, after: f.after });
    expect(f.adapter.invoke).toHaveBeenCalledWith('schematic.save');
    expect(await f.workflow.call('publish')).toMatchObject({ success: false });
    expect(f.tool).toHaveBeenCalledTimes(4);
    expect(f.tool).toHaveBeenNthCalledWith(
      1,
      'easyeda_schematic_batch_write',
      expect.objectContaining({ projectId: 'project', dryRun: true, confirmWrite: true }),
    );
    expect(f.tool).toHaveBeenNthCalledWith(2, 'easyeda_project_begin_transaction', {
      projectId: 'project',
      maxOperations: 1,
      ttlSeconds: 600,
    });
    expect(f.tool).toHaveBeenNthCalledWith(
      3,
      'easyeda_schematic_batch_write',
      expect.objectContaining({
        transactionId: 'tx',
        operations: [{ operationId: 'delete-ground', action: 'delete', primitiveId: 'old' }],
      }),
    );
    expect(f.tool).toHaveBeenNthCalledWith(4, 'easyeda_project_rollback_transaction', {
      transactionId: 'tx',
      confirmWrite: true,
    });
  });
  it('publishes a committed Ground deletion only from the verified private copy', async () => {
    const f = fixture();
    expect(await f.workflow.call('publish_delete')).toMatchObject({ success: false });
    await throughDelete(f.workflow);
    const staged = await f.workflow.call('publish_delete');
    expect(staged).toMatchObject({
      success: true,
      phase: 'staged',
      mode: 'deletion',
      deletedId: 'old',
      save: true,
      transaction: { state: 'committed' },
      survivors: f.baseline.survivors,
    });
    expect(f.tool).toHaveBeenNthCalledWith(4, 'easyeda_project_validate_transaction', {
      transactionId: 'tx',
      expectedOperationCount: 1,
      requireAppliedOperations: true,
      requireBridgeConnected: true,
    });
    expect(f.tool).toHaveBeenNthCalledWith(5, 'easyeda_project_commit_transaction', {
      transactionId: 'tx',
      confirmWrite: true,
    });
    expect(f.adapter.invoke).toHaveBeenCalledWith('privateGround.survivors');
    expect(f.adapter.invoke).toHaveBeenCalledWith('schematic.saveDeleted');
    expect(await f.workflow.call('rollback')).toMatchObject({ success: false });
    expect(await f.workflow.call('publish')).toMatchObject({ success: false });
  });

  it('fails closed if surviving native sheet attributes drift before deletion publication', async () => {
    const f = fixture();
    await throughDelete(f.workflow);
    f.adapter.invoke.mockImplementation(async (method: string) => {
      if (method === 'privateGround.survivors') {
        return { sheetId: 'unexpected', attributes: [['new', 'unverified']] };
      }
      throw new Error('Unexpected native invocation');
    });
    await expect(f.workflow.call('publish_delete')).rejects.toThrow('Surviving');
    expect(f.tool).toHaveBeenCalledTimes(3);
    expect(await f.workflow.call('publish_delete')).toMatchObject({
      success: false,
      phase: 'poisoned',
    });
  });

  it('does not stage a deletion if native save or source confirmation fails', async () => {
    const f = fixture();
    await throughDelete(f.workflow);
    f.adapter.invoke.mockImplementation(async (method: string) => {
      if (method === 'privateGround.survivors') return structuredClone(f.baseline.survivors);
      if (method === 'schematic.saveDeleted') return false;
      throw new Error('Unexpected native method');
    });
    await expect(f.workflow.call('publish_delete')).rejects.toThrow('save');
    expect(await f.workflow.call('publish_delete')).toMatchObject({
      success: false,
      phase: 'poisoned',
    });
  });

  it('poisons on uncertain deletion without retry or publication', async () => {
    const f = fixture();
    await f.workflow.call('preview');
    await f.workflow.call('begin');
    f.tool.mockRejectedValueOnce(new Error('Native outcome unknown'));
    await expect(f.workflow.call('delete')).rejects.toThrow('Native outcome unknown');
    for (const action of ['delete', 'rollback', 'publish', 'inspect'])
      expect(await f.workflow.call(action)).toMatchObject({ success: false, phase: 'poisoned' });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('refuses a rollback whose new marker differs from the baseline', async () => {
    const f = fixture();
    await throughDelete(f.workflow);
    f.bridge.call.mockResolvedValueOnce({
      ...f.after,
      property: { ...f.after.property, net: 'VCC' },
    });
    await expect(f.workflow.call('rollback')).rejects.toThrow('Restored marker differs');
    expect(await f.workflow.call('publish')).toMatchObject({ success: false });
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('discards on EOF before publish without saving', async () => {
    const f = fixture();
    const replies: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        replies.push(chunk.toString());
        callback();
      },
    });
    const input = Readable.from([
      '{"action":"preview"}\n',
      '{"action":"begin"}\n',
      '{"action":"delete"}\n',
    ]);
    await expect(runInteractiveGround(f.context, input, output)).rejects.toThrow(
      'discard private copy',
    );
    expect(replies.map((x) => JSON.parse(x).result.phase)).toEqual([
      'previewed',
      'active',
      'deleted',
    ]);
    expect(f.adapter.invoke).not.toHaveBeenCalled();
  });
  it('does not claim publication in the internal protocol before independent cold reopen', async () => {
    const f = fixture();
    const replies: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        replies.push(chunk.toString());
        callback();
      },
    });
    const input = Readable.from(
      ['preview', 'begin', 'delete', 'rollback', 'publish'].map(
        (action) => JSON.stringify({ action }) + '\n',
      ),
    );
    await expect(runInteractiveGround(f.context, input, output)).resolves.toMatchObject({
      phase: 'staged',
      save: true,
    });
    expect(replies.map((x) => JSON.parse(x).result.phase)).toEqual([
      'previewed',
      'active',
      'deleted',
      'restored',
    ]);
  });
});

describe('external private Ground session lifecycle', () => {
  it('does not start before the first call and refuses overlapping calls', async () => {
    let resolve!: (value: unknown) => void;
    const worker = {
      call: vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      stop: vi.fn(),
    };
    const start = vi.fn(() => worker);
    const session = createGroundSession(start);
    expect(start).not.toHaveBeenCalled();
    const pending = session.call('inspect');
    expect(await session.call('delete')).toMatchObject({ success: false });
    resolve({ success: true, phase: 'ready' });
    expect(await pending).toMatchObject({ success: true });
    session.stop();
    session.stop();
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(await session.call('inspect')).toMatchObject({ success: false });
  });
  it('closes on publication success without another worker', async () => {
    const worker = {
      call: vi.fn(async () => ({ success: true, coldReopenVerified: true })),
      stop: vi.fn(),
    };
    const start = vi.fn(() => worker);
    const session = createGroundSession(start);
    expect(await session.call('publish')).toMatchObject({ success: true });
    expect(await session.call('inspect')).toMatchObject({ success: false });
    expect(start).toHaveBeenCalledTimes(1);
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight action and closes without waiting for the operation timeout', async () => {
    const worker = { call: vi.fn(() => new Promise(() => {})), stop: vi.fn() };
    const session = createGroundSession(() => worker);
    const controller = new AbortController();
    const pending = session.call('delete', controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ success: false });
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(await session.call('publish')).toMatchObject({ success: false });
  });

  it('fails closed on timeout without retry', async () => {
    const worker = { call: vi.fn(() => new Promise(() => {})), stop: vi.fn() };
    const session = createGroundSession(() => worker, 5);
    expect(await session.call('delete')).toMatchObject({ success: false });
    expect(await session.call('delete')).toMatchObject({ success: false });
    expect(worker.call).toHaveBeenCalledTimes(1);
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });
});

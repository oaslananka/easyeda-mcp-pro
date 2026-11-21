// This is an internal, single-project workflow. No caller-supplied native RPCs,
// snapshots, transaction IDs, paths, or project identifiers cross this boundary.
import { createInterface } from 'node:readline';
import { snapshotForHash, stableHash } from '../../src/transactions/stable.ts';

const hash = (snapshot) => stableHash(snapshotForHash(snapshot, 'ignore-primitive-id'));
const batch = 'easyeda_schematic_batch_write';

export function createGroundWorkflow({ adapter, baseline, bridge, tool }) {
  let phase = 'ready';
  let transactionId;
  let proof;
  let busy = false;
  const base = {
    projectId: baseline.projectId,
    operations: [
      { operationId: 'delete-ground', action: 'delete', primitiveId: baseline.markerId },
    ],
    atomic: true,
    confirmWrite: true,
  };
  const allowed = {
    inspect: ['ready', 'previewed', 'active', 'deleted', 'restored'],
    preview: ['ready', 'previewed'],
    begin: ['previewed'],
    delete: ['active'],
    rollback: ['deleted'],
    publish: ['restored'],
  };
  async function inspect() {
    if (phase === 'deleted') {
      const inventory = await adapter.invoke('inventory');
      if (
        inventory.components.length !== baseline.groundProfile.sheetCount ||
        inventory.components.some((row) => row.kind !== 'sheet') ||
        inventory.attributeCount !== (baseline.groundProfile.sheetCount === 0 ? 0 : 29)
      )
        throw new Error('Deleted Ground inventory changed');
      return { present: false, primitiveId: baseline.markerId, transactionId };
    }
    const primitiveId = proof?.restoredId ?? baseline.markerId;
    const snapshot = await bridge.call('schematic.getPrimitiveSnapshot', {
      primitiveId,
      expectedPrimitiveKind: 'netflag',
    });
    if (hash(snapshot) !== hash(baseline.snapshot)) throw new Error('Native Ground changed');
    return { present: true, snapshot, transactionId };
  }
  async function preview() {
    const plan = await tool(batch, { ...base, dryRun: true });
    if (plan.dry_run !== true) throw new Error('Native preview not confirmed');
    phase = 'previewed';
    return { plan };
  }
  async function begin() {
    const before = await bridge.preflight(baseline.projectId, baseline.markerId);
    if (hash(before) !== hash(baseline.snapshot)) throw new Error('Native Ground changed');
    const result = await tool('easyeda_project_begin_transaction', {
      projectId: baseline.projectId,
      maxOperations: 1,
      ttlSeconds: 600,
    });
    transactionId = result.transaction?.id;
    if (typeof transactionId !== 'string') throw new Error('Transaction not begun');
    phase = 'active';
    return { transaction: result.transaction };
  }
  async function remove() {
    const result = await tool(batch, { ...base, transactionId });
    if (result.committed !== false || result.transaction_state !== 'active')
      throw new Error('Native deletion not tracked');
    phase = 'deleted';
    return { transactionId, present: false, batch: result };
  }
  async function rollback() {
    const result = await tool('easyeda_project_rollback_transaction', {
      transactionId,
      confirmWrite: true,
    });
    const transaction = result.transaction;
    const restoredId = transaction?.operations?.[0]?.restored_target_id;
    if (
      transaction?.state !== 'rolled-back' ||
      transaction?.rollback_complete !== true ||
      typeof restoredId !== 'string' ||
      restoredId === baseline.markerId
    )
      throw new Error('Rollback not verified');
    const after = await bridge.call('schematic.getPrimitiveSnapshot', {
      primitiveId: restoredId,
      expectedPrimitiveKind: 'netflag',
    });
    if (hash(after) !== hash(baseline.snapshot)) throw new Error('Restored marker differs');
    proof = { before: baseline.snapshot, after, restoredId, transaction };
    phase = 'restored';
    return { transaction, restoredId, snapshot: after, published: false };
  }
  async function publish() {
    const current = await bridge.call('schematic.getPrimitiveSnapshot', {
      primitiveId: proof.restoredId,
      expectedPrimitiveKind: 'netflag',
    });
    if (stableHash(current) !== stableHash(proof.after)) throw new Error('Restored marker changed');
    if ((await adapter.invoke('schematic.save')) !== true)
      throw new Error('Native save not acknowledged');
    phase = 'staged';
    return { ...proof, save: true };
  }
  const actions = { inspect, preview, begin, delete: remove, rollback, publish };
  return {
    async call(action) {
      if (busy || !Object.hasOwn(allowed, action) || !allowed[action].includes(phase)) {
        return {
          success: false,
          phase,
          error: 'Operation unavailable in the current session phase',
        };
      }
      busy = true;
      try {
        const result = await actions[action]();
        return { success: true, phase, ...result };
      } catch (error) {
        phase = 'poisoned';
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}

export async function runInteractiveGround(
  context,
  input = process.stdin,
  output = process.stdout,
) {
  const workflow = createGroundWorkflow(context);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 4096) throw new Error('Private request exceeds limit');
      const request = JSON.parse(line);
      if (!request || Object.keys(request).length !== 1 || typeof request.action !== 'string')
        throw new Error('Invalid private request');
      const result = await workflow.call(request.action);
      // The host, not the worker, will answer publish after separate cold reopen.
      if (request.action === 'publish' && result.phase === 'staged') return result;
      output.write(JSON.stringify({ action: request.action, result }) + '\n');
    }
    throw new Error('MCP connection closed before publish; discard private copy');
  } finally {
    lines.close();
  }
}

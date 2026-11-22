import { runInteractiveGround } from './interactive.mjs';
import { PrivateNativeGroundSession } from '../../src/bridge/private-native-ground-session.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { registerSchematicBatchTools } from '../../src/tools/L1_schematic_batch.ts';
import { registerTransactionTools } from '../../src/tools/L1_transactions.ts';
import { EnvSchema } from '../../src/config/env.ts';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { stableHash, snapshotForHash } from '../../src/transactions/stable.ts';

const execFileAsync = promisify(execFile);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const markerHash = (snapshot) => stableHash(snapshotForHash(snapshot, 'ignore-primitive-id'));

async function cli(args, timeout = 65000) {
  const { stdout } = await execFileAsync('/vendor/easyeda-pro', [...args, '--no-sandbox'], {
    timeout,
    shell: false,
    maxBuffer: 2 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  if (response.ok !== true) throw new Error('Native CLI did not confirm the request');
  return response.value;
}

function boundGroundScope(b) {
  const profile = b?.groundProfile;
  if (
    !b?.projectId ||
    !b?.pageId ||
    !b?.markerId ||
    !profile ||
    !/^[0-9a-f]{16}$/.test(profile.deviceUuid) ||
    !/^[0-9a-f]{16}$/.test(profile.symbolUuid) ||
    profile.deviceUuid === profile.symbolUuid ||
    ![0, 1].includes(profile.sheetCount)
  )
    throw new Error('Native Ground scope unavailable');
  return { projectId: b.projectId, pageId: b.pageId, markerId: b.markerId, groundProfile: profile };
}

async function readSourceEvidence(value, profile) {
  if (!value?.archive || !value?.systemArchive)
    throw new Error('Native Ground archives unavailable');
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/python3',
      [
        '/launch/archive-evidence.py',
        profile.deviceUuid,
        profile.symbolUuid,
        value.archive,
        value.systemArchive,
      ],
      { timeout: 10000, maxBuffer: 65536, shell: false },
    );
    return { ...JSON.parse(stdout), systemDevice: value.systemDevice };
  } catch {
    // execFile errors include the complete argument list. Never emit native archive data.
    throw new Error('Native Ground archive proof refused');
  }
}

async function verifyBootstrap(invoke, b, profile) {
  const evidence = await invoke('privateGround.getRecreationDevice');
  if (
    !evidence?.geometryFingerprint ||
    evidence.projectDeviceUuid !== profile.deviceUuid ||
    evidence.projectSymbolUuid !== profile.symbolUuid
  )
    throw new Error('Native Ground library proof unavailable');
  const snapshot = await invoke('schematic.getPrimitiveSnapshot', { primitiveId: b.markerId });
  if (
    snapshot?.nativeIsolation?.kind !== 'verified-disconnected-ground/v2' ||
    snapshot.nativeContext?.projectId !== b.projectId ||
    snapshot.nativeContext?.documentId !== b.pageId
  )
    throw new Error('Verified native Ground snapshot unavailable');
  return snapshot;
}

function createAdapter(sessionId) {
  const template = readFileSync('/launch/native-rpc.txt', 'utf8');
  const source = readFileSync('/launch/native-transaction.js', 'utf8');
  let scope = {};
  let index = 0;
  const listSessions = () => cli(['session', 'list'], 15000);
  const assertSession = async () => {
    const sessions = await listSessions();
    if (!Array.isArray(sessions)) throw new Error('Native session inventory unavailable');
    const projects = sessions.filter((s) => s.path !== null);
    const session = projects[0];
    if (
      projects.length !== 1 ||
      session?.sessionId !== sessionId ||
      session?.path !== '/workspace/WORKING.eprj2' ||
      session?.headless !== true ||
      session?.origin !== 'cli' ||
      session?.status !== 'alive'
    )
      throw new Error('Native session ownership changed');
  };
  async function invoke(method, params = {}) {
    await assertSession();
    const file = '/tmp/native-rpc-' + ++index + '.mjs';
    writeFileSync(
      file,
      template
        .replace('__NATIVE_BUNDLE__', () => source)
        .replace('__NATIVE_REQUEST__', () => JSON.stringify({ method, params, scope })),
      { mode: 0o600, flag: 'wx' },
    );
    try {
      const value = await cli([
        'invoke',
        '--session',
        sessionId,
        '--ext-uuid',
        'eda',
        '--code-file',
        file,
        '--timeout',
        '50000',
      ]);
      await assertSession();
      if (value?.error) {
        const code = String(value.error.code);
        // The transaction engine distinguishes verified absence from an
        // ambiguous native failure by this exact structured error code.
        throw Object.assign(new Error('Native operation refused: ' + code), { code });
      }
      if (method === 'privateGround.getRecreationDevice')
        return readSourceEvidence(value?.result, scope.groundProfile);
      return value?.result;
    } finally {
      unlinkSync(file);
    }
  }
  return {
    invoke,
    listSessions,
    bootstrap: async () => {
      const b = await invoke('bootstrap');
      scope = boundGroundScope(b);
      const profile = scope.groundProfile;
      const snapshot = await verifyBootstrap(invoke, b, profile);
      const survivors = await invoke('privateGround.survivors');
      if (!survivors || typeof survivors !== 'object') {
        throw new Error('Private native surviving sheet state unavailable');
      }
      return { ...scope, snapshot, survivors };
    },
    bootstrapDeleted: async (expected) => {
      const proof = await invoke('privateGround.bootstrapDeleted', { expected });
      if (
        proof?.deleted !== true ||
        proof.projectId !== expected.projectId ||
        proof.pageId !== expected.pageId ||
        stableHash(proof.survivors) !== stableHash(expected.survivors)
      ) {
        throw new Error('Native cold deleted-state proof differs');
      }
      return proof;
    },
  };
}

async function transact(adapter, baseline, sessionId, interactive = false) {
  const bridge = new PrivateNativeGroundSession({
    ...adapter,
    ...baseline,
    sessionId,
    path: '/workspace/WORKING.eprj2',
  });
  const registry = new ToolRegistry();
  const config = EnvSchema.parse({ NODE_ENV: 'test' });
  registerSchematicBatchTools(registry, config);
  registerTransactionTools(registry, config);
  const server = new McpServer({ name: 'easyeda-private-ground', version: '1.0.0' });
  registry.registerAllOnServer(server, {
    profile: 'core',
    bridge,
    config: { bridgeTimeoutMs: 65000, artifactDir: '/tmp', bridgeHost: '127.0.0.1', bridgePort: 0 },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  });
  const client = new Client({ name: 'private-ground-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const tool = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 120000 });
    if (response.isError || !response.structuredContent?.success)
      throw new Error(
        'MCP operation refused: ' +
          name +
          ' ' +
          JSON.stringify(response.structuredContent ?? response.content).slice(0, 600),
      );
    return response.structuredContent;
  };
  try {
    const context = { adapter, baseline, bridge, tool };
    return await (interactive ? runInteractiveGround(context) : runTransaction(context));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function runTransaction({ adapter, baseline, bridge, tool }) {
  const name = 'easyeda_schematic_batch_write';
  const base = {
    projectId: baseline.projectId,
    operations: [
      { operationId: 'delete-ground', action: 'delete', primitiveId: baseline.markerId },
    ],
    atomic: true,
    confirmWrite: true,
  };
  const plan = await tool(name, { ...base, dryRun: true });
  if (plan.dry_run !== true) throw new Error('Read-only preview not confirmed');
  const before = await bridge.preflight(baseline.projectId, baseline.markerId);
  if (markerHash(before) !== markerHash(baseline.snapshot))
    throw new Error('Initial Ground changed');
  const begin = await tool('easyeda_project_begin_transaction', {
    projectId: baseline.projectId,
    maxOperations: 1,
  });
  const transactionId = begin.transaction?.id;
  if (typeof transactionId !== 'string') throw new Error('Transaction not begun');
  const applied = await tool(name, { ...base, transactionId });
  if (applied.committed !== false || applied.transaction_state !== 'active')
    throw new Error('Ground deletion not tracked');
  return verifyRollback({ adapter, baseline, bridge, tool, before, transactionId });
}

async function verifyRollback({ adapter, baseline, bridge, tool, before, transactionId }) {
  const rollback = await tool('easyeda_project_rollback_transaction', {
    transactionId,
    confirmWrite: true,
  });
  const transaction = rollback.transaction;
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
  if (markerHash(before) !== markerHash(after)) throw new Error('Restored marker differs');
  if ((await adapter.invoke('schematic.save')) !== true)
    throw new Error('Native save not acknowledged');
  return { before, after, restoredId, transaction, save: true };
}

async function verifyColdDeletion(adapter, result) {
  const operation = result?.transaction?.operations?.[0];
  if (
    ![
      result.mode === 'deletion',
      result.transaction?.state === 'committed',
      result.transaction?.operations?.length === 1,
      operation?.kind === 'delete',
      operation?.state === 'applied',
      result.save === true,
      typeof result.deletedId === 'string',
    ].every(Boolean)
  ) {
    throw new Error('Committed native Ground deletion proof missing');
  }
  const verified = await adapter.bootstrapDeleted(result);
  put('/evidence/cold.json', {
    deleted: true,
    survivors: verified.survivors,
    verified: true,
  });
}

async function main() {
  const [mode, sessionId] = process.argv.slice(2);
  if (!['transaction', 'interactive', 'cold'].includes(mode) || !sessionId)
    throw new Error('Invalid internal worker request');
  const adapter = createAdapter(sessionId);
  if (mode === 'cold') {
    const r = json('/expected.json');
    if (r?.mode === 'deletion') {
      await verifyColdDeletion(adapter, r);
      return;
    }
    const baseline = await adapter.bootstrap();
    if (stableHash(baseline.snapshot) !== stableHash(r.after) || baseline.markerId !== r.restoredId)
      throw new Error('Cold reopen differs from saved rollback');
    put('/evidence/cold.json', { snapshot: baseline.snapshot, verified: true });
    return;
  }
  const baseline = await adapter.bootstrap();
  put(
    '/evidence/result.json',
    await transact(adapter, baseline, sessionId, mode === 'interactive'),
  );
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
});

/**
 * Self-cleaning live smoke for schematic transaction support.
 *
 * Starts one listener, waits for one extension connection, runs create/modify/
 * delete rollback checks sequentially, verifies final document state, removes
 * every disposable primitive, and closes the listener only after the full run.
 * Use a disposable project or a safely saved schematic.
 *
 * Optional: EASYEDA_EXPECTED_DISPATCHER_BUILD=<build-id>
 */
import { BridgeManager } from '../src/bridge/manager.ts';
import { loadEnvConfig } from '../src/config/env.ts';
import { createLogger } from '../src/utils/logger.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { registerBuiltinTools } from '../src/tools/register.ts';
import { stableHash } from '../src/transactions/stable.ts';
import { resetGlobalTransactionManagerForTests } from '../src/transactions/manager.ts';

const EXPECTED_BUILD = process.env.EASYEDA_EXPECTED_DISPATCHER_BUILD?.trim();
const KINDS = ['component', 'wire', 'text', 'rectangle', 'circle', 'polygon'] as const;
type Kind = (typeof KINDS)[number];

const config = loadEnvConfig();
createLogger(config);
const bridge = new BridgeManager(config);

function sortUnknown(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(sortUnknown)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortUnknown(v)]),
    );
  }
  return value;
}

function idsFrom(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const ids = (value as { primitiveIds?: unknown }).primitiveIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').sort() : [];
}

function extractPrimitiveId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractPrimitiveId(item);
      if (id) return id;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['primitiveId', 'primitiveUuid', 'id', 'uuid']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const nested of ['result', 'data', 'text', 'rectangle']) {
    const id = extractPrimitiveId(record[nested]);
    if (id) return id;
  }
  return undefined;
}

function descriptorHash(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return stableHash(snapshot);
  const copy = structuredClone(snapshot as Record<string, unknown>);
  delete copy.primitiveId;
  return stableHash(copy);
}

async function waitConnected(timeoutMs: number): Promise<void> {
  if (bridge.state === 'connected') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`connection timeout; state=${bridge.state}`));
    }, timeoutMs);
    const onConnected = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      bridge.off('connected', onConnected);
    };
    bridge.on('connected', onConnected);
  });
}

async function waitForStableConnection(timeoutMs: number, quietMs = 5_000): Promise<void> {
  await waitConnected(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`stable connection timeout; state=${bridge.state}`));
    }, timeoutMs);
    let quietTimer: NodeJS.Timeout;
    const armQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (bridge.state !== 'connected') {
          armQuietTimer();
          return;
        }
        cleanup();
        resolve();
      }, quietMs);
    };
    const onConnected = () => armQuietTimer();
    const onDisconnected = () => armQuietTimer();
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      bridge.off('connected', onConnected);
      bridge.off('disconnected', onDisconnected);
    };
    bridge.on('connected', onConnected);
    bridge.on('disconnected', onDisconnected);
    armQuietTimer();
  });
}

async function inventory(kind: Kind): Promise<string[]> {
  return idsFrom(await bridge.call('schematic.listPrimitiveIds', { primitiveKind: kind }));
}

async function allInventories(): Promise<Record<Kind, string[]>> {
  const entries: Array<readonly [Kind, string[]]> = [];
  for (const kind of KINDS) {
    entries.push([kind, await inventory(kind)] as const);
  }
  return Object.fromEntries(entries) as Record<Kind, string[]>;
}

async function requireFocusedStableSchematic(timeoutMs = 300_000): Promise<{
  schematicInfo: unknown;
  pageInfo: unknown;
  inventories: Record<Kind, string[]>;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'schematic information is unavailable';

  while (Date.now() < deadline) {
    try {
      const schematicInfoResponse = (await bridge.call('api.call', {
        path: 'DMT_Schematic.getCurrentSchematicInfo',
        args: [],
      })) as { result?: unknown };
      const pageInfoResponse = (await bridge.call('api.call', {
        path: 'DMT_Schematic.getCurrentSchematicPageInfo',
        args: [],
      })) as { result?: unknown };
      const schematicInfo = schematicInfoResponse?.result;
      const pageInfo = pageInfoResponse?.result;
      if (!schematicInfo || !pageInfo) {
        lastReason = 'a schematic document and page are not focused';
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      let previous = await allInventories();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const current = await allInventories();
        if (stableHash(previous) === stableHash(current)) {
          return { schematicInfo, pageInfo, inventories: current };
        }
        previous = current;
      }
      lastReason = 'schematic primitive inventory is still changing';
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `SAFETY_PRECONDITION_FAILED: no focused, stable schematic became available within ${timeoutMs}ms (${lastReason}).`,
  );
}

async function stateDigest() {
  const inventories = await allInventories();
  const components = await bridge.call('schematic.listComponents', {
    projectId: 'active',
    limit: 500,
    offset: 0,
  });
  const nets = await bridge.call('schematic.listNets', { projectId: 'active' });
  let erc: unknown;
  let ercAvailable = true;
  let ercError: string | undefined;
  try {
    erc = await bridge.call('design.erc', {});
  } catch (error) {
    ercAvailable = false;
    ercError = error instanceof Error ? error.message : String(error);
  }
  return {
    inventories,
    componentHash: stableHash(sortUnknown(components)),
    netHash: stableHash(sortUnknown(nets)),
    ercHash: ercAvailable ? stableHash(sortUnknown(erc)) : undefined,
    ercAvailable,
    ercError,
    components,
    nets,
    erc,
  };
}

function unwrapApiCallResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return 'result' in record ? record.result : value;
}

function readNormalizedState(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const stateRecord = state as Record<string, unknown>;
    if (key in stateRecord) return stateRecord[key];
    const lower = key.length > 0 ? key[0]!.toLowerCase() + key.slice(1) : key;
    if (lower in stateRecord) return stateRecord[lower];
  }
  if (key in record) return record[key];
  const lower = key.length > 0 ? key[0]!.toLowerCase() + key.slice(1) : key;
  return record[lower];
}

async function readTextCleanupDescriptor(id: string): Promise<{
  primitiveId: string;
  content?: string;
  x?: number;
  y?: number;
} | null> {
  try {
    const response = await bridge.call('api.call', {
      path: 'SCH_PrimitiveText.get',
      args: [id],
    });
    const current = unwrapApiCallResult(response);
    if (!current || typeof current !== 'object') return null;
    const primitiveId = readNormalizedState(current, 'PrimitiveId');
    if (typeof primitiveId === 'string' && primitiveId && primitiveId !== id) return null;
    const content = readNormalizedState(current, 'Content');
    const x = readNormalizedState(current, 'X');
    const rawY = readNormalizedState(current, 'Y');
    return {
      primitiveId: id,
      content: typeof content === 'string' ? content : undefined,
      x: typeof x === 'number' ? x : undefined,
      y: typeof rawY === 'number' ? -rawY : undefined,
    };
  } catch {
    return null;
  }
}

function isKnownSmokeTextDescriptor(descriptor: {
  content?: string;
  x?: number;
  y?: number;
}): boolean {
  const { content, x, y } = descriptor;
  return (
    typeof content === 'string' &&
    (/^MCP_CREATE_ROLLBACK_\d+$/.test(content) ||
      /^MCP_MODIFY_BASE_\d+$/.test(content) ||
      content === 'MCP_MODIFIED_SHOULD_ROLLBACK') &&
    typeof x === 'number' &&
    x >= 5000 &&
    x <= 5250 &&
    y === 5000
  );
}

function isKnownSmokeRectangleDescriptor(value: unknown): value is { primitiveId: string } {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.primitiveId === 'string' &&
    item.primitiveId.length > 0 &&
    item.x === 5100 &&
    item.y === 5100 &&
    item.width === 80 &&
    item.height === 40
  );
}

async function cleanupKnownSmokeArtifacts(): Promise<string[]> {
  const removed: string[] = [];

  for (const id of await inventory('text')) {
    const descriptor = await readTextCleanupDescriptor(id);
    if (!descriptor || !isKnownSmokeTextDescriptor(descriptor)) continue;
    await deletePrimitive(id);
    if ((await inventory('text')).includes(id)) {
      throw new Error(`known smoke text artifact ${id} still exists after delete`);
    }
    removed.push(id);
  }

  const rectangleListing = (await bridge.call('schematic.listRectangles', {})) as {
    items?: unknown[];
  };
  for (const item of Array.isArray(rectangleListing?.items) ? rectangleListing.items : []) {
    if (!isKnownSmokeRectangleDescriptor(item)) continue;
    await deletePrimitive(item.primitiveId);
    if ((await inventory('rectangle')).includes(item.primitiveId)) {
      throw new Error(
        `known smoke rectangle artifact ${item.primitiveId} still exists after delete`,
      );
    }
    removed.push(item.primitiveId);
  }

  return removed;
}

async function deletePrimitive(id: string): Promise<void> {
  await bridge.call('schematic.deletePrimitive', { primitiveIds: [id] });
}

const forcedFailureOperation = {
  operationId: 'forced-runtime-failure',
  action: 'modify',
  primitiveId: '__mcp_missing_primitive_for_rollback_smoke__',
  property: { x: 0 },
} as const;

async function runBatch(tool: any, context: any, operations: unknown[]) {
  resetGlobalTransactionManagerForTests();
  return await tool.handler(context, {
    projectId: 'active',
    atomic: true,
    dryRun: false,
    confirmWrite: true,
    operations,
  });
}

async function createCommittedPrimitive(
  tool: any,
  context: any,
  operation: Record<string, unknown>,
): Promise<{ primitiveId: string; batchResult: any }> {
  const batchResult = await runBatch(tool, context, [operation]);
  const item = Array.isArray(batchResult?.results) ? batchResult.results[0] : undefined;
  const primitiveId = typeof item?.primitive_id === 'string' ? item.primitive_id : undefined;
  if (
    batchResult?.success !== true ||
    batchResult?.committed !== true ||
    item?.status !== 'applied' ||
    !primitiveId
  ) {
    throw new Error(
      `Committed create did not return an applied primitive ID: ${JSON.stringify(batchResult)}`,
    );
  }
  return { primitiveId, batchResult };
}

const cleanupIds = new Set<string>();
const results: Record<string, unknown> = {};

try {
  await bridge.connect();
  await waitForStableConnection(600_000);

  const status = (await bridge.call('system.getStatus', {})) as Record<string, unknown>;
  const buildId = String(
    status.dispatcherBuildId ??
      status.dispatcherBuild ??
      status.dispatcher_build ??
      status.buildId ??
      '',
  );
  const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
  if (EXPECTED_BUILD && buildId !== EXPECTED_BUILD) {
    throw new Error(
      `Unexpected dispatcher build ${buildId || '<missing>'}; expected ${EXPECTED_BUILD}`,
    );
  }
  for (const method of ['schematic.listPrimitiveIds', 'schematic.recreatePrimitiveSnapshot']) {
    if (!capabilities.includes(method)) throw new Error(`Missing live capability ${method}`);
  }

  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  const batch = registry.get('easyeda_schematic_batch_write');
  if (!batch) throw new Error('batch tool not registered');
  const context = {
    profile: 'core',
    bridge: {
      connected: true,
      call: bridge.call.bind(bridge),
      activePort: bridge.activePort,
    },
    config,
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as any;

  await requireFocusedStableSchematic();
  const preflightCleanup = await cleanupKnownSmokeArtifacts();
  const focus = await requireFocusedStableSchematic();
  const baseline = await stateDigest();
  if (stableHash(focus.inventories) !== stableHash(baseline.inventories)) {
    throw new Error(
      'SAFETY_PRECONDITION_FAILED: schematic inventory changed after cleanup and before baseline capture.',
    );
  }
  results.live = {
    buildId,
    preflightCleanup,
    activePort: bridge.activePort,
    capabilitiesChecked: true,
    nativeErcAvailable: baseline.ercAvailable,
    nativeErcError: baseline.ercError,
  };

  // 1) CREATE rollback: text is created, bogus component fails, text must disappear.
  const createBefore = await inventory('text');
  const createResult = await runBatch(batch, context, [
    {
      operationId: 'temporary-text-create',
      action: 'create',
      primitiveKind: 'text',
      x: 5000,
      y: 5000,
      content: `MCP_CREATE_ROLLBACK_${Date.now()}`,
      color: '#000000',
      fontName: 'Arial',
      fontSize: 12,
      alignMode: 3,
    },
    forcedFailureOperation,
  ]);
  const createAfter = await inventory('text');
  const createItems = Array.isArray(createResult.results) ? createResult.results : [];
  results.createRollback = {
    success: createResult.success,
    rolled_back: createResult.rolled_back,
    inventoryRestored: stableHash(createBefore) === stableHash(createAfter),
    firstOperationStatus: createItems[0]?.status,
    failureOperationStatus: createItems[1]?.status,
    transaction_state: createResult.transaction_state,
    error_code: createResult.error_code,
    operationResults: createItems,
  };
  if (
    createResult.success !== false ||
    createResult.rolled_back !== true ||
    createItems[0]?.status !== 'rolled-back' ||
    createItems[1]?.status !== 'failed' ||
    stableHash(createBefore) !== stableHash(createAfter)
  ) {
    throw new Error(`Create rollback smoke failed: ${JSON.stringify(results.createRollback)}`);
  }

  // 2) Successful CREATE+COMMIT, then MODIFY rollback on that isolated text.
  const textSetup = await createCommittedPrimitive(batch, context, {
    operationId: 'temporary-text-setup-create',
    action: 'create',
    primitiveKind: 'text',
    x: 5000,
    y: 5000,
    content: `MCP_MODIFY_BASE_${Date.now()}`,
    rotation: 0,
    color: '#000000',
    fontName: 'Arial',
    fontSize: 12,
    bold: false,
    italic: false,
    underline: false,
    alignMode: 3,
  });
  const textId = textSetup.primitiveId;
  results.createCommitText = {
    success: textSetup.batchResult.success,
    committed: textSetup.batchResult.committed,
    primitiveId: textId,
    operationResults: textSetup.batchResult.results,
  };
  cleanupIds.add(textId);
  const textBefore = await bridge.call('schematic.getPrimitiveSnapshot', {
    primitiveId: textId,
  });
  const modifyResult = await runBatch(batch, context, [
    {
      operationId: 'temporary-text-modify',
      action: 'modify',
      primitiveId: textId,
      property: { x: 5250, content: 'MCP_MODIFIED_SHOULD_ROLLBACK' },
    },
    forcedFailureOperation,
  ]);
  const textAfter = await bridge.call('schematic.getPrimitiveSnapshot', {
    primitiveId: textId,
  });
  results.modifyRollback = {
    success: modifyResult.success,
    rolled_back: modifyResult.rolled_back,
    snapshotRestored: stableHash(textBefore) === stableHash(textAfter),
    transaction_state: modifyResult.transaction_state,
    error_code: modifyResult.error_code,
    operationResults: modifyResult.results,
  };
  if (
    modifyResult.success !== false ||
    modifyResult.rolled_back !== true ||
    stableHash(textBefore) !== stableHash(textAfter)
  ) {
    throw new Error(`Modify rollback smoke failed: ${JSON.stringify(results.modifyRollback)}`);
  }
  await deletePrimitive(textId);
  cleanupIds.delete(textId);

  // 3) Successful CREATE+COMMIT, then DELETE rollback on that isolated rectangle.
  const rectSetup = await createCommittedPrimitive(batch, context, {
    operationId: 'temporary-rectangle-setup-create',
    action: 'create',
    primitiveKind: 'rectangle',
    x: 5100,
    y: 5100,
    width: 80,
    height: 40,
    cornerRadius: 0,
    rotation: 0,
    color: '#000000',
    fillColor: 'none',
    lineWidth: 1,
    lineType: 0,
    fillStyle: 'none',
  });
  const rectId = rectSetup.primitiveId;
  results.createCommitRectangle = {
    success: rectSetup.batchResult.success,
    committed: rectSetup.batchResult.committed,
    primitiveId: rectId,
    operationResults: rectSetup.batchResult.results,
  };
  cleanupIds.add(rectId);
  const rectBefore = await bridge.call('schematic.getPrimitiveSnapshot', {
    primitiveId: rectId,
  });
  const rectInventoryBefore = await inventory('rectangle');
  const deleteResult = await runBatch(batch, context, [
    {
      operationId: 'temporary-rectangle-delete',
      action: 'delete',
      primitiveId: rectId,
    },
    forcedFailureOperation,
  ]);
  const rectInventoryAfter = await inventory('rectangle');
  const oldBaselineRects = new Set(baseline.inventories.rectangle);
  const temporaryCandidates = rectInventoryAfter.filter((id) => !oldBaselineRects.has(id));
  if (temporaryCandidates.length !== 1) {
    throw new Error(
      `Delete rollback recreation reconciliation failed; candidates=${JSON.stringify(temporaryCandidates)}`,
    );
  }
  const recreatedRectId = temporaryCandidates[0]!;
  cleanupIds.delete(rectId);
  cleanupIds.add(recreatedRectId);
  const rectAfter = await bridge.call('schematic.getPrimitiveSnapshot', {
    primitiveId: recreatedRectId,
  });
  results.deleteRollback = {
    success: deleteResult.success,
    rolled_back: deleteResult.rolled_back,
    descriptorRestored: descriptorHash(rectBefore) === descriptorHash(rectAfter),
    originalId: rectId,
    recreatedId: recreatedRectId,
    idChanged: rectId !== recreatedRectId,
    inventoryCountStable: rectInventoryBefore.length === rectInventoryAfter.length,
    transaction_state: deleteResult.transaction_state,
    error_code: deleteResult.error_code,
    operationResults: deleteResult.results,
  };
  if (
    deleteResult.success !== false ||
    deleteResult.rolled_back !== true ||
    descriptorHash(rectBefore) !== descriptorHash(rectAfter) ||
    rectInventoryBefore.length !== rectInventoryAfter.length
  ) {
    throw new Error(`Delete rollback smoke failed: ${JSON.stringify(results.deleteRollback)}`);
  }
  await deletePrimitive(recreatedRectId);
  cleanupIds.delete(recreatedRectId);

  const finalState = await stateDigest();
  const finalComparison = {
    primitiveInventoriesEqual:
      stableHash(baseline.inventories) === stableHash(finalState.inventories),
    componentHashEqual: baseline.componentHash === finalState.componentHash,
    netHashEqual: baseline.netHash === finalState.netHash,
    ercComparable: baseline.ercAvailable && finalState.ercAvailable,
    ercStateEqual:
      !(baseline.ercAvailable && finalState.ercAvailable) ||
      baseline.ercHash === finalState.ercHash,
    baselineErcAvailable: baseline.ercAvailable,
    finalErcAvailable: finalState.ercAvailable,
  };
  results.finalComparison = finalComparison;
  if (
    !finalComparison.primitiveInventoriesEqual ||
    !finalComparison.componentHashEqual ||
    !finalComparison.netHashEqual ||
    !finalComparison.ercStateEqual
  ) {
    throw new Error(`Final state mismatch: ${JSON.stringify(finalComparison)}`);
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  const cleanupErrors: string[] = [];
  for (const id of [...cleanupIds]) {
    try {
      await deletePrimitive(id);
    } catch (cleanupError) {
      cleanupErrors.push(
        `${id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
  }
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cleanupErrors,
        results,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  bridge.disconnect('live atomic batch smoke complete');
}

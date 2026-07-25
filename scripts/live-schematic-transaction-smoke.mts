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
import { arch, platform, release } from 'node:os';
import { BridgeManager } from '../src/bridge/manager.ts';
import { loadEnvConfig } from '../src/config/env.ts';
import { createLogger } from '../src/utils/logger.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { registerBuiltinTools } from '../src/tools/register.ts';
import { stableHash } from '../src/transactions/stable.ts';
import { resetGlobalTransactionManagerForTests } from '../src/transactions/manager.ts';
import {
  buildSchematicTransactionSmokeReport,
  verifySchematicTransactionFixtureIdentity,
  writeSchematicTransactionSmokeReport,
  type SchematicTransactionSmokeInput,
} from '../src/live/schematic-transaction-smoke-report.ts';

const EXPECTED_BUILD = process.env.EASYEDA_EXPECTED_DISPATCHER_BUILD?.trim();
const WRITE_ENABLED = process.env.EASYEDA_LIVE_WRITE_TESTS?.trim().toLowerCase() === 'true';
const EXPECTED_PROJECT = process.env.EASYEDA_EXPECTED_PROJECT?.trim();
const EXPECTED_SCHEMATIC = process.env.EASYEDA_EXPECTED_SCHEMATIC?.trim();
const EXPECTED_PAGE = process.env.EASYEDA_EXPECTED_PAGE?.trim();
const REPORT_PATH =
  process.env.EASYEDA_TRANSACTION_SMOKE_REPORT_PATH?.trim() ||
  '.easyeda-mcp-pro/schematic-transaction-smoke-report.json';
const REQUIRED_FIXTURE = {
  project: 'TestMcp',
  schematic: 'Schematic1',
  page: 'P1',
  disposable: true,
} as const;
const KINDS = ['component', 'wire', 'text', 'rectangle', 'circle', 'polygon'] as const;
type Kind = (typeof KINDS)[number];

const config = loadEnvConfig();
createLogger(config);
const bridge = new BridgeManager(config);

function assertSmokeConfiguration(): void {
  if (!WRITE_ENABLED) {
    throw new Error('SAFETY_PRECONDITION_FAILED: EASYEDA_LIVE_WRITE_TESTS=true is required.');
  }
  const actual = {
    project: EXPECTED_PROJECT,
    schematic: EXPECTED_SCHEMATIC,
    page: EXPECTED_PAGE,
  };
  for (const [key, required] of Object.entries(REQUIRED_FIXTURE)) {
    if (key === 'disposable') continue;
    if (actual[key as keyof typeof actual] !== required) {
      throw new Error(
        `SAFETY_PRECONDITION_FAILED: EASYEDA_EXPECTED_${key.toUpperCase()} must equal ${required}.`,
      );
    }
  }
}

function assertFocusedFixtureIdentity(focus: {
  projectInfo: unknown;
  schematicInfo: unknown;
  pageInfo: unknown;
}): void {
  const verification = verifySchematicTransactionFixtureIdentity(REQUIRED_FIXTURE, focus);
  if (!verification.ok) {
    throw new Error(
      `SAFETY_PRECONDITION_FAILED: focused fixture identity mismatch (${JSON.stringify(verification.mismatches)}).`,
    );
  }
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
  projectInfo: unknown;
  schematicInfo: unknown;
  pageInfo: unknown;
  inventories: Record<Kind, string[]>;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'schematic information is unavailable';

  while (Date.now() < deadline) {
    try {
      const projectInfoResponse = (await bridge.call('api.call', {
        path: 'DMT_Project.getCurrentProjectInfo',
        args: [],
      })) as { result?: unknown };
      const schematicInfoResponse = (await bridge.call('api.call', {
        path: 'DMT_Schematic.getCurrentSchematicInfo',
        args: [],
      })) as { result?: unknown };
      const pageInfoResponse = (await bridge.call('api.call', {
        path: 'DMT_Schematic.getCurrentSchematicPageInfo',
        args: [],
      })) as { result?: unknown };
      const projectInfo = projectInfoResponse?.result;
      const schematicInfo = schematicInfoResponse?.result;
      const pageInfo = pageInfoResponse?.result;
      if (!projectInfo || !schematicInfo || !pageInfo) {
        lastReason = 'a project, schematic document, and page are not focused';
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      let previous = await allInventories();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const current = await allInventories();
        if (stableHash(previous) === stableHash(current)) {
          return { projectInfo, schematicInfo, pageInfo, inventories: current };
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

type LiveStateDigest = Awaited<ReturnType<typeof stateDigest>>;

const cleanupIds = new Set<string>();
const results: Record<string, any> = {};
const cleanupErrors: string[] = [];
let baselineState: LiveStateDigest | undefined;
let finalStateSnapshot: LiveStateDigest | undefined;
let dispatcherBuildId = '';

function reportStateDigest(state: LiveStateDigest | undefined) {
  return {
    primitiveInventoryHash: state ? stableHash(state.inventories) : '',
    componentHash: state?.componentHash ?? '',
    netHash: state?.netHash ?? '',
    ercAvailable: state?.ercAvailable ?? false,
    ...(state?.ercHash ? { ercHash: state.ercHash } : {}),
  };
}

function rollbackOutcome(kind: 'create' | 'modify' | 'delete') {
  if (kind === 'create') {
    const value = results.createRollback ?? {};
    return {
      passed:
        value.success === false &&
        value.rolled_back === true &&
        value.firstOperationStatus === 'rolled-back' &&
        value.failureOperationStatus === 'failed',
      rolledBack: value.rolled_back === true,
      stateRestored: value.inventoryRestored === true,
      details: {
        transactionState: value.transaction_state,
        errorCode: value.error_code,
      },
    };
  }
  if (kind === 'modify') {
    const value = results.modifyRollback ?? {};
    return {
      passed: value.success === false && value.rolled_back === true,
      rolledBack: value.rolled_back === true,
      stateRestored: value.snapshotRestored === true,
      details: {
        transactionState: value.transaction_state,
        errorCode: value.error_code,
      },
    };
  }
  const value = results.deleteRollback ?? {};
  return {
    passed: value.success === false && value.rolled_back === true,
    rolledBack: value.rolled_back === true,
    stateRestored: value.descriptorRestored === true && value.inventoryCountStable === true,
    details: {
      transactionState: value.transaction_state,
      errorCode: value.error_code,
      idChanged: value.idChanged,
    },
  };
}

function createSmokeReport(error?: string) {
  const input: SchematicTransactionSmokeInput = {
    environment: {
      operatingSystem: `${platform()} ${release()}`,
      architecture: arch(),
      nodeVersion: process.versions.node,
    },
    fixture: REQUIRED_FIXTURE,
    bridge: {
      easyedaVersion: bridge.hello?.easyedaVersion,
      bridgeVersion: bridge.hello?.bridgeVersion,
      dispatcherBuildId,
      methodRegistryHash: bridge.hello?.methodRegistryHash ?? bridge.methodRegistryHash,
      activePort: bridge.activePort,
    },
    outcomes: {
      createRollback: rollbackOutcome('create'),
      modifyRollback: rollbackOutcome('modify'),
      deleteRollback: rollbackOutcome('delete'),
    },
    cleanup: {
      remainingIds: [...cleanupIds].sort((left, right) => left.localeCompare(right)),
      errors: [...cleanupErrors],
    },
    baseline: reportStateDigest(baselineState),
    finalState: reportStateDigest(finalStateSnapshot),
    ...(error ? { error } : {}),
  };
  return buildSchematicTransactionSmokeReport(input);
}

try {
  assertSmokeConfiguration();
  await bridge.connect();
  await waitForStableConnection(600_000);

  const status = (await bridge.call('system.getStatus', {})) as Record<string, unknown>;
  const rawBuildId =
    status.dispatcherBuildId ?? status.dispatcherBuild ?? status.dispatcher_build ?? status.buildId;
  const buildId = typeof rawBuildId === 'string' ? rawBuildId : '';
  dispatcherBuildId = buildId;
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

  const initialFocus = await requireFocusedStableSchematic();
  assertFocusedFixtureIdentity(initialFocus);
  const preflightCleanup = await cleanupKnownSmokeArtifacts();
  const focus = await requireFocusedStableSchematic();
  assertFocusedFixtureIdentity(focus);
  const baseline = await stateDigest();
  baselineState = baseline;
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
  finalStateSnapshot = finalState;
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

  const report = createSmokeReport();
  if (report.status !== 'passed') {
    throw new Error(`Transaction smoke report failed: ${JSON.stringify(report.checks)}`);
  }
  await writeSchematicTransactionSmokeReport(REPORT_PATH, report);
  console.log(JSON.stringify({ ok: true, reportPath: REPORT_PATH, report, results }, null, 2));
} catch (error) {
  const failureMessage = error instanceof Error ? error.message : String(error);
  for (const id of [...cleanupIds]) {
    try {
      await deletePrimitive(id);
      cleanupIds.delete(id);
    } catch (cleanupError) {
      cleanupErrors.push(
        `${id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
  }
  if (baselineState && bridge.state === 'connected') {
    try {
      finalStateSnapshot = await stateDigest();
    } catch (finalStateError) {
      cleanupErrors.push(
        `final-state-capture: ${finalStateError instanceof Error ? finalStateError.message : String(finalStateError)}`,
      );
    }
  }
  const report = createSmokeReport(failureMessage);
  try {
    await writeSchematicTransactionSmokeReport(REPORT_PATH, report);
  } catch (reportError) {
    cleanupErrors.push(
      `report-write: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
    );
  }
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: failureMessage,
        cleanupErrors,
        reportPath: REPORT_PATH,
        report,
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

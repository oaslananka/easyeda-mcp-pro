#!/usr/bin/env node
/**
 * LIVE E2E VALIDATION — All 7 phases of schematic net creation + connectivity
 *
 * Exits: 0=all passed, 1=one or more checks failed
 */
import { sleep, startStdioMcpServer } from './harness.mjs';
import {
  createValidationNetArtifacts,
  discoverActiveDocument,
  placeValidationComponents,
  searchValidationDevices,
  selectValidationDevicePair,
  verifyRequiredBridgeMethods,
  waitForLiveBridge,
} from './live-phases.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const CMD_TIMEOUT = 45_000;
const BRIDGE_MAX_WAIT_S = 120;

let pass = 0,
  fail = 0;
function ok(label, detail) {
  const d = detail ? ` (${detail})` : '';
  console.log(`  \u2705 ${label}${d}`);
  pass++;
}
function fail_(label, detail) {
  const d = detail ? `: ${String(detail).slice(0, 300)}` : '';
  console.log(`  \u274c ${label}${d}`);
  fail++;
}
function warn(label, detail) {
  const d = detail ? ` (${detail})` : '';
  console.log(`  \u26a0\ufe0f ${label}${d}`);
}

// Evidence log
const evidence = [];

function capture(label, data) {
  evidence.push(
    `--- ${label} ---\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`,
  );
}

// ─────── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  EASYEDA-MCP-PRO \u2014 LIVE E2E SCHEMATIC NET CREATION');
  console.log('='.repeat(60) + '\n');

  // ── Step 1: Start MCP server ───────────────────────────────────────────
  console.log('\u2500\u2500 [1/7] Start MCP Server & Connect Bridge \u2500\u2500\n');

  const server = startStdioMcpServer({ cwd: repoRoot, timeoutMs: CMD_TIMEOUT });
  const { mcpCall, toolCall } = server;
  const reporter = { ok, fail: fail_, warn, capture };

  function shutdown(label) {
    server.shutdown(label);
    server.detach();
  }

  await sleep(2000);
  if (server.exited) {
    fail_('MCP server start', 'exited immediately');
    shutdown();
    process.exit(1);
  }
  ok('MCP server started');

  const init = await mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'e2e-validator', version: '1.0' },
  });
  server.notifyInitialized();
  const sv = init.serverInfo;
  ok('MCP initialized', `${sv?.name} v${sv?.version} proto=${init.protocolVersion}`);
  capture('server info', init);

  const { connected: bridgeConnected, status: bridgeStatusData } = await waitForLiveBridge({
    toolCall,
    maxWaitSeconds: BRIDGE_MAX_WAIT_S,
    sleep,
    reporter,
  });
  if (!bridgeConnected) {
    fail_('Bridge connection', `not connected after ${BRIDGE_MAX_WAIT_S}s`);
    shutdown();
    process.exit(1);
  }

  // Health check
  const { text: healthText } = await toolCall('easyeda_health_check');
  const health = JSON.parse(healthText);
  ok('Health check', `status=${health.status} bridge=${health.bridge_connected}`);
  capture('health', health);

  // ── Phase 2: Runtime Method Verification ──────────────────────────────
  console.log('\n\u2500\u2500 [2/7] Runtime Method Verification \u2500\u2500\n');

  await verifyRequiredBridgeMethods({
    toolCall,
    capabilities: bridgeStatusData.capabilities || [],
    reporter,
  });

  // ── Phase 3: Active Document Discovery ─────────────────────────────────
  console.log('\n\u2500\u2500 [3/7] Project Context & Component Search \u2500\u2500\n');

  // The bridge doesn't expose projectId. Probe with a sentinel value.
  const PLACEHOLDER_ID = 'active';
  const activeDoc = await discoverActiveDocument({
    toolCall,
    projectId: PLACEHOLDER_ID,
    reporter,
  });
  if (!activeDoc) {
    fail_(
      'Active document',
      'no active schematic; open a schematic in EasyEDA Pro and click the canvas',
    );
    shutdown();
    process.exit(1);
  }

  const deviceItems = await searchValidationDevices({ toolCall, reporter });
  if (deviceItems.length < 2) {
    fail_('Device search', `need 2 devices, found ${deviceItems.length}`);
    shutdown();
    process.exit(1);
  }
  const devices = selectValidationDevicePair(deviceItems);
  ok('Search devices', `found "${devices.dev0Name}" & "${devices.dev1Name}"`);
  capture('device items', {
    dev0: {
      uuid: devices.d0Uuid,
      libraryUuid: devices.d0LibraryUuid,
      name: devices.dev0Name,
      raw: devices.dev0,
    },
    dev1: {
      uuid: devices.d1Uuid,
      libraryUuid: devices.d1LibraryUuid,
      name: devices.dev1Name,
      raw: devices.dev1,
    },
  });

  // ── Phase 4: Place Components ─────────────────────────────────────────
  console.log('\n\u2500\u2500 [4/7] Place Components \u2500\u2500\n');

  const {
    r1PrimId,
    r2PrimId,
    r1Ref: R1_REF,
    r2Ref: R2_REF,
  } = await placeValidationComponents({
    toolCall,
    projectId: PLACEHOLDER_ID,
    devices,
    reporter,
  });

  // ── Phase 5: Create TEST_NET Flag & Port ──────────────────────────────
  console.log('\n\u2500\u2500 [5/7] Create TEST_NET \u2691 & \u2690 \u2500\u2500\n');

  const TEST_NET = 'TEST_NET';
  const { flagPrimId, portPrimId } = await createValidationNetArtifacts({
    toolCall,
    projectId: PLACEHOLDER_ID,
    netName: TEST_NET,
    reporter,
  });

  // ── Phase 6: Connect Pins & Save ──────────────────────────────────────
  console.log('\n\u2500\u2500 [6/7] Connect Pins & Save \u2500\u2500\n');

  // 6a: connectPinToNet -- R1 pin 1
  try {
    const r = await toolCall('easyeda_schematic_connect_pin_to_net', {
      projectId: PLACEHOLDER_ID,
      primitiveId: r1PrimId,
      pinNumber: '1',
      netName: TEST_NET,
      confirmWrite: true,
    });
    ok('connectPinToNet R1/1 \u2192 TEST_NET', r.text.slice(0, 100));
    capture('connect R1 pin1', r.text);
  } catch (err) {
    fail_('connectPinToNet R1/1', err.message);
  }

  // 6b: connectPinToNet -- R1 pin 2
  try {
    const r = await toolCall('easyeda_schematic_connect_pin_to_net', {
      projectId: PLACEHOLDER_ID,
      primitiveId: r1PrimId,
      pinNumber: '2',
      netName: TEST_NET,
      confirmWrite: true,
    });
    ok('connectPinToNet R1/2 \u2192 TEST_NET', r.text.slice(0, 100));
    capture('connect R1 pin2', r.text);
  } catch (err) {
    fail_('connectPinToNet R1/2', err.message);
  }

  // 6c: connectPinsByNet -- R2 both pins
  try {
    const r = await toolCall('easyeda_schematic_connect_pins_by_net', {
      projectId: PLACEHOLDER_ID,
      pins: [
        { primitiveId: r2PrimId, pinNumber: '1' },
        { primitiveId: r2PrimId, pinNumber: '2' },
      ],
      netName: TEST_NET,
      confirmWrite: true,
    });
    let cnt = '?';
    try {
      cnt = JSON.parse(r.text)?.count || '?';
    } catch {}
    ok('connectPinsByNet R2/1,2 \u2192 TEST_NET', `count=${cnt}`);
    capture('connect R2 pins', r.text);
  } catch (err) {
    fail_('connectPinsByNet R2', err.message);
  }

  // 6d: Validate netlist before save
  try {
    const r = await toolCall('easyeda_schematic_validate_netlist', {
      projectId: PLACEHOLDER_ID,
    });
    ok('validateNetlist called', r.text.slice(0, 200));
    capture('validate netlist pre-save', r.text);
    // Parse to check if TEST_NET is listed
    try {
      const vp = JSON.parse(r.text);
      if (vp.success !== false) {
        const hasTestNet = (vp.nets || []).some((n) => n.netName === TEST_NET);
        if (hasTestNet) ok('TEST_NET in pre-save netlist');
        else warn('TEST_NET not in pre-save netlist', 'may appear after save');
      }
    } catch {}
  } catch (err) {
    fail_('validateNetlist', err.message);
  }

  // 6e: Save project
  try {
    const r = await toolCall('easyeda_project_save', {
      projectId: PLACEHOLDER_ID,
      confirmWrite: true,
    });
    ok('Project saved', r.text.slice(0, 100));
    capture('project save', r.text);
  } catch (err) {
    fail_('Project save', err.message);
  }

  // ── Phase 7: Verify Connectivity ──────────────────────────────────────
  console.log('\n\u2500\u2500 [7/7] Connectivity Verification \u2500\u2500\n');

  // 7a: Re-list nets
  try {
    const { text: n } = await toolCall('easyeda_schematic_nets', { projectId: PLACEHOLDER_ID });
    const p = JSON.parse(n);
    const netNames = (p.nets || []).map((x) => x.net_name || x.netName || '');
    const hasTestNet = netNames.includes(TEST_NET);
    if (hasTestNet) {
      ok('TEST_NET in net list', `all nets: [${netNames.join(', ')}]`);
    } else {
      fail_('TEST_NET in net list', `not in [${netNames.join(', ')}]`);
    }
    ok('Total nets listed', `${(p.nets || []).length} nets`);
    capture('post-save nets', n);
  } catch (err) {
    fail_('Re-list nets', err.message);
  }

  // 7b: Net detail
  try {
    const r = await toolCall('easyeda_schematic_net_detail', { netName: TEST_NET });
    ok('Net detail TEST_NET', r.text.slice(0, 200));
    capture('net detail', r.text);
  } catch (err) {
    fail_('Net detail', err.message);
  }

  // 7c: Validate netlist post-save
  try {
    const r = await toolCall('easyeda_schematic_validate_netlist', { projectId: PLACEHOLDER_ID });
    capture('validate netlist post-save', r.text);
    const vp = JSON.parse(r.text);
    const testNetEntry = (vp.nets || []).filter((n) => n.netName === TEST_NET);
    if (testNetEntry.length > 0) {
      const refs = testNetEntry[0].refs || testNetEntry[0].nodes || [];
      const pins = testNetEntry[0].pins || [];
      ok(
        'validateNetlist \u2192 TEST_NET',
        `refs=${JSON.stringify(refs)} pins=${JSON.stringify(pins)}`,
      );
    } else if (vp.success !== false) {
      warn('TEST_NET in netlist', 'netlist returned but TEST_NET not found in parsed result');
      ok('validateNetlist returned', 'success=true');
    } else {
      ok('validateNetlist returned', `success=${vp.success}`);
    }
    if (vp.warnings?.length) console.log(`  \u26a0\ufe0f  Warnings: ${vp.warnings.join('; ')}`);
  } catch (err) {
    fail_('validateNetlist post-save', err.message);
  }

  // 7d: Persistence (TEST_NET still visible after save + re-read)
  try {
    const { text: n } = await toolCall('easyeda_schematic_nets', { projectId: PLACEHOLDER_ID });
    const p = JSON.parse(n);
    const names = (p.nets || []).map((x) => x.net_name || x.netName || '');
    if (names.includes(TEST_NET)) {
      ok('TEST_NET persists after save');
    } else {
      fail_('Persistence', 'TEST_NET disappeared after save');
    }
    capture('persistence check', n);
  } catch (err) {
    fail_('Persistence check', err.message);
  }

  // ── Error-Path Tests ──────────────────────────────────────────────────
  console.log('\n\u2500\u2500 [7b] Error-Path Tests \u2500\u2500\n');

  // confirmWrite missing
  try {
    await toolCall('easyeda_schematic_create_net_flag', {
      projectId: PLACEHOLDER_ID,
      netName: 'SHOULD_FAIL',
      x: 0,
      y: 0,
    });
    fail_('confirmWrite missing', 'should have rejected');
  } catch {
    ok('Reject: confirmWrite missing');
  }

  // invalid component ID
  try {
    await toolCall('easyeda_schematic_connect_pin_to_net', {
      projectId: PLACEHOLDER_ID,
      primitiveId: 'NONEXISTENT_ID',
      pinNumber: '1',
      netName: TEST_NET,
      confirmWrite: true,
    });
    warn('Invalid component ID', 'did not throw (extension may silently handle)');
  } catch {
    ok('Reject: invalid primitiveId');
  }

  // ── Cleanup ──────────────────────────────────────────────────────────
  console.log('\n\u2500\u2500 [7c] Cleanup \u2500\u2500\n');

  // Delete net flag and net port
  let deletedCount = 0;
  for (const pid of [flagPrimId, portPrimId]) {
    if (pid && pid !== 'unknown') {
      try {
        const r = await toolCall('easyeda_schematic_delete_primitive', {
          primitiveIds: [pid],
          confirmWrite: true,
        });
        deletedCount++;
        capture(`delete ${pid}`, r.text);
      } catch (e) {
        warn(`Delete ${pid}`, e.message);
      }
    }
  }

  // Delete placed components
  for (const pid of [r1PrimId, r2PrimId]) {
    if (pid && pid !== R1_REF && pid !== R2_REF) {
      try {
        const r = await toolCall('easyeda_schematic_delete_primitive', {
          primitiveIds: [pid],
          confirmWrite: true,
        });
        deletedCount++;
        capture(`delete component ${pid}`, r.text);
      } catch (e) {
        warn(`Delete component ${pid}`, e.message);
      }
    }
  }

  ok('Cleanup deletions attempted', `${deletedCount} primitives`);
  capture('cleanup evidence', {
    deleted: deletedCount,
    flagPrimId,
    portPrimId,
    r1PrimId,
    r2PrimId,
  });

  // Save after cleanup
  try {
    const r = await toolCall('easyeda_project_save', {
      projectId: PLACEHOLDER_ID,
      confirmWrite: true,
    });
    ok('Project saved after cleanup');
    capture('post-cleanup save', r.text);
  } catch (err) {
    warn('Post-cleanup save', err.message);
  }

  // Verify TEST_NET gone after cleanup
  try {
    const { text: n } = await toolCall('easyeda_schematic_nets', { projectId: PLACEHOLDER_ID });
    const p = JSON.parse(n);
    const names = (p.nets || []).map((x) => x.net_name || x.netName || '');
    if (names.includes(TEST_NET)) {
      warn(
        'Cleanup netlist',
        'TEST_NET still present after deletion (label objects removed but net may persist)',
      );
    } else {
      ok('Cleanup verified', 'TEST_NET absent from netlist');
    }
    capture('final nets', n);
  } catch (err) {
    warn('Final netlist check', err.message);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log(`  RESULTS: ${pass} passed, ${fail} failed\n`);

  // Print evidence summary
  console.log('Evidence captured:');
  for (const e of evidence) {
    const header = e.split('\n')[0];
    console.log(`  \ud83d\udcc4 ${header}`);
  }

  // Print extension file info
  console.log('\nExtension file:');
  try {
    const fs = await import('node:fs');
    const p = `${__dirname}/easyeda-bridge-extension.eext`;
    const stat = fs.statSync(p);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log(`  Path: ${p}`);
    console.log(`  Size: ${stat.size} bytes`);
    console.log(`  Modified: ${stat.mtime.toISOString()}`);
    console.log(`  SHA-256: ${hash}`);
  } catch (e) {
    console.log(`  (unavailable: ${e.message})`);
  }

  capture('final stats', { pass, fail, bridgeVersion: bridgeStatusData.bridge_version });

  shutdown('E2E complete');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E FATAL:', e);
  process.exit(1);
});

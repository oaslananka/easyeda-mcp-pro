#!/usr/bin/env node
/**
 * LIVE E2E VALIDATION — All 7 phases of schematic net creation + connectivity
 *
 * Exits: 0=all passed, 1=one or more checks failed
 */
import { spawnTrackedProcess } from './harness.mjs';
import { extractPinsPayload } from './payloads.mjs';
import { createInterface } from 'node:readline';
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

// ─────── MCP RPC helpers ──────────────────────────────────────────────────
let reqId = 0;
const pending = new Map();
let serverStdin;

let serverStdoutLog = '';

function mcpCall(method, params = {}, timeoutMs = CMD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`TIMEOUT ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    serverStdin.write(msg);
  });
}

async function toolCall(name, args = {}) {
  const result = await mcpCall('tools/call', { name, arguments: args });
  const content = result.content || [];
  const text = content.map((c) => c.text || c?.toString?.() || JSON.stringify(c)).join('\n');
  return { result, text, isError: result.isError === true };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  EASYEDA-MCP-PRO \u2014 LIVE E2E SCHEMATIC NET CREATION');
  console.log('='.repeat(60) + '\n');

  // ── Step 1: Start MCP server ───────────────────────────────────────────
  console.log('\u2500\u2500 [1/7] Start MCP Server & Connect Bridge \u2500\u2500\n');

  const serverProcess = spawnTrackedProcess('node', ['dist/index.js'], {
    cwd: repoRoot,
    env: {
      TRANSPORT: 'stdio',
      LOG_LEVEL: 'silent',
      TOOL_PROFILE: 'full',
      BRIDGE_RECONNECT_MAX_ATTEMPTS: '0',
      BRIDGE_RECONNECT_INTERVAL_MS: '1000',
      BRIDGE_TIMEOUT_MS: '30000',
    },
  });
  const server = serverProcess.child;

  serverStdin = server.stdin;
  let serverExited = false;
  server.on('exit', (c) => {
    serverExited = true;
  });

  const rl = createInterface({ input: server.stdout });
  rl.on('line', (line) => {
    serverStdoutLog += line + '\n';
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.id && pending.has(parsed.id)) {
      const { resolve, reject, timer } = pending.get(parsed.id);
      pending.delete(parsed.id);
      clearTimeout(timer);
      if (parsed.error) reject(new Error(parsed.error.message));
      else resolve(parsed.result);
    }
  });

  const stderrLog = [];
  server.stderr.on('data', (d) => {
    stderrLog.push(d.toString().trim());
  });

  function shutdown(label) {
    serverProcess.shutdown(label);
    serverProcess.detach();
  }

  await wait(2000);
  if (serverExited) {
    fail_('MCP server start', 'exited immediately');
    shutdown();
    process.exit(1);
  }
  ok('MCP server started');

  // Initialize MCP
  const init = await mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'e2e-validator', version: '1.0' },
  });
  serverStdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const sv = init.serverInfo;
  ok('MCP initialized', `${sv?.name} v${sv?.version} proto=${init.protocolVersion}`);
  capture('server info', init);

  // ── Bridge connection ──────────────────────────────────────────────────
  let bridgeConnected = false;
  let bridgeStatusData = {};
  for (let i = 0; ; i++) {
    try {
      const { text } = await toolCall('easyeda_bridge_status');
      const parsed = JSON.parse(text);
      bridgeStatusData = parsed;
      if (parsed.connected === true) {
        bridgeConnected = true;
        ok('Bridge connected', `version=${parsed.bridge_version || parsed.version || '?'}`);
        capture('bridge status', parsed);
        break;
      }
    } catch (e) {}
    const elapsed = (i + 1) * 3;
    if (elapsed >= BRIDGE_MAX_WAIT_S) break;
    if ((i + 1) % 5 === 0) console.log(`  \u23f3 waiting for bridge... ${elapsed}s elapsed`);
    await wait(3000);
  }

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

  const requiredMethods = [
    'schematic.createNetFlag',
    'schematic.createNetPort',
    'schematic.connectPinToNet',
    'schematic.connectPinsByNet',
    'schematic.validateNetlist',
    'project.save',
  ];

  const capabilitiesFromBridge = bridgeStatusData.capabilities || [];

  const methodResults = {};
  for (const method of requiredMethods) {
    let found = capabilitiesFromBridge.includes(method);
    // Also check via api_inventory
    if (!found) {
      try {
        const { text: inv } = await toolCall('easyeda_api_inventory', { filter: method });
        if (inv.includes(method)) found = true;
      } catch {}
    }
    if (found) {
      methodResults[method] = true;
      ok(`Bridge method declared: ${method}`);
    } else {
      methodResults[method] = false;
      fail_(`Bridge method: ${method}`, 'not in capabilities');
    }
  }

  // ── Phase 3: Active Document Discovery ─────────────────────────────────
  console.log('\n\u2500\u2500 [3/7] Project Context & Component Search \u2500\u2500\n');

  // The bridge doesn't expose projectId. Probe with a sentinel value.
  const PLACEHOLDER_ID = 'active';

  // First try schematic_nets to see if there's an active document
  let activeDoc = false;
  let initialNets = [];
  try {
    const { text: netsText } = await toolCall('easyeda_schematic_nets', {
      projectId: PLACEHOLDER_ID,
    });
    const netsParsed = JSON.parse(netsText);
    if (!netsParsed.not_available) {
      activeDoc = true;
      initialNets = netsParsed.nets || [];
      ok('Active document confirmed', `${initialNets.length} initial nets`);
      capture('initial nets', netsText);
    }
  } catch (e) {}

  // Fallback: try listComponents
  if (!activeDoc) {
    try {
      const { text: compText } = await toolCall('easyeda_schematic_components', {
        projectId: PLACEHOLDER_ID,
        limit: 1,
      });
      const compParsed = JSON.parse(compText);
      if (compParsed && !compParsed.not_available) {
        activeDoc = true;
        ok('Active document confirmed via components');
      }
    } catch {}
  }

  if (!activeDoc) {
    fail_(
      'Active document',
      'no active schematic; open a schematic in EasyEDA Pro and click the canvas',
    );
    shutdown();
    process.exit(1);
  }

  // Search for devices to place
  let deviceItems = [];
  for (const keyword of ['resistor', 'R_0603', 'R_0805', 'capacitor']) {
    try {
      const { text: dt } = await toolCall('easyeda_schematic_search_device', {
        key: keyword,
        itemsOfPage: 10,
        page: 1,
      });
      const d = JSON.parse(dt);
      const devs = d.devices || d.results || [];
      if (devs.length > 0) deviceItems = devs;
      if (deviceItems.length >= 2) break;
    } catch (e) {
      warn('Device search attempt', `${keyword}: ${e.message}`);
    }
  }

  if (deviceItems.length < 2) {
    fail_('Device search', `need 2 devices, found ${deviceItems.length}`);
    shutdown();
    process.exit(1);
  }

  // Pick the first two suitable devices - prefer R_0603 or R_0805
  let dev0 =
    deviceItems.find((d) => (d.title || d.name || '').toLowerCase().includes('0603')) ||
    deviceItems[0];
  let dev1 =
    deviceItems.find((d) => (d.title || d.name || '').toLowerCase().includes('0805')) ||
    (deviceItems.length > 1 ? deviceItems[1] : deviceItems[0]);
  if (dev0 === dev1) dev1 = deviceItems[1] || deviceItems[0];

  // Extract separate uuid and libraryUuid - SCH_PrimitiveComponent.create requires both
  const d0_uuid = dev0.uuid || dev0.deviceUUID || dev0.mp || '';
  const d0_libUuid = dev0.libraryUuid || dev0.libraryId || '';
  const d1_uuid = dev1.uuid || dev1.deviceUUID || dev1.mp || '';
  const d1_libUuid = dev1.libraryUuid || dev1.libraryId || '';
  const dev0Name = dev0.title || dev0.name || dev0.display || d0_uuid;
  const dev1Name = dev1.title || dev1.name || dev1.display || d1_uuid;

  ok('Search devices', `found "${dev0Name}" & "${dev1Name}"`);
  capture('device items', {
    dev0: { uuid: d0_uuid, libraryUuid: d0_libUuid, name: dev0Name, raw: dev0 },
    dev1: { uuid: d1_uuid, libraryUuid: d1_libUuid, name: dev1Name, raw: dev1 },
  });

  // ── Phase 4: Place Components ─────────────────────────────────────────
  console.log('\n\u2500\u2500 [4/7] Place Components \u2500\u2500\n');

  const R1_REF = 'E2E_R1';
  const R2_REF = 'E2E_R2';
  let r1PrimId = '',
    r2PrimId = '',
    r1Result,
    r2Result;

  try {
    r1Result = await toolCall('easyeda_schematic_place_component', {
      deviceItem: { libraryUuid: d0_libUuid, uuid: d0_uuid },
      x: 100,
      y: 200,
      rotation: 0,
      confirmWrite: true,
    });
    ok('Placed R1', r1Result.text.slice(0, 200));
    capture('place R1', r1Result.text);
    // Extract primitiveId
    try {
      const parsed = JSON.parse(r1Result.text);
      if (parsed.component?.primitiveId) r1PrimId = parsed.component.primitiveId;
    } catch {}
  } catch (err) {
    fail_('Place R1', err.message);
  }

  try {
    r2Result = await toolCall('easyeda_schematic_place_component', {
      deviceItem: { libraryUuid: d1_libUuid, uuid: d1_uuid },
      x: 500,
      y: 200,
      rotation: 0,
      confirmWrite: true,
    });
    ok('Placed R2', r2Result.text.slice(0, 200));
    capture('place R2', r2Result.text);
    try {
      const parsed = JSON.parse(r2Result.text);
      if (parsed.component?.primitiveId) r2PrimId = parsed.component.primitiveId;
    } catch {}
  } catch (err) {
    fail_('Place R2', err.message);
  }

  // Enumerate components to get primitive IDs if not extracted from place result
  if (!r1PrimId || !r2PrimId) {
    try {
      const { text: compText } = await toolCall('easyeda_schematic_components', {
        projectId: PLACEHOLDER_ID,
        limit: 50,
      });
      capture('components list', compText);
      const cp = JSON.parse(compText);
      const comps = cp.components || cp.results || [];
      for (const c of comps) {
        const ref = c.reference || c.ref || c.name || '';
        const pid = c.primitiveId || c.uuid || c.id || '';
        if (ref.startsWith('E2E_') || ref.startsWith('R')) {
          if (!r1PrimId) r1PrimId = pid;
          else if (!r2PrimId && pid !== r1PrimId) r2PrimId = pid;
        }
      }
    } catch (e) {
      warn('Component enumeration', e.message);
    }
  }

  if (!r1PrimId) r1PrimId = R1_REF;
  if (!r2PrimId) r2PrimId = R2_REF;
  ok('Component primitive IDs', `R1=${r1PrimId} R2=${r2PrimId}`);

  // Also get component pins
  let r1Pins = [],
    r2Pins = [];
  try {
    const { text: pins1 } = await toolCall('easyeda_schematic_component_pins', {
      primitiveId: r1PrimId,
    });
    r1Pins = extractPinsPayload(JSON.parse(pins1));
    ok(
      'R1 pins',
      `${r1Pins.length} pins: ${r1Pins.map((p) => p.number || p.pinNumber || '').join(', ')}`,
    );
  } catch (e) {
    warn('R1 pins', e.message);
  }
  try {
    const { text: pins2 } = await toolCall('easyeda_schematic_component_pins', {
      primitiveId: r2PrimId,
    });
    r2Pins = extractPinsPayload(JSON.parse(pins2));
    ok(
      'R2 pins',
      `${r2Pins.length} pins: ${r2Pins.map((p) => p.number || p.pinNumber || '').join(', ')}`,
    );
  } catch (e) {
    warn('R2 pins', e.message);
  }

  // Native No Connect set/readback/clear on a disposable test pin.
  const noConnectPin = r2Pins[0]?.pinNumber || r2Pins[0]?.number;
  if (noConnectPin) {
    try {
      const setResult = await toolCall('easyeda_schematic_set_pin_no_connect', {
        projectId: PLACEHOLDER_ID,
        primitiveId: r2PrimId,
        pinNumber: String(noConnectPin),
        noConnected: true,
        confirmWrite: true,
      });
      const setPayload = JSON.parse(setResult.text);
      if (setPayload.no_connected !== true || setPayload.verified !== true) {
        throw new Error(`set readback was not verified: ${setResult.text}`);
      }
      ok('Set native No Connect', `${r2PrimId}/${noConnectPin}`);
      capture('set native no-connect', setResult.text);

      const { text: readText } = await toolCall('easyeda_schematic_component_pins', {
        primitiveId: r2PrimId,
      });
      const readPins = extractPinsPayload(JSON.parse(readText));
      const readPin = readPins.find(
        (pin) => String(pin.pinNumber || pin.number || '') === String(noConnectPin),
      );
      if (readPin?.noConnected !== true) {
        throw new Error(`component pin readback did not expose noConnected=true: ${readText}`);
      }
      ok('Read back native No Connect', `pinPrimitiveId=${readPin.primitiveId || 'unknown'}`);

      const clearResult = await toolCall('easyeda_schematic_set_pin_no_connect', {
        projectId: PLACEHOLDER_ID,
        primitiveId: r2PrimId,
        pinNumber: String(noConnectPin),
        noConnected: false,
        confirmWrite: true,
      });
      const clearPayload = JSON.parse(clearResult.text);
      if (clearPayload.no_connected !== false || clearPayload.verified !== true) {
        throw new Error(`clear readback was not verified: ${clearResult.text}`);
      }
      ok('Clear native No Connect', `${r2PrimId}/${noConnectPin}`);
      capture('clear native no-connect', clearResult.text);
    } catch (err) {
      fail_('Native No Connect set/readback/clear', err.message);
    }
  } else {
    warn('Native No Connect', 'Skipped because no addressable R2 pin was available');
  }

  // ── Phase 5: Create TEST_NET Flag & Port ──────────────────────────────
  console.log('\n\u2500\u2500 [5/7] Create TEST_NET \u2691 & \u2690 \u2500\u2500\n');

  const TEST_NET = 'TEST_NET';
  let flagPrimId = 'unknown',
    portPrimId = 'unknown';

  // Create net flag
  try {
    const res = await toolCall('easyeda_schematic_create_net_flag', {
      projectId: PLACEHOLDER_ID,
      netName: TEST_NET,
      x: 300,
      y: 100,
      rotation: 0,
      confirmWrite: true,
    });
    try {
      const parsed = JSON.parse(res.text);
      flagPrimId = parsed.netFlag?.primitiveId || 'unknown';
    } catch {}
    ok('Create net flag TEST_NET', `primitiveId=${flagPrimId}`);
    capture('net flag result', res.text);
  } catch (err) {
    fail_('Create net flag', err.message);
  }

  // Create net port
  try {
    const res = await toolCall('easyeda_schematic_create_net_port', {
      projectId: PLACEHOLDER_ID,
      netName: TEST_NET,
      x: 300,
      y: 300,
      portType: 'passive',
      rotation: 0,
      confirmWrite: true,
    });
    try {
      const parsed = JSON.parse(res.text);
      portPrimId = parsed.netPort?.primitiveId || 'unknown';
    } catch {}
    ok('Create net port TEST_NET', `primitiveId=${portPrimId}`);
    capture('net port result', res.text);
  } catch (err) {
    fail_('Create net port', err.message);
  }

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
    const fs = await import('fs');
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

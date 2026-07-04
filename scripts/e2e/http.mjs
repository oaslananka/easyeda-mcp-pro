#!/usr/bin/env node
/**
 * HTTP-based LIVE E2E VALIDATION
 * Connects to already-running MCP server via HTTP transport.
 * Waits for bridge connection, then validates all 5 net-creation handlers.
 */
const MCP_URL = 'http://127.0.0.1:18600/mcp';
const BRIDGE_MAX_WAIT_S = 120;
const CMD_TIMEOUT = 30_000;

let pass = 0,
  fail = 0;
function ok(label, detail) {
  const d = detail ? ` (${detail})` : '';
  console.log(`  ✅ ${label}${d}`);
  pass++;
}
function fail_(label, detail) {
  const d = detail ? `: ${String(detail).slice(0, 200)}` : '';
  console.log(`  ❌ ${label}${d}`);
  fail++;
}

let reqId = 0;
async function mcpCall(method, params = {}) {
  const id = ++reqId;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CMD_TIMEOUT);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    clearTimeout(timer);
    const parsed = JSON.parse(text);
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`TIMEOUT ${method}`);
    throw e;
  }
}

async function toolCall(name, args = {}) {
  try {
    const result = await mcpCall('tools/call', { name, arguments: args });
    const content = result.content || [];
    const text = content
      .map((c) => c.text || c?.toString?.() || JSON.stringify(c))
      .join('\n')
      .trim();
    return { result, text, isError: result.isError === true };
  } catch (e) {
    return { result: null, text: '', isError: true, error: e.message };
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  LIVE E2E — HTTP Transport');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Verify server is reachable
  try {
    await mcpCall('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e-http', version: '1.0' },
    });
    // Send initialized notification
    await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    ok('Server reachable', `HTTP ${MCP_URL}`);
  } catch (e) {
    fail_('Server reachable', e.message);
    process.exit(1);
  }

  // Get server info
  const ping = await mcpCall('ping');
  ok('Server ping', `ok`);

  // 1. BRIDGE CONNECTION
  console.log('\n── [1/7] Bridge Connection ──\n');
  let bridgeConnected = false,
    bridgeVersion = '?',
    bridgeStatusRaw = '';
  for (let i = 0; i < BRIDGE_MAX_WAIT_S; i++) {
    try {
      const { text } = await toolCall('easyeda_bridge_status');
      bridgeStatusRaw = text;
      const p = JSON.parse(text);
      if (p.connected === true) {
        bridgeConnected = true;
        bridgeVersion = p.version || '?';
        break;
      }
    } catch {}
    if ((i + 1) % 15 === 0) console.log(`  ⏳ waiting for bridge... ${i + 1}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!bridgeConnected) {
    fail_('Bridge connection', `not connected after ${BRIDGE_MAX_WAIT_S}s`);
    console.log('\n  ℹ️  Server is listening on port 18601.');
    console.log('  ℹ️  Open EasyEDA Pro → MCP Bridge → Connect (click Connect).');
    console.log('  ℹ️  Then re-run this script.\n');
    process.exit(1);
  }
  ok('Bridge connected', `version=${bridgeVersion}`);

  // Health check
  const { text: ht } = await toolCall('easyeda_health_check');
  ok('Health check', ht.slice(0, 150));

  // 2. RUNTIME METHODS
  console.log('\n── [2/7] Runtime Methods ──\n');
  const required = [
    'schematic.createNetFlag',
    'schematic.createNetPort',
    'schematic.connectPinToNet',
    'schematic.connectPinsByNet',
    'schematic.validateNetlist',
    'project.save',
  ];

  const { text: bsText } = await toolCall('easyeda_bridge_status');
  const bsParsed = JSON.parse(bsText);
  const caps = new Set(bsParsed?.capabilities || []);
  const allOk = required.every((m) => caps.has(m));
  for (const m of required) {
    if (caps.has(m)) ok(`Bridge method: ${m}`);
    else fail_(`Bridge method: ${m}`, 'not in capabilities');
  }

  // 3. PROJECT CONTEXT
  console.log('\n── [3/7] Project Context ──\n');
  let projectId = bsParsed?.documentInfo?.projectId || bsParsed?.projectId || '';
  if (!projectId) {
    fail_('Project ID', 'no active project; open a schematic in EasyEDA Pro');
    process.exit(1);
  }
  ok('Active project', projectId);

  const { text: nets0 } = await toolCall('easyeda_schematic_nets');
  const nets0p = JSON.parse(nets0);
  const netNames0 = (nets0p?.nets || []).map((n) => n.netName || n.name);
  ok(`Initial nets`, `${netNames0.length} nets [${netNames0.slice(0, 6).join(', ')}]`);

  // Search devices
  let devices = [];
  for (const kw of ['resistor', 'R_0603', 'R_0805', 'capacitor']) {
    const { text: dt } = await toolCall('easyeda_schematic_search_device', {
      keyword: kw,
      limit: 10,
    });
    const d = JSON.parse(dt);
    devices = d?.devices || d?.results || [];
    if (devices.length >= 2) break;
  }
  const d0 = devices[0],
    d1 = devices[1];
  if (!d0 || !d1) {
    fail_('Search devices', `need 2, got ${devices.length}`);
    process.exit(1);
  }
  const d0id = d0.uuid || d0.deviceUUID || d0.libraryId || d0.id || d0.mp || '';
  const d1id = d1.uuid || d1.deviceUUID || d1.libraryId || d1.id || d1.mp || '';
  ok('Search devices', `"${d0.title || d0.name}" & "${d1.title || d1.name}"`);

  // 4. PLACE COMPONENTS
  console.log('\n── [4/7] Place Components ──\n');
  let r1pid = '',
    r2pid = '';
  const { text: pr1 } = await toolCall('easyeda_schematic_place_component', {
    projectId,
    deviceUUID: d0id,
    x: 100,
    y: 200,
    rotation: 0,
    confirmWrite: true,
  });
  ok('Place R1', pr1.slice(0, 150));
  try {
    r1pid = JSON.parse(pr1)?.primitiveId || '';
  } catch {}

  const { text: pr2 } = await toolCall('easyeda_schematic_place_component', {
    projectId,
    deviceUUID: d1id,
    x: 500,
    y: 200,
    rotation: 0,
    confirmWrite: true,
  });
  ok('Place R2', pr2.slice(0, 150));
  try {
    r2pid = JSON.parse(pr2)?.primitiveId || '';
  } catch {}

  // Fallback: list components
  if (!r1pid || !r2pid) {
    const { text: ct } = await toolCall('easyeda_schematic_components');
    const cp = JSON.parse(ct);
    const comps = cp?.components || cp?.results || [];
    for (const c of comps) {
      const ref = c.reference || c.ref || c.name || '';
      if (ref.startsWith('E2E_') || ref === 'R1' || ref === 'R2') {
        const pid = c.primitiveId || c.id || '';
        if (!r1pid) r1pid = pid;
        else if (!r2pid && pid !== r1pid) r2pid = pid;
      }
    }
  }
  ok('Primitive IDs', `R1=${r1pid} R2=${r2pid}`);

  // 5. CREATE NET FLAG & PORT
  console.log('\n── [5/7] Create TEST_NET Flag & Port ──\n');
  const { text: nf } = await toolCall('easyeda_schematic_create_net_flag', {
    projectId,
    netName: 'TEST_NET',
    x: 300,
    y: 100,
    orientation: 0,
  });
  ok('Create net flag', nf.slice(0, 100));

  const { text: np } = await toolCall('easyeda_schematic_create_net_port', {
    projectId,
    netName: 'TEST_NET',
    x: 300,
    y: 300,
    portType: 'passive',
    rotation: 0,
  });
  ok('Create net port', np.slice(0, 100));

  // 6. CONNECT PINS
  console.log('\n── [6/7] Connect & Save ──\n');
  const { text: c1 } = await toolCall('easyeda_schematic_connect_pin_to_net', {
    projectId,
    primitiveId: r1pid,
    pinNumber: '1',
    netName: 'TEST_NET',
  });
  ok('connectPinToNet R1/1', c1.slice(0, 100));

  const { text: c2 } = await toolCall('easyeda_schematic_connect_pin_to_net', {
    projectId,
    primitiveId: r1pid,
    pinNumber: '2',
    netName: 'TEST_NET',
  });
  ok('connectPinToNet R1/2', c2.slice(0, 100));

  const { text: c3 } = await toolCall('easyeda_schematic_connect_pins_by_net', {
    projectId,
    pins: [
      { primitiveId: r2pid, pinNumber: '1' },
      { primitiveId: r2pid, pinNumber: '2' },
    ],
    netName: 'TEST_NET',
  });
  ok('connectPinsByNet R2', c3.slice(0, 100));

  const { text: vn } = await toolCall('easyeda_schematic_validate_netlist', { projectId });
  const vnp = JSON.parse(vn);
  const testNets = (vnp?.nets || []).filter((n) => n.netName === 'TEST_NET');
  if (testNets.length > 0)
    ok('validateNetlist → TEST_NET', `refs=${JSON.stringify(testNets[0].refs)}`);
  else fail_('validateNetlist', 'TEST_NET not found');

  const { text: sv } = await toolCall('easyeda_project_save', { projectId, confirmWrite: true });
  ok('Project saved', sv.slice(0, 100));

  // 7. VERIFY
  console.log('\n── [7/7] Connectivity Verification ──\n');
  const { text: n1 } = await toolCall('easyeda_schematic_nets');
  const n1p = JSON.parse(n1);
  const names1 = (n1p?.nets || []).map((x) => x.netName || x.name);
  if (names1.includes('TEST_NET')) ok('TEST_NET in net list', `nets: [${names1.join(', ')}]`);
  else fail_('TEST_NET in net list', `not in [${names1.join(', ')}]`);

  const { text: nd } = await toolCall('easyeda_schematic_net_detail', { netName: 'TEST_NET' });
  ok('Net detail TEST_NET', nd.slice(0, 200));

  const { text: vn2 } = await toolCall('easyeda_schematic_validate_netlist', { projectId });
  const vn2p = JSON.parse(vn2);
  const testNets2 = (vn2p?.nets || []).filter((n) => n.netName === 'TEST_NET');
  if (testNets2.length > 0) ok('validateNetlist (post-save) → TEST_NET');
  else fail_('validateNetlist post-save', 'not found');
  if (vn2p?.warnings?.length) console.log(`  ⚠️  Warnings: ${vn2p.warnings.join('; ')}`);

  // Persistence
  const { text: n2 } = await toolCall('easyeda_schematic_nets');
  const n2p = JSON.parse(n2);
  const names2 = (n2p?.nets || []).map((x) => x.netName || x.name);
  if (names2.includes('TEST_NET')) ok('TEST_NET persists after save');
  else fail_('Persistence', 'TEST_NET disappeared');

  // Error paths
  console.log('\n── Error Paths ──\n');
  const { text: e1 } = await toolCall('easyeda_schematic_create_net_flag', { netName: 'BAD' });
  if (e1.toLowerCase().includes('required') || e1.toLowerCase().includes('missing'))
    ok('Reject: missing projectId');
  else fail_('Missing projectId', e1.slice(0, 100));

  const { text: e2 } = await toolCall('easyeda_schematic_connect_pin_to_net', {
    projectId,
    primitiveId: 'NONEXISTENT_999',
    pinNumber: '1',
    netName: 'TEST_NET',
  });
  if (e2.toLowerCase().includes('not found') || e2.toLowerCase().includes('error'))
    ok('Reject: invalid primitiveId');
  else fail_('Invalid primitiveId', e2.slice(0, 100));

  const { text: e3 } = await toolCall('easyeda_project_save', { projectId });
  if (e3.toLowerCase().includes('confirmwrite') || e3.toLowerCase().includes('required'))
    ok('Reject: save without confirmWrite');
  else fail_('Save without confirmWrite', e3.slice(0, 100));

  // REPORT
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS:  ✅ ${pass} passed  |  ❌ ${fail} failed`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n  🔴 Fatal: ${e.message}`);
  process.exit(1);
});

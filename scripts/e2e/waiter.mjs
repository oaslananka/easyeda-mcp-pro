import { spawnTrackedProcess } from './harness.mjs';
import { Socket } from 'net';
import { setTimeout as sleep } from 'timers/promises';

const SRV_TIMEOUT = 5 * 60 * 1000; // 5 min
const POLL_INTERVAL = 5000;

// Do NOT kill node here - would kill our own process
console.log('Process started at', new Date().toISOString());

console.log('=== Starting MCP Server ===');
const serverProcess = spawnTrackedProcess('node', ['dist/index.js'], {
  env: { LOG_LEVEL: 'info' },
});
const server = serverProcess.child;
server.on('exit', (code) => console.log('Server exited code=' + code));

await sleep(3000);

// Connect via TCP to MCP port
console.log('Connecting TCP to MCP port 18601...');
const sock = new Socket();
let buf = '';

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('TCP connect timeout')), 10000);
  sock.connect(18601, '127.0.0.1', () => {
    clearTimeout(t);
    resolve();
  });
  sock.on('error', reject);
});

sock.on('data', (d) => (buf += d.toString()));

async function mcpCall(method, params = {}) {
  const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const req =
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { name: method, arguments: params },
    }) + '\n';

  const prevLen = buf.length;
  sock.write(req);
  await sleep(800);

  // Find our response
  const newData = buf.slice(prevLen);
  return newData;
}

// MCP initialize
const initReq =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 'init1',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e-waiter', version: '1.0.0' },
    },
  }) + '\n';
sock.write(initReq);
await sleep(1000);

console.log('Initial buf:', buf.slice(0, 300));

// Poll bridge status
console.log('\n=== Waiting for Bridge Connection ===');
let connected = false;

const start = Date.now();
for (let i = 0; ; i++) {
  const elapsed = Date.now() - start;
  if (elapsed > SRV_TIMEOUT) {
    console.log(`\n❌ Timed out after ${SRV_TIMEOUT / 1000}s`);
    break;
  }

  const prevLen = buf.length;
  const req =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'p' + i,
      method: 'tools/call',
      params: { name: 'easyeda_bridge_status', arguments: {} },
    }) + '\n';
  sock.write(req);
  await sleep(1200); // wait for response

  const resp = buf.slice(prevLen);

  if (resp.includes('"connected"')) {
    try {
      const parsed = JSON.parse(resp);
      const result = parsed?.result?.content?.[0]?.text;
      if (result) {
        const data = JSON.parse(result);
        if (data.connected === true) {
          console.log(`\n✅ Bridge CONNECTED at ${Math.round(elapsed / 1000)}s!`);
          connected = true;
          break;
        } else if (i % 4 === 0) {
          process.stdout.write(`\r  ⌛ ${Math.round(elapsed / 1000)}s – bridge: disconnected`);
        }
      }
    } catch {}
  }

  if (i % 4 === 0 && i > 0) {
    process.stdout.write(`\r  ⌛ ${Math.round(elapsed / 1000)}s – waiting...`);
  }
}

console.log();

if (connected) {
  // Fetch capabilities
  console.log('\n=== Fetching Bridge Capabilities ===');
  const prevLen = buf.length;
  sock.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'caps',
      method: 'tools/call',
      params: { name: 'easyeda_bridge_call', arguments: { method: 'listFunctions', params: {} } },
    }) + '\n',
  );
  await sleep(1500);

  const capsResp = buf.slice(prevLen);
  console.log('Capabilities response:', capsResp.slice(0, 2000));

  // Fetch bridge info
  const prevLen2 = buf.length;
  sock.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'info',
      method: 'tools/call',
      params: { name: 'easyeda_bridge_call', arguments: { method: 'getInfo', params: {} } },
    }) + '\n',
  );
  await sleep(1500);
  console.log('Info response:', buf.slice(prevLen2, prevLen2 + 2000));

  // Try easyeda_bridge_call with schematic methods
  const schematicMethods = [
    'schematic.createNetFlag',
    'schematic.createNetPort',
    'schematic.connectPinToNet',
    'schematic.connectPinsByNet',
    'schematic.validateNetlist',
  ];

  console.log('\n=== Testing Schematic Methods ===');
  for (const method of schematicMethods) {
    const p = buf.length;
    sock.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'sm_' + method.replace('.', '_'),
        method: 'tools/call',
        params: { name: 'easyeda_bridge_call', arguments: { method, params: {} } },
      }) + '\n',
    );
    await sleep(1000);
    const r = buf.slice(p, p + 1000);
    console.log(`${method}:`, r.slice(0, 300));
  }
}

// Final output
console.log('\n=== Server Logs ===');
console.log((serverProcess.stdoutLog + serverProcess.stderrLog).slice(-3000));

console.log('\n=== Raw Buffer (last 2000) ===');
console.log(buf.slice(-2000));

sock.destroy();
serverProcess.shutdown('waiter complete');
serverProcess.detach();
process.exit(connected ? 0 : 1);

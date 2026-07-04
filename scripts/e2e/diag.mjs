#!/usr/bin/env node
/**
 * Quick diagnostic - checks bridge state, capabilities, and tool registration
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

let reqId = 0;
const pending = new Map();
let serverStdin;

function mcpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('TIMEOUT'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    serverStdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function toolCall(name, args = {}) {
  const r = await mcpCall('tools/call', { name, arguments: args });
  const text = (r.content || [])
    .map((c) => c.text || '')
    .join('\n')
    .trim();
  return { text, isError: r.isError === true };
}

const server = spawn('node', ['dist/index.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TRANSPORT: 'stdio',
    LOG_LEVEL: 'silent',
    TOOL_PROFILE: 'full',
    BRIDGE_RECONNECT_MAX_ATTEMPTS: '0',
    BRIDGE_RECONNECT_INTERVAL_MS: '1000',
    BRIDGE_TIMEOUT_MS: '30000',
  },
});
serverStdin = server.stdin;
let exited = false;
server.on('exit', () => {
  exited = true;
});

const rl = createInterface({ input: server.stdout });
rl.on('line', (line) => {
  let p;
  try {
    p = JSON.parse(line);
  } catch {
    return;
  }
  if (p.id && pending.has(p.id)) {
    const { resolve, reject, timer } = pending.get(p.id);
    pending.delete(p.id);
    clearTimeout(timer);
    if (p.error) reject(new Error(p.error.message));
    else resolve(p.result);
  }
});
server.stderr.on('data', () => {});

async function main() {
  await new Promise((r) => setTimeout(r, 2000));
  if (exited) {
    console.log('❌ Server exited');
    process.exit(1);
  }

  await mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'diag', version: '1' },
  });
  serverStdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log('✅ Server initialized');

  // Wait for bridge
  let bs = '';
  for (let i = 0; i < 120; i++) {
    try {
      const { text } = await toolCall('easyeda_bridge_status');
      bs = text;
      if (JSON.parse(text).connected) {
        console.log(`✅ Bridge connected (${i + 1}s)`);
        break;
      }
    } catch {}
    if ((i + 1) % 15 === 0) console.log(`  waiting... ${i + 1}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!bs || !JSON.parse(bs).connected) {
    console.log('❌ Bridge not connected after 120s');
    console.log('Last status:', bs.slice(0, 300));
    process.exit(1);
  }

  // Bridge status detail
  const status = JSON.parse(bs);
  console.log('\n=== BRIDGE STATUS ===');
  console.log(`connected: ${status.connected}`);
  console.log(`version: ${status.version}`);
  console.log(`projectId: ${status.documentInfo?.projectId || status.projectId || '(none)'}`);
  console.log(`capabilities (${(status.capabilities || []).length}):`);
  (status.capabilities || []).forEach((c) => console.log(`  - ${c}`));

  // Check schema methods
  const required = [
    'schematic.createNetFlag',
    'schematic.createNetPort',
    'schematic.connectPinToNet',
    'schematic.connectPinsByNet',
    'schematic.validateNetlist',
    'project.save',
  ];
  console.log('\n=== REQUIRED METHODS ===');
  const caps = new Set(status.capabilities || []);
  for (const m of required) {
    console.log(`  ${caps.has(m) ? '✅' : '❌'} ${m}`);
  }

  // List available MCP tools
  console.log('\n=== MCP TOOLS ===');
  const tools = await mcpCall('tools/list');
  const toolNames = (tools.tools || []).map((t) => t.name);
  const netTools = toolNames.filter(
    (n) =>
      n.includes('net') ||
      n.includes('flag') ||
      n.includes('connect') ||
      n.includes('save') ||
      n.includes('validate'),
  );
  console.log('Relevant tools:');
  netTools.forEach((t) => console.log(`  - ${t}`));
  console.log(`\nTotal tools: ${toolNames.length}`);

  // Try calling a diagnostic tool
  console.log('\n=== HEALTH CHECK ===');
  try {
    const { text } = await toolCall('easyeda_health_check');
    console.log(text.slice(0, 300));
  } catch (e) {
    console.log(`Health check failed: ${e.message}`);
  }

  server.stdin.end();
  setTimeout(() => process.exit(0), 1000);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Quick diagnostic - checks bridge state, capabilities, and tool registration.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sleep, startStdioMcpServer } from './harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const mcp = startStdioMcpServer({ cwd: repoRoot });

async function main() {
  await sleep(2000);
  if (mcp.exited) {
    console.log('❌ Server exited');
    process.exit(1);
  }

  await mcp.mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'diag', version: '1' },
  });
  mcp.notifyInitialized();
  console.log('✅ Server initialized');

  let bs = '';
  for (let i = 0; i < 120; i++) {
    try {
      const { text } = await mcp.toolCall('easyeda_bridge_status');
      bs = text;
      if (JSON.parse(text).connected) {
        console.log(`✅ Bridge connected (${i + 1}s)`);
        break;
      }
    } catch {}
    if ((i + 1) % 15 === 0) console.log(`  waiting... ${i + 1}s`);
    await sleep(1000);
  }

  if (!bs || !JSON.parse(bs).connected) {
    console.log('❌ Bridge not connected after 120s');
    console.log('Last status:', bs.slice(0, 300));
    mcp.shutdown('bridge not connected');
    process.exit(1);
  }

  const status = JSON.parse(bs);
  console.log('\n=== BRIDGE STATUS ===');
  console.log(`connected: ${status.connected}`);
  console.log(`version: ${status.version}`);
  console.log(`projectId: ${status.documentInfo?.projectId || status.projectId || '(none)'}`);
  console.log(`capabilities (${(status.capabilities || []).length}):`);
  (status.capabilities || []).forEach((c) => console.log(`  - ${c}`));

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
  for (const method of required) {
    console.log(`  ${caps.has(method) ? '✅' : '❌'} ${method}`);
  }

  console.log('\n=== MCP TOOLS ===');
  const tools = await mcp.mcpCall('tools/list');
  const toolNames = (tools.tools || []).map((tool) => tool.name);
  const netTools = toolNames.filter(
    (name) =>
      name.includes('net') ||
      name.includes('flag') ||
      name.includes('connect') ||
      name.includes('save') ||
      name.includes('validate'),
  );
  console.log('Relevant tools:');
  netTools.forEach((tool) => console.log(`  - ${tool}`));
  console.log(`\nTotal tools: ${toolNames.length}`);

  console.log('\n=== HEALTH CHECK ===');
  try {
    const { text } = await mcp.toolCall('easyeda_health_check');
    console.log(text.slice(0, 300));
  } catch (err) {
    console.log(`Health check failed: ${err.message}`);
  }

  mcp.shutdown('diag complete');
  mcp.detach();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  mcp.shutdown('diag fatal');
  process.exit(1);
});

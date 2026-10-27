import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');

async function runCase(modern: boolean, skillsEnabled: boolean) {
  const client = new Client(
    { name: 'skills-interoperability-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, 'src/index.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      TRANSPORT: 'stdio',
      MCP_BRIDGE_BACKEND: 'remote_relay',
      MCP_V2_EXPERIMENTAL: String(modern),
      MCP_SKILLS_ENABLED: String(skillsEnabled),
      LOG_LEVEL: 'silent',
      TOOL_PROFILE: 'core',
    },
  });

  try {
    await client.connect(transport);
    const skills = new SkillsClient(client);
    expect(skills.supported).toBe(skillsEnabled);
    const listing = await skills.list();
    if (!skillsEnabled) {
      expect(listing.skills).toHaveLength(0);
      return;
    }
    expect(listing.invalid).toEqual([]);
    expect(listing.skills.map((s) => s.frontmatter.name).sort()).toEqual([
      'design-validation',
      'easyeda-component-review',
    ]);
    for (const entry of listing.skills) {
      const body = await skills.read(entry);
      expect(body.verified).toBe(true);
      expect(body.body).toContain('EasyEDA');
    }
    if (modern) {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(listing.ttlMs).toBe(0);
      expect(listing.cacheScope).toBe('private');
    }
  } finally {
    await client.close();
  }
}

describe('Skills over MCP process interoperability', () => {
  it('serves verified pilot skills on modern 2026-07-28 stdio', async () => {
    await runCase(true, true);
  }, 35_000);
  it('serves the same skills to a legacy 2025-11-25 client', async () => {
    await runCase(false, true);
  }, 35_000);
  it('exposes no skills in a default-off legacy session', async () => {
    await runCase(false, false);
  }, 35_000);
});

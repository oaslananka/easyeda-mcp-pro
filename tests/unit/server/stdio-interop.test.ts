import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');

function transport(modernEnabled: boolean): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, 'src/index.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      TRANSPORT: 'stdio',
      MCP_BRIDGE_BACKEND: 'remote_relay',
      MCP_V2_EXPERIMENTAL: String(modernEnabled),
      TOOL_PROFILE: 'core',
      LOG_LEVEL: 'silent',
    },
  });
}

describe('stdio protocol interop', () => {
  it('negotiates MCP 2026-07-28 and lists tools when the experimental flag is enabled', async () => {
    const client = new Client(
      { name: 'modern-stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const stdio = transport(true);

    try {
      await client.connect(stdio);
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 15_000);

  it('preserves the legacy initialize lifecycle when the experimental flag is disabled', async () => {
    const client = new Client({ name: 'legacy-stdio-test', version: '1.0.0' });
    const stdio = transport(false);

    try {
      await client.connect(stdio);
      expect(client.getProtocolEra()).toBe('legacy');
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 15_000);
});

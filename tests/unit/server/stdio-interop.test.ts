import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('Expected IPv4 loopback address');
  }
  await new Promise<void>((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
  });
  return address.port;
}

async function freeLoopbackPortCandidates(count = 3): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freeLoopbackPort());
  return [...ports];
}

function disconnectedLocalTransport(
  modernEnabled: boolean,
  ports: readonly number[],
  directory: string,
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, 'src/index.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      TRANSPORT: 'stdio',
      MCP_BRIDGE_BACKEND: 'local_bridge',
      MCP_V2_EXPERIMENTAL: String(modernEnabled),
      BRIDGE_PORT: String(ports[0]),
      BRIDGE_PORT_SCAN: ports.join(','),
      BRIDGE_WAIT_FOR_EDA_MS: '0',
      TOOL_PROFILE: 'core',
      LOG_LEVEL: 'silent',
      DATA_DIR: directory,
      JLCSEARCH_ENABLED: 'false',
      KEYLESS_SOURCING_ENABLED: 'false',
      JLCPCB_MODE: 'disabled',
      MOUSER_ENABLED: 'false',
      DIGIKEY_ENABLED: 'false',
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
  }, 30_000);

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
  }, 30_000);

  it('uses a fallback loopback port when the first candidate is already occupied', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easyeda-mcp-stdio-busy-port-'));
    const ports = await freeLoopbackPortCandidates();
    const blocker = createServer();
    const client = new Client({ name: 'busy-loopback-stdio-test', version: '1.0.0' });
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(ports[0], '127.0.0.1', resolve);
      });
      await client.connect(disconnectedLocalTransport(false, ports, directory));
      const status = await client.callTool({ name: 'easyeda_bridge_status', arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ connected: false });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 45_000);

  it.each([false, true])(
    'does not invent PCB findings or approval without a local editor (modern=%s)',
    async (modernEnabled) => {
      const directory = await mkdtemp(join(tmpdir(), 'easyeda-mcp-stdio-no-editor-'));
      const client = new Client(
        { name: 'disconnected-native-evidence', version: '1.0.0' },
        modernEnabled ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
      );
      try {
        // Sampling releases its probe listener before the child binds. Fall back
        // if another process acquires the first port in the meantime.
        const ports = await freeLoopbackPortCandidates();
        await client.connect(disconnectedLocalTransport(modernEnabled, ports, directory));
        if (modernEnabled) {
          expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
        }
        const tools = (await client.listTools()).tools;
        for (const name of ['easyeda_bridge_status', 'easyeda_engineering_review']) {
          expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
        }
        const status = await client.callTool({ name: 'easyeda_bridge_status', arguments: {} });
        expect(status.isError).not.toBe(true);
        expect(status.structuredContent).toMatchObject({ connected: false });

        const review = await client.callTool({
          name: 'easyeda_engineering_review',
          arguments: { projectId: 'isolated-no-editor-fixture' },
        });
        expect(review.isError).not.toBe(true);
        expect(review.structuredContent).toMatchObject({
          overall_status: 'UNKNOWN',
          pcb_context: 'unverified',
          engineering_sign_off: false,
          summary: { PASS: 0, FAIL: 0 },
        });
        const observed = review.structuredContent as {
          input_evidence: { quality: string }[];
          summary: { UNKNOWN: number };
        };
        expect(observed.summary.UNKNOWN).toBeGreaterThan(0);
        expect(observed.input_evidence.length).toBeGreaterThan(0);
        expect(observed.input_evidence.every((item) => item.quality !== 'measured')).toBe(true);
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    },
    45_000,
  );
});

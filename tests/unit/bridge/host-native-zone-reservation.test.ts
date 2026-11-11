import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { BridgeManager } from '../../../src/bridge/manager.js';
import { NativeZoneHostWriterCoordinator } from '../../../src/bridge/native-zone-host-writer.js';
import { EasyedaApiMethodSchema } from '../../../src/bridge/types.js';
import { SERVER_VERSION } from '../../../src/config/version.js';

const dirs: string[] = [];

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), 'zone-host-bridge-reservation-'));
  dirs.push(created);
  return created;
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(Error('No local port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function connectedBridge(lockDirectory: string) {
  const ports = new Set<number>();
  while (ports.size < 3) ports.add(await availablePort());
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_TOKEN: 'reservation-test-token',
    BRIDGE_WAIT_FOR_EDA_MS: 0,
    BRIDGE_PORT_SCAN: [...ports].join(','),
    DATA_DIR: directory(),
  });
  const manager = new BridgeManager(config, new NativeZoneHostWriterCoordinator(lockDirectory));
  await manager.connect();
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket('ws://127.0.0.1:' + manager.activePort);
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
  return { manager, socket };
}

function message(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => {
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handshake(
  manager: BridgeManager,
  socket: WebSocket,
  extensionVersion: string | undefined = SERVER_VERSION,
  methodListHash: string | undefined = manager.methodRegistryHash,
  omitHash = false,
) {
  const reply = message(socket);
  socket.send(
    JSON.stringify({
      type: 'handshake',
      protocol: 'easyeda-mcp-pro.bridge',
      protocolVersion: '1.0.0',
      clientName: 'easyeda-mcp-pro',
      sessionToken: 'reservation-test-token',
      extensionVersion,
      ...(omitHash ? {} : { methodListHash }),
    }),
  );
  expect(await reply).toMatchObject({ type: 'hello' });
}

async function reserve(socket: WebSocket, params?: unknown) {
  const reply = message(socket);
  socket.send(
    JSON.stringify({
      id: 'host-reservation-1',
      type: 'request',
      method: 'host.nativeZone.reserve',
      ...(params === undefined ? {} : { params }),
    }),
  );
  return reply;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('internal host native zone reservation Bridge transport', () => {
  it('is not a public PCB/MCP tool or an editor API method', () => {
    expect(EasyedaApiMethodSchema.options).not.toContain('host.nativeZone.reserve');
  });

  it('accepts one exact-version active local extension and retains the host lock after disconnect', async () => {
    const lockRoot = directory();
    const { manager, socket } = await connectedBridge(lockRoot);
    try {
      await handshake(manager, socket);
      await expect(reserve(socket)).resolves.toMatchObject({
        type: 'response',
        ok: true,
        result: {
          granted: true,
          independentRecoveryRequired: true,
          authorizesMutation: false,
        },
      });
      await expect(reserve(socket)).resolves.toMatchObject({
        ok: true,
        result: { granted: false, authorizesMutation: false },
      });
    } finally {
      socket.close();
      manager.disconnect('reservation test');
    }
    expect(await new NativeZoneHostWriterCoordinator(lockRoot).tryAcquire()).toBeNull();
  });

  it('cannot reserve from an unauthenticated socket before handshake', async () => {
    const { manager, socket } = await connectedBridge(directory());
    try {
      await expect(reserve(socket)).resolves.toMatchObject({
        ok: false,
        error: { code: 'BRIDGE_NOT_READY' },
      });
    } finally {
      socket.close();
      manager.disconnect('unauthenticated test');
    }
  });

  it('rejects version drift and missing registry hash before any reservation', async () => {
    for (const [version, methodHash, omit] of [
      ['0.0.0', 'outdated-methods', false],
      [SERVER_VERSION, undefined, true],
    ] as const) {
      const lockRoot = directory();
      const { manager, socket } = await connectedBridge(lockRoot);
      try {
        await handshake(manager, socket, version, methodHash, omit);
        await expect(reserve(socket)).resolves.toMatchObject({
          ok: false,
          error: { code: 'BRIDGE_NOT_READY' },
        });
        const lease = await new NativeZoneHostWriterCoordinator(lockRoot).tryAcquire();
        expect(lease).not.toBeNull();
      } finally {
        socket.close();
        manager.disconnect('version drift test');
      }
    }
  });

  it('rejects user-defined reservation paths and parameters without filesystem side effects', async () => {
    const lockRoot = directory();
    const { manager, socket } = await connectedBridge(lockRoot);
    try {
      await handshake(manager, socket);
      await expect(reserve(socket, { path: '/tmp/outside' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' },
      });
      expect(await new NativeZoneHostWriterCoordinator(lockRoot).tryAcquire()).not.toBeNull();
    } finally {
      socket.close();
      manager.disconnect('reject params test');
    }
  });

  it('cannot release a reserved host lock through an extension-supplied request', async () => {
    const lockRoot = directory();
    const { manager, socket } = await connectedBridge(lockRoot);
    try {
      await handshake(manager, socket);
      await expect(reserve(socket)).resolves.toMatchObject({
        ok: true,
        result: { granted: true, authorizesMutation: false },
      });
      const result = message(socket);
      socket.send(
        JSON.stringify({
          id: 'forged-release',
          type: 'request',
          method: 'host.nativeZone.release',
        }),
      );
      await expect(result).resolves.toMatchObject({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND' },
      });
      expect(await new NativeZoneHostWriterCoordinator(lockRoot).tryAcquire()).toBeNull();
    } finally {
      socket.close();
      manager.disconnect('no socket release test');
    }
  });

  it('serializes reservations across distinct server sessions and ports', async () => {
    const lockRoot = directory();
    const a = await connectedBridge(lockRoot);
    const b = await connectedBridge(lockRoot);
    try {
      await Promise.all([handshake(a.manager, a.socket), handshake(b.manager, b.socket)]);
      const [aResult, bResult] = await Promise.all([reserve(a.socket), reserve(b.socket)]);
      expect(
        [aResult, bResult].filter((v) => (v.result as { granted: boolean })?.granted),
      ).toHaveLength(1);
    } finally {
      a.socket.close();
      b.socket.close();
      a.manager.disconnect('contention test');
      b.manager.disconnect('contention test');
    }
    expect(await new NativeZoneHostWriterCoordinator(lockRoot).tryAcquire()).toBeNull();
  });
});

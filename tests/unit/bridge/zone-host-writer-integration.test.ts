import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { SERVER_VERSION } from '../../../src/config/version.js';
import { BridgeManager } from '../../../src/bridge/manager.js';
import { NativeZoneHostWriterCoordinator } from '../../../src/bridge/native-zone-host-writer.js';
import {
  createPersistentZoneWriteFence,
  NATIVE_ZONE_FENCE_KEY,
} from '../../../easyeda-bridge-extension/src/zone-durable-write-fence.js';
import {
  createHostZoneReservationClient,
  type HostZoneReservationClient,
} from '../../../easyeda-bridge-extension/src/zone-host-reservation-client.js';
import { type RuntimeTimers } from '../../../easyeda-bridge-extension/src/runtime-timers.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not sample loopback test port')));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:' + port);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function hello(manager: BridgeManager, socket: WebSocket): Promise<void> {
  const incoming = new Promise<Record<string, unknown>>((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  socket.send(
    JSON.stringify({
      type: 'handshake',
      protocol: 'easyeda-mcp-pro.bridge',
      protocolVersion: '1.0.0',
      clientName: 'easyeda-mcp-pro',
      sessionToken: 'native-writer-integration-test',
      extensionVersion: SERVER_VERSION,
      methodListHash: manager.methodRegistryHash,
    }),
  );
  expect(await incoming).toMatchObject({ type: 'hello' });
}

function createLiveTransport(socket: WebSocket): HostZoneReservationClient {
  const timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'> = {
    setTimeout: (callback, ms) => ({
      source: 'native',
      kind: 'timeout',
      handle: setTimeout(callback, ms),
    }),
    clearTimeout: (handle) => {
      if (handle?.source === 'native') clearTimeout(handle.handle as ReturnType<typeof setTimeout>);
    },
  };
  const client = createHostZoneReservationClient({
    send: (request) => socket.send(JSON.stringify(request)),
    isLocalConnected: () => socket.readyState === WebSocket.OPEN,
    timers,
  });
  socket.on('message', (raw) => {
    client.handleResponse(JSON.parse(raw.toString()) as unknown);
  });
  socket.on('close', () => client.reset());
  return client;
}

const reservation = {
  focus: 'isolated-project:disposable-pcb',
  before: { sources: new Map(), derived: new Map() },
  expected: {
    net: 'GND',
    layer: 2,
    polygonSignature: JSON.stringify(['R', 1400, -1200, 120, 80, 0, 0]),
    fillMethod: 'solid',
    preserveSilos: true,
    pourName: 'HOST_RPC_TEST_NO_NATIVE_WRITE',
    pourPriority: 1,
    lineWidth: 0.2,
    locked: false,
  },
};

describe('real localhost WebSocket host-writer RPC + persistent native fence contract', () => {
  it('reserves the OS-host lease before marking storage, blocks other servers, and retains it after disconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'easyeda-zone-wire-integration-'));
    let manager: BridgeManager | undefined;
    let socket: WebSocket | undefined;
    try {
      const ports = new Set<number>();
      while (ports.size < 3) ports.add(await freePort());
      const config = EnvSchema.parse({
        NODE_ENV: 'test',
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: [...ports].join(','),
        BRIDGE_TOKEN: 'native-writer-integration-test',
        BRIDGE_WAIT_FOR_EDA_MS: 0,
        DATA_DIR: join(root, 'bridge-data'),
      });
      const coordinator = new NativeZoneHostWriterCoordinator(join(root, 'user-home-lock'));
      manager = new BridgeManager(config, coordinator);
      // Follow the real manager -> host service -> OS coordinator path;
      // reading state must never create a lock directory.
      expect(await manager.inspectNativeZoneHostReservation()).toBe('unreserved');
      await manager.connect();
      expect(await manager.inspectNativeZoneHostReservation()).toBe('unreserved');
      socket = await open(manager.activePort);
      await hello(manager, socket);
      const client = createLiveTransport(socket);

      // This is a fake native storage object. No EasyEDA project or PCB writes
      // happen: the test proves the real Bridge RPC and fence contract only.
      const values = new Map<string, string>();
      const storage = {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          values.set(key, value);
        },
      };
      const fence = createPersistentZoneWriteFence(storage, client);
      // A crash-retained native pending marker must block BEFORE any host
      // RPC. Otherwise the host lease would be acquired and orphaned even
      // though the stored marker already prohibits another mutation.
      values.set(NATIVE_ZONE_FENCE_KEY, 'existing-unknown-pending-marker');
      expect(await fence.reserve(reservation)).toBe(false);
      expect(await manager.inspectNativeZoneHostReservation()).toBe('unreserved');
      await expect(
        lstat(join(root, 'user-home-lock', 'native-zone-writer-v1.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      values.delete(NATIVE_ZONE_FENCE_KEY);

      // The preflight rejection did not consume the one-attempt host client:
      // this is the first genuine host reservation for this test process.
      expect(await fence.reserve(reservation)).toBe(true);
      expect(await manager.inspectNativeZoneHostReservation()).toBe('reserved');
      expect(
        (await lstat(join(root, 'user-home-lock', 'native-zone-writer-v1.lock'))).isDirectory(),
      ).toBe(true);
      expect(values.get(NATIVE_ZONE_FENCE_KEY)).toContain('reconciliation-required');
      expect(await fence.inspect()).toEqual({
        blocked: true,
        focus: reservation.focus,
      });
      expect(
        await new NativeZoneHostWriterCoordinator(join(root, 'user-home-lock')).tryAcquire(),
      ).toBeNull();

      // A distinct extension transport may send a new request but cannot
      // acquire the same host's lease or overwrite the existing marker.
      const other = createLiveTransport(socket);
      expect(await createPersistentZoneWriteFence(storage, other).reserve(reservation)).toBe(false);
      expect(values.size).toBe(1);
      socket.close();
      manager.disconnect('native-zone integration test completed');
      expect(await manager.inspectNativeZoneHostReservation()).toBe('reserved');
      expect(
        await new NativeZoneHostWriterCoordinator(join(root, 'user-home-lock')).tryAcquire(),
      ).toBeNull();

      // Simulate a fresh extension-side SYS_Storage view after app reconstruction:
      // a durable pending marker does not become absent when client objects reset.
      const reopened = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: storage.setItem,
      };
      expect(await createPersistentZoneWriteFence(reopened, other).inspect()).toMatchObject({
        blocked: true,
        focus: reservation.focus,
      });
    } finally {
      socket?.close();
      manager?.disconnect('test cleanup');
      rmSync(root, { recursive: true, force: true });
    }
  });
});

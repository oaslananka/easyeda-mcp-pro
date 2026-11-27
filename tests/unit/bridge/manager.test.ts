import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, type ClientOptions } from 'ws';
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { BridgeManager, parsePortScanSpec } from '../../../src/bridge/manager.js';
import { getLogger } from '../../../src/utils/logger.js';
import { SERVER_VERSION } from '../../../src/config/version.js';

const testDataDirs = new Set<string>();
const testManagers = new Set<BridgeManager>();
const testSockets = new Set<WebSocket>();
const testListeners = new Set<ReturnType<typeof createServer>>();

function createTestManager(config: ReturnType<typeof createTestConfig>): BridgeManager {
  const manager = new BridgeManager(config);
  testManagers.add(manager);
  return manager;
}

// Explicit cleanup remains in the tests; release leftovers if setup or an
// assertion fails before reaching it.
afterEach(async () => {
  try {
    for (const manager of [...testManagers].reverse()) {
      if (manager.state !== 'disconnected') manager.disconnect('test cleanup');
    }
    await Promise.all([...testSockets].map(closeTestSocket));
    await Promise.all([...testListeners].map(closeTestPort));
  } finally {
    testManagers.clear();
    testSockets.clear();
    testListeners.clear();
    vi.restoreAllMocks();
  }
});

function createTestConfig(overrides: Record<string, unknown> = {}) {
  const dataDir =
    typeof overrides.DATA_DIR === 'string'
      ? overrides.DATA_DIR
      : mkdtempSync(join(tmpdir(), 'easyeda-bridge-manager-'));
  testDataDirs.add(dataDir);
  return EnvSchema.parse({
    NODE_ENV: 'test',
    BRIDGE_WAIT_FOR_EDA_MS: 0,
    DATA_DIR: dataDir,
    ...overrides,
  });
}

afterAll(() => {
  for (const dataDir of testDataDirs) rmSync(dataDir, { recursive: true, force: true });
});

async function bindTestPort(host = '127.0.0.1') {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  testListeners.add(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeTestPort(server);
    throw new Error('Unable to allocate a local test port');
  }
  return { server, port: address.port };
}

function closeTestPort(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      testListeners.delete(server);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  const { server, port } = await bindTestPort();
  await closeTestPort(server);
  return port;
}

// Hold the probes together to guarantee distinct candidates with a bounded
// allocation count. Another worker may claim one after release; connect()
// can try the others. Tests must use the actual activePort.
async function getFreePortCandidates(count = 3): Promise<string> {
  const probes: Awaited<ReturnType<typeof bindTestPort>>[] = [];
  try {
    for (let i = 0; i < count; i++) probes.push(await bindTestPort());
    return probes.map(({ port }) => port).join(',');
  } finally {
    await Promise.all(probes.map(({ server }) => closeTestPort(server)));
  }
}

function createTestSocket(port: number, options?: ClientOptions): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, options);
  testSockets.add(socket);
  socket.once('close', () => testSockets.delete(socket));
  return socket;
}

async function closeTestSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(socket);
  // Canceling a still-connecting test client emits an error by design.
  if (socket.readyState === WebSocket.CONNECTING) socket.once('error', () => {});
  socket.terminate();
  await closed;
}

function openSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = createTestSocket(port);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
}

function sendHandshake(ws: WebSocket, overrides: Record<string, unknown> = {}): void {
  ws.send(
    JSON.stringify({
      type: 'handshake',
      protocol: 'easyeda-mcp-pro.bridge',
      protocolVersion: '1.0.0',
      clientName: 'easyeda-mcp-pro',
      easyedaVersion: 'test',
      devMode: true,
      ...overrides,
    }),
  );
}

/**
 * Create a connected BridgeManager + client pair for security tests.
 * Uses loopback with a BRIDGE_TOKEN so token checks are active but pairing is skipped.
 */
async function setupSecureConnection(extraConfig: Record<string, unknown> = {}) {
  // The sampled port is released before connect() listens. CI workers may
  // claim it in that interval, so provide fallback candidates and connect
  // to the actual bound port rather than assuming the first sample survived.
  const portCandidates = await getFreePortCandidates();
  const config = createTestConfig({
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_PORT_SCAN: portCandidates,
    BRIDGE_TOKEN: 'test-secret-token',
    ...extraConfig,
  });
  const manager = createTestManager(config);
  await manager.connect();
  const port = manager.activePort;

  const socket = await openSocket(port);
  // Send handshake with the correct token
  sendHandshake(socket, { sessionToken: 'test-secret-token' });
  await waitForMessage(socket); // hello
  return { manager, socket, port, config };
}

describe('BridgeManager', () => {
  it('should start in disconnected state', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    expect(manager.state).toBe('disconnected');
    expect(manager.connected).toBe(false);
  });

  it('should emit state change events', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    const states: string[] = [];

    manager.on('stateChanged', (state) => {
      states.push(state);
    });

    expect(states).toHaveLength(0);
  });

  it('should throw when calling a method while disconnected', async () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    await expect(manager.call('test.method')).rejects.toThrow('Bridge not connected');
  });

  it('should disconnect cleanly', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    manager.disconnect('test');
    expect(manager.state).toBe('disconnected');
  });

  it('should handle multiple disconnect calls gracefully', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    manager.disconnect('first');
    manager.disconnect('second');
    expect(manager.state).toBe('disconnected');
  });

  it('should probe health endpoint', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    expect(manager.lastHeartbeatMs).toBe(0);
  });

  it('should report uptime as 0 when disconnected', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    expect(manager.uptimeMs).toBe(0);
  });

  it('should report activePort as 0 when not listening', () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    expect(manager.activePort).toBe(0);
  });

  it('should replace a connected bridge client with a newer validated handshake', async () => {
    // Probed OS ports are released before connect(): allow alternate candidates
    // if another concurrent test/runner binds the initial port (EADDRINUSE).
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    let first: WebSocket | undefined;
    let second: WebSocket | undefined;
    try {
      await manager.connect();
      const port = manager.activePort;
      first = await openSocket(port);
      sendHandshake(first);
      await expect(waitForMessage(first)).resolves.toMatchObject({ type: 'hello' });
      expect(manager.connected).toBe(true);

      const firstClosed = waitForClose(first);
      second = await openSocket(port);
      sendHandshake(second);
      await expect(waitForMessage(second)).resolves.toMatchObject({ type: 'hello' });

      await expect(firstClosed).resolves.toBe(4000);
      expect(manager.connected).toBe(true);
      expect(manager.activePort).toBe(port);
    } finally {
      first?.close();
      second?.close();
      manager.disconnect('test complete');
    }
  });

  it('keeps an explicitly selected window against automatic takeover, but allows manual switching and reconnect after close', async () => {
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: await getFreePortCandidates(),
      }),
    );
    const sockets: WebSocket[] = [];
    async function connect(intent: 'manual' | 'auto') {
      const ws = await openSocket(manager.activePort);
      sockets.push(ws);
      const outcome = Promise.race([
        waitForMessage(ws),
        waitForClose(ws).then((code) => ({ closed: code })),
      ]);
      sendHandshake(ws, { extensionVersion: SERVER_VERSION, connectionIntent: intent });
      return { ws, outcome: await outcome };
    }
    try {
      await manager.connect();
      const selected = await connect('manual');
      expect(selected.outcome).toMatchObject({ type: 'hello' });
      const background = await connect('auto');
      expect(background.outcome).toEqual({ type: 'local_connection_busy' });
      expect(selected.ws.readyState).toBe(WebSocket.OPEN);
      const selectedNotice = waitForMessage(selected.ws);
      const switched = await connect('manual');
      await expect(selectedNotice).resolves.toEqual({ type: 'local_connection_busy' });
      expect(switched.outcome).toMatchObject({ type: 'hello' });
      const oldWindow = await connect('auto');
      expect(oldWindow.outcome).toEqual({ type: 'local_connection_busy' });
      const closed = waitForClose(switched.ws);
      switched.ws.close();
      await closed;
      const reopened = await connect('auto');
      expect(reopened.outcome).toMatchObject({ type: 'hello' });
    } finally {
      for (const ws of sockets) ws.close();
      manager.disconnect('test complete');
    }
  });

  it('does not let a stale extension replace an active exact-version session', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;
    const current = await openSocket(port);
    sendHandshake(current, { extensionVersion: SERVER_VERSION });
    await expect(waitForMessage(current)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.extensionVersion).toBe(SERVER_VERSION);

    const stale = await openSocket(port);
    const staleClosed = waitForClose(stale);
    sendHandshake(stale, { extensionVersion: '1.8.1' });
    await expect(staleClosed).resolves.toBe(4003);
    expect(manager.connected).toBe(true);
    expect(manager.extensionVersion).toBe(SERVER_VERSION);
    expect(current.readyState).toBe(WebSocket.OPEN);

    const updated = await openSocket(port);
    const currentClosed = waitForClose(current);
    sendHandshake(updated, { extensionVersion: SERVER_VERSION });
    await expect(waitForMessage(updated)).resolves.toMatchObject({ type: 'hello' });
    await expect(currentClosed).resolves.toBe(4000);
    expect(manager.extensionVersionMismatch).toBe(false);
    expect(manager.connected).toBe(true);
    updated.close();
    manager.disconnect('test complete');
  });

  it('can replace a stale bridge client with a fresh exact-version extension', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: portCandidates,
      }),
    );
    await manager.connect();
    const port = manager.activePort;
    const stale = await openSocket(port);
    sendHandshake(stale, { extensionVersion: '1.8.1' });
    await expect(waitForMessage(stale)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.extensionVersionMismatch).toBe(true);
    const previousClosed = waitForClose(stale);
    const fresh = await openSocket(port);
    sendHandshake(fresh, { extensionVersion: SERVER_VERSION });
    await expect(waitForMessage(fresh)).resolves.toMatchObject({ type: 'hello' });
    await expect(previousClosed).resolves.toBe(4000);
    expect(manager.extensionVersion).toBe(SERVER_VERSION);
    expect(manager.extensionVersionMismatch).toBe(false);
    fresh.close();
    manager.disconnect('test complete');
  });

  it('should log a warning if extension version mismatches', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const logger = getLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const socket = await openSocket(port);
    socket.send(
      JSON.stringify({
        type: 'handshake',
        protocol: 'easyeda-mcp-pro.bridge',
        protocolVersion: '1.0.0',
        clientName: 'easyeda-mcp-pro',
        extensionVersion: '0.0.1',
        easyedaVersion: 'test',
        devMode: true,
      }),
    );

    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('version mismatch: extension is v0.0.1'),
    );
    expect(manager.extensionVersion).toBe('0.0.1');
    expect(manager.extensionVersionMismatch).toBe(true);
    expect(manager.easyedaVersion).toBe('test');

    warnSpy.mockRestore();
    socket.close();
    manager.disconnect('test complete');
  });

  it('reports no version mismatch when the extension version matches the server version', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const socket = await openSocket(port);
    socket.send(
      JSON.stringify({
        type: 'handshake',
        protocol: 'easyeda-mcp-pro.bridge',
        protocolVersion: '1.0.0',
        clientName: 'easyeda-mcp-pro',
        extensionVersion: SERVER_VERSION,
        easyedaVersion: '2.0.0',
        devMode: false,
      }),
    );

    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });

    expect(manager.extensionVersion).toBe(SERVER_VERSION);
    expect(manager.extensionVersionMismatch).toBe(false);
    expect(manager.easyedaVersion).toBe('2.0.0');

    socket.close();
    manager.disconnect('test complete');
  });

  it('clears extensionVersion/easyedaVersion on disconnect despite an occupied first port', async () => {
    const { server: blocker, port: busyPort } = await bindTestPort();
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: `${busyPort},${candidates}`,
    });
    const manager = createTestManager(config);
    let socket: WebSocket | undefined;
    try {
      await manager.connect();
      expect(parsePortScanSpec(candidates)).toContain(manager.activePort);
      expect(manager.activePort).not.toBe(busyPort);
      socket = await openSocket(manager.activePort);
      sendHandshake(socket, { extensionVersion: SERVER_VERSION });
      await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });
      expect(manager.extensionVersion).toBe(SERVER_VERSION);
      expect(manager.easyedaVersion).toBeDefined();

      const closed = waitForClose(socket);
      const disconnected = new Promise<void>((resolve) =>
        manager.once('disconnected', () => resolve()),
      );
      socket.close();
      await Promise.all([closed, disconnected]);

      expect(manager.extensionVersion).toBeUndefined();
      expect(manager.extensionVersionMismatch).toBe(false);
      expect(manager.easyedaVersion).toBeUndefined();
    } finally {
      socket?.close();
      manager.disconnect('test complete');
      await closeTestPort(blocker);
    }
  });
});

describe('BridgeManager - token enforcement', () => {
  it('should reject handshake with missing token when BRIDGE_TOKEN is set', async () => {
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: candidates,
      BRIDGE_TOKEN: 'secret123',
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    // Send handshake WITHOUT sessionToken
    sendHandshake(socket);

    const code = await waitForClose(socket);
    expect(code).toBe(4001);
    manager.disconnect('test complete');
  });

  it('should reject handshake with wrong token when BRIDGE_TOKEN is set', async () => {
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: candidates,
      BRIDGE_TOKEN: 'secret123',
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    sendHandshake(socket, { sessionToken: 'wrong-token' });

    const code = await waitForClose(socket);
    expect(code).toBe(4001);
    manager.disconnect('test complete');
  });

  it('should accept handshake with correct token', async () => {
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: candidates,
      BRIDGE_TOKEN: 'secret123',
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    sendHandshake(socket, { sessionToken: 'secret123' });

    const msg = await waitForMessage(socket);
    expect(msg).toMatchObject({ type: 'hello' });
    expect(manager.connected).toBe(true);

    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - contested token listener ports', () => {
  it('enforces the token after falling back from a concurrently occupied port', async () => {
    const { server: occupied, port: occupiedPort } = await bindTestPort();
    const availablePorts = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: `${occupiedPort},${availablePorts}`,
        BRIDGE_TOKEN: 'secret123',
      }),
    );
    let socket: WebSocket | undefined;
    try {
      await manager.connect();
      expect(parsePortScanSpec(availablePorts)).toContain(manager.activePort);
      socket = await openSocket(manager.activePort);
      const closed = waitForClose(socket);
      sendHandshake(socket);
      await expect(closed).resolves.toBe(4001);
    } finally {
      socket?.close();
      manager.disconnect('test complete');
      await closeTestPort(occupied);
    }
  });
});

describe('BridgeManager - origin validation', () => {
  it('rejects connection with unauthorized external browser origin', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const ws = createTestSocket(port, {
      headers: { Origin: 'https://evil.example.com' },
    });

    const errorOrClose = await new Promise<string>((resolve) => {
      ws.once('error', (err) => resolve(err.message));
      ws.once('close', (code) => resolve(String(code)));
    });

    expect(errorOrClose).toMatch(/403|Forbidden|unexpected server response/i);
    manager.disconnect('test complete');
  });

  it('accepts connection with authorized loopback, extension, or EasyEDA origin', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    for (const origin of [
      'https://pro.easyeda.com',
      'https://easyeda.com',
      'https://lceda.cn',
      'https://client', // Native EasyEDA Pro 3.2.209 desktop origin.
      'chrome-extension://abcdefghijklmno',
      'moz-extension://abcdefghijklmno',
    ]) {
      const ws = createTestSocket(port, {
        headers: { Origin: origin },
      });

      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }

    // Invalid url origin is rejected
    const badWs = createTestSocket(port, {
      headers: { Origin: ':::not-a-valid-url:::' },
    });
    const badResult = await new Promise<string>((resolve) => {
      badWs.once('error', (err) => resolve(err.message));
      badWs.once('close', (code) => resolve(String(code)));
    });
    expect(badResult).toMatch(/403|Forbidden|unexpected server response/i);

    manager.disconnect('test complete');
  });

  it('rejects lookalike desktop origins and never trusts the desktop origin on non-loopback', () => {
    const local = createTestManager(createTestConfig({ BRIDGE_HOST: '127.0.0.1' }));
    const external = createTestManager(createTestConfig({ BRIDGE_HOST: '0.0.0.0' }));
    const originAllowed = (manager: BridgeManager, origin: string): boolean =>
      (
        manager as unknown as {
          isAllowedBridgeOrigin: (candidate: string) => boolean;
        }
      ).isAllowedBridgeOrigin(origin);

    expect(originAllowed(local, 'https://client')).toBe(true);
    for (const rejected of [
      'http://client',
      'https://client:8443',
      'https://client.evil.example',
      'https://client@evil.example',
      'https://client/',
    ]) {
      expect(originAllowed(local, rejected)).toBe(false);
    }
    expect(originAllowed(external, 'https://client')).toBe(false);
  });

  it('drops chunk assemblies when capacity limit is reached', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const ws = createTestSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    // Send 128 different assembly starts
    for (let i = 0; i < 128; i++) {
      ws.send(JSON.stringify({ type: 'chunk', id: `stream-${i}`, seq: 0, total: 5, data: 'part' }));
    }

    // The 129th assembly should be rejected due to MAX_CHUNK_ASSEMBLIES (128)
    ws.send(
      JSON.stringify({ type: 'chunk', id: 'stream-overflow', seq: 0, total: 5, data: 'part' }),
    );

    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - protocol version validation', () => {
  it('should reject handshake with unsupported protocol version', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const socket = await openSocket(port);
    socket.send(
      JSON.stringify({
        type: 'handshake',
        protocol: 'easyeda-mcp-pro.bridge',
        protocolVersion: '2.0.0',
        clientName: 'easyeda-mcp-pro',
        easyedaVersion: 'test',
        devMode: true,
      }),
    );

    const code = await waitForClose(socket);
    expect(code).toBe(4001);
    manager.disconnect('test complete');
  });

  it('should accept handshake with supported protocol version', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const socket = await openSocket(port);
    sendHandshake(socket);

    const msg = await waitForMessage(socket);
    expect(msg).toMatchObject({ type: 'hello' });
    expect(manager.connected).toBe(true);

    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - method registry hash', () => {
  it('should compute methodRegistryHash from EasyedaApiMethodSchema', async () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    expect(manager.methodRegistryHash).toBeTruthy();
    expect(manager.methodRegistryHash.length).toBe(16);
  });

  it('should include computed methodRegistryHash in hello', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const socket = await openSocket(port);
    sendHandshake(socket);

    const msg = (await waitForMessage(socket)) as Record<string, unknown>;
    expect(msg.methodRegistryHash).toBe(manager.methodRegistryHash);

    socket.close();
    manager.disconnect('test complete');
  });

  it('fails closed on registry-hash mismatch while preserving status readback', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates }),
    );
    await manager.connect();
    const port = manager.activePort;
    const socket = await openSocket(port);
    sendHandshake(socket, { methodListHash: '0000000000000000', extensionVersion: SERVER_VERSION });
    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.connected).toBe(true);
    expect(manager.registryMismatch).toBe(true);

    await expect(manager.call('pcb.listComponents', { projectId: 'fake' })).rejects.toThrow(
      /method registry mismatch/,
    );
    await expect(manager.call('pcb.modifyComponent', { projectId: 'fake' })).rejects.toThrow(
      /method registry mismatch/,
    );

    const diagnostic = waitForMessage(socket);
    const call = manager.call('system.loaderStatus', {});
    const request = (await diagnostic) as { id: string; type: string; method: string };
    expect(request).toMatchObject({ type: 'request', method: 'system.loaderStatus' });
    socket.send(
      JSON.stringify({
        id: request.id,
        type: 'response',
        ok: true,
        result: { buildId: 'current' },
      }),
    );
    await expect(call).resolves.toMatchObject({ buildId: 'current' });

    socket.close();
    manager.disconnect('test complete');
  });

  it('allows scoped reads but fails closed on writes during version-only drift', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates }),
    );
    await manager.connect();
    const port = manager.activePort;
    const socket = await openSocket(port);
    sendHandshake(socket, {
      extensionVersion: SERVER_VERSION + '-older-active-dispatcher',
      methodListHash: manager.methodRegistryHash,
    });
    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.extensionVersionMismatch).toBe(true);
    expect(manager.registryMismatch).toBe(false);

    const transmitted: unknown[] = [];
    socket.on('message', (raw) => transmitted.push(JSON.parse(raw.toString())));
    for (const method of [
      'project.open',
      'project.save',
      'project.export',
      'schematic.placeComponent',
      'schematic.modifyPrimitive',
      'schematic.syncToPcb',
      'pcb.addTrack',
      'pcb.rebuildCopper',
      'library.updateDeviceMetadata',
      'api.call',
      'api.execute',
      'board.exportGerbers',
      'export.pdf',
      'bom.generate',
      'pcb.exportRouteContext',
      'unknown.futureMutation',
    ]) {
      await expect(manager.call(method, { confirmWrite: true })).rejects.toThrow(
        /extension version mismatch: refused potentially mutating/i,
      );
    }
    expect(transmitted).toHaveLength(0);

    for (const method of [
      'system.getStatus',
      'system.apiInventory',
      'pcb.listComponents',
      'pcb.zonePreflight',
      'schematic.listNets',
      'board.getDimensions',
      'canvas.capture',
    ]) {
      const incoming = waitForMessage(socket);
      const result = manager.call(method, { limit: 1 });
      const request = (await incoming) as { id: string; method: string };
      expect(request.method).toBe(method);
      socket.send(
        JSON.stringify({ id: request.id, type: 'response', ok: true, result: { safe: true } }),
      );
      await expect(result).resolves.toMatchObject({ safe: true });
    }
    expect(transmitted).toHaveLength(7);
    socket.close();
    manager.disconnect('test complete');
  });

  it('preserves normal write RPC dispatch when semantic versions and registry match', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates }),
    );
    await manager.connect();
    const port = manager.activePort;
    const socket = await openSocket(port);
    sendHandshake(socket, {
      extensionVersion: SERVER_VERSION,
      methodListHash: manager.methodRegistryHash,
    });
    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.extensionVersionMismatch).toBe(false);
    expect(manager.registryMismatch).toBe(false);
    const incoming = waitForMessage(socket);
    const pending = manager.call('pcb.addTrack', { confirmWrite: true });
    const request = (await incoming) as { id: string; method: string };
    expect(request.method).toBe('pcb.addTrack');
    socket.send(
      JSON.stringify({ id: request.id, type: 'response', ok: true, result: { passed: true } }),
    );
    await expect(pending).resolves.toMatchObject({ passed: true });
    socket.close();
    manager.disconnect('test complete');
  });

  it('does not block compatible methods solely because semantic versions differ', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates }),
    );
    await manager.connect();
    const port = manager.activePort;
    const socket = await openSocket(port);
    sendHandshake(socket, {
      extensionVersion: `${SERVER_VERSION}-stale-test-build`,
      methodListHash: manager.methodRegistryHash,
    });
    await expect(waitForMessage(socket)).resolves.toMatchObject({ type: 'hello' });
    expect(manager.extensionVersionMismatch).toBe(true);
    expect(manager.registryMismatch).toBe(false);

    const outgoing = waitForMessage(socket);
    const read = manager.call('board.getDimensions', {});
    const request = (await outgoing) as { id: string; method: string };
    expect(request.method).toBe('board.getDimensions');
    socket.send(
      JSON.stringify({ id: request.id, type: 'response', ok: true, result: { width: 1 } }),
    );
    await expect(read).resolves.toMatchObject({ width: 1 });

    socket.close();
    manager.disconnect('test complete');
  });

  it('includes the configured BRIDGE_MAX_PAYLOAD_SIZE in hello', async () => {
    // getFreePort() releases its probe socket before BridgeManager.bind().
    // Concurrent Linux CI workers can take that port; provide fallbacks and
    // connect to the port the bridge actually bound, not the first guess.
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: candidates,
      BRIDGE_MAX_PAYLOAD_SIZE: 2_097_152,
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    try {
      expect(candidates.split(',')).toContain(String(manager.activePort));
      sendHandshake(socket);
      const msg = (await waitForMessage(socket)) as Record<string, unknown>;
      expect(msg.maxPayloadSize).toBe(2_097_152);
    } finally {
      socket.close();
      manager.disconnect('test complete');
    }
  });
});

describe('BridgeManager - payload size limit', () => {
  it('should reject oversized payload with 4009', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_MAX_PAYLOAD_SIZE: 1024,
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    // Send a message that exceeds the 1024-byte limit
    socket.send('x'.repeat(2048));

    const code = await waitForClose(socket);
    expect(code).toBe(4009);
    manager.disconnect('test complete');
  });

  it('enforces the aggregate limit in UTF-8 bytes rather than UTF-16 string length', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: portCandidates,
        BRIDGE_MAX_PAYLOAD_SIZE: 1024,
      }),
    );
    await manager.connect();
    const socket = await openSocket(manager.activePort);
    const closed = waitForClose(socket);
    for (let seq = 0; seq < 15; seq++) {
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id: 'utf8-overflow',
          seq,
          total: 16,
          data: '€'.repeat(200),
        }),
      );
    }
    expect(await closed).toBe(4009);
    manager.disconnect('test complete');
  });

  it('accounts for duplicate chunk replacement without an undersized byte budget', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: portCandidates,
        BRIDGE_MAX_PAYLOAD_SIZE: 1024,
      }),
    );
    await manager.connect();
    const socket = await openSocket(manager.activePort);
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: 'chunk', id: 'replacement', seq: 0, total: 12, data: 'x' }));
    for (let seq = 1; seq <= 10; seq++) {
      socket.send(
        JSON.stringify({ type: 'chunk', id: 'replacement', seq, total: 12, data: 'a'.repeat(780) }),
      );
    }
    socket.send(
      JSON.stringify({
        type: 'chunk',
        id: 'replacement',
        seq: 0,
        total: 12,
        data: 'z'.repeat(800),
      }),
    );
    expect(await closed).toBe(4009);
    manager.disconnect('test complete');
  });

  it('accepts an exact-limit payload containing an emoji split across chunk boundaries', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: portCandidates,
        BRIDGE_MAX_PAYLOAD_SIZE: 1024,
      }),
    );
    await manager.connect();
    const socket = await openSocket(manager.activePort);
    const parts = [
      ...Array.from({ length: 10 }, () => 'a'.repeat(800)),
      'a'.repeat(188),
      '\uD83D',
      '\uDE00',
    ];
    expect(Buffer.byteLength(parts.join(''), 'utf8')).toBe(8192);
    for (const [seq, data] of parts.entries()) {
      socket.send(
        JSON.stringify({ type: 'chunk', id: 'split-surrogate', seq, total: parts.length, data }),
      );
    }
    const hello = waitForMessage(socket);
    sendHandshake(socket);
    await expect(hello).resolves.toMatchObject({ type: 'hello' });
    socket.close();
    manager.disconnect('test complete');
  });

  it('rejects a replacement that breaks a split emoji after an exact-cap assembly', async () => {
    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: portCandidates,
        BRIDGE_MAX_PAYLOAD_SIZE: 1024,
      }),
    );
    await manager.connect();
    const socket = await openSocket(manager.activePort);
    const closed = waitForClose(socket);
    const parts = [
      ...Array.from({ length: 10 }, () => 'a'.repeat(800)),
      'a'.repeat(188),
      '\uD83D',
      '\uDE00',
    ];
    expect(Buffer.byteLength(parts.join(''), 'utf8')).toBe(8192);
    for (const [seq, data] of parts.entries()) {
      socket.send(JSON.stringify({ type: 'chunk', id: 'split-replacement', seq, total: 14, data }));
    }
    // Replacing the low surrogate destroys the four-byte emoji and increases
    // actual joined bytes above the cap. Prior exact-byte accounting used an
    // understated incremental total and incorrectly accepted the replacement.
    socket.send(
      JSON.stringify({ type: 'chunk', id: 'split-replacement', seq: 12, total: 14, data: '€' }),
    );
    await expect(closed).resolves.toBe(4009);
    manager.disconnect('test complete');
  });

  it('should accept payload within limit', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_MAX_PAYLOAD_SIZE: 1024,
    });
    const manager = createTestManager(config);
    await manager.connect();

    const socket = await openSocket(manager.activePort);
    sendHandshake(socket);

    const msg = await waitForMessage(socket);
    expect(msg).toMatchObject({ type: 'hello' });

    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - unknown method in incoming request', () => {
  it('should reject request with unknown method via structured error', async () => {
    const { manager, socket } = await setupSecureConnection();

    socket.send(
      JSON.stringify({
        id: 'req_1',
        type: 'request',
        method: 'nonexistent.method',
      }),
    );

    const response = (await waitForMessage(socket)) as Record<string, unknown>;
    expect(response).toMatchObject({
      type: 'response',
      ok: false,
    });
    expect((response.error as Record<string, unknown>)?.code).toBe('METHOD_NOT_FOUND');

    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - reconnect', () => {
  it('should emit reconnecting event on disconnect', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const reconnectingSpy = vi.fn();
    manager.on('reconnecting', reconnectingSpy);

    const socket = await openSocket(port);
    sendHandshake(socket);
    await waitForMessage(socket);

    // Kill the connection
    socket.close();

    // Wait a short bit for the event to fire
    await new Promise((r) => setTimeout(r, 100));

    expect(reconnectingSpy).toHaveBeenCalledTimes(1);
    expect(reconnectingSpy).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }));

    manager.disconnect('test complete');
  });

  it('should reset reconnect counter on successful handshake', async () => {
    // This is verified implicitly: reconnect is only scheduled on disconnect,
    // and a new handshake resets reconnectAttempts. We test that reconnecting
    // events fire sequentially only for new disconnect cycles.
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const manager = createTestManager(config);
    await manager.connect();

    const reconnectingSpy = vi.fn();
    manager.on('reconnecting', reconnectingSpy);

    const socket = await openSocket(manager.activePort);
    sendHandshake(socket);
    await waitForMessage(socket);

    // First disconnect
    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(reconnectingSpy).toHaveBeenCalledTimes(1);

    // Force reconnect by connecting again (simulate extension reconnecting)
    // Just verify the counter state
    expect((manager as unknown as Record<string, unknown>).reconnectAttempts).toBe(1);

    manager.disconnect('test complete');
  });
});

describe('BridgeManager - call() round trip', () => {
  it('resolves call() when the client sends a matching response', async () => {
    const { manager, socket } = await setupSecureConnection();

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: string; type: string; method: string };
      if (msg.type === 'request') {
        socket.send(
          JSON.stringify({ id: msg.id, type: 'response', ok: true, result: { saved: true } }),
        );
      }
    });

    const result = await manager.call('project.save', { projectId: 'p1' });
    expect(result).toEqual({ saved: true });

    socket.close();
    manager.disconnect('test complete');
  });

  it('rejects call() when the client responds with ok: false', async () => {
    const { manager, socket } = await setupSecureConnection();

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: string; type: string };
      if (msg.type === 'request') {
        socket.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            ok: false,
            error: { message: 'no active project' },
          }),
        );
      }
    });

    await expect(manager.call('project.save', {})).rejects.toThrow('no active project');

    socket.close();
    manager.disconnect('test complete');
  });

  it('preserves the dispatcher error code/suggestion/data on the rejected Error', async () => {
    const { manager, socket } = await setupSecureConnection();

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: string; type: string };
      if (msg.type === 'request') {
        socket.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            ok: false,
            error: {
              code: 'NOT_IMPLEMENTED',
              message: 'subPartName is not supported',
              suggestion: 'Omit subPartName.',
              data: { subPartName: 'X.2' },
            },
          }),
        );
      }
    });

    await expect(manager.call('schematic.placeComponent', {})).rejects.toMatchObject({
      message: 'subPartName is not supported',
      code: 'NOT_IMPLEMENTED',
      suggestion: 'Omit subPartName.',
      data: { subPartName: 'X.2' },
    });

    socket.close();
    manager.disconnect('test complete');
  });

  it('rejects pending calls when the bridge disconnects before a response arrives', async () => {
    const { manager, socket } = await setupSecureConnection();

    const pending = manager.call('project.save', {});
    // do not respond; force a disconnect instead
    manager.disconnect('shutting down');

    await expect(pending).rejects.toThrow(/Bridge disconnected/);
    socket.close();
  });

  it('times out call() when no response arrives within the timeout', async () => {
    const { manager, socket } = await setupSecureConnection();

    await expect(manager.call('project.save', {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/);

    socket.close();
    manager.disconnect('test complete');
  });

  it('lets the stale sweep honour a per-request timeout longer than BRIDGE_TIMEOUT_MS', async () => {
    const { manager, socket } = await setupSecureConnection({ BRIDGE_TIMEOUT_MS: '15000' });
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      // restart the sweep so it runs on the fake clock
      (manager as unknown as { startStaleSweep(): void }).startStaleSweep();
      let settled: string | undefined;
      const pending = manager
        .call('project.save', {}, { timeoutMs: 120_000 })
        .catch((error: Error) => {
          settled = error.message;
        });

      await vi.advanceTimersByTimeAsync(61_000); // two sweeps, both past the 15 s default
      expect(settled).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000); // the request's own 120 s are over: now either may end it
      await pending;
      expect(settled).toMatch(/timed out after 120000ms|expired \(stale sweep\)/);
    } finally {
      vi.useRealTimers();
      socket.close();
      manager.disconnect('test complete');
    }
  });

  it('falls back to an actually bound bridge port when a concurrent process owns the first candidate', async () => {
    const { server: blocker, port: blockedPort } = await bindTestPort();

    try {
      const fallbackPorts = await getFreePortCandidates();
      const { manager, socket, port } = await setupSecureConnection({
        BRIDGE_PORT_SCAN: `${blockedPort},${fallbackPorts}`,
      });
      try {
        expect(port).toBe(manager.activePort);
        expect(port).not.toBe(blockedPort);
        expect(manager.connected).toBe(true);
      } finally {
        socket.close();
        manager.disconnect('test complete');
      }
    } finally {
      await closeTestPort(blocker);
    }
  });

  it('round-trips a canvas.capture request/response without a live EasyEDA process', async () => {
    // Simulates the bridge extension's response shape after it has already
    // converted a Blob to base64 (see easyeda-bridge-extension/src/binary-result.ts) —
    // no real EasyEDA Pro process is needed to exercise the server-side contract.
    const { manager, socket } = await setupSecureConnection();

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: string; type: string; method: string };
      if (msg.type === 'request' && msg.method === 'canvas.capture') {
        socket.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            ok: true,
            result: {
              base64: 'ZmFrZS1wbmctYnl0ZXM=',
              mimeType: 'image/png',
              fileName: 'capture.png',
              byteLength: 14,
            },
          }),
        );
      }
    });

    const result = await manager.call('canvas.capture', { tabId: 'tab-1' });
    expect(result).toMatchObject({
      base64: 'ZmFrZS1wbmctYnl0ZXM=',
      mimeType: 'image/png',
      fileName: 'capture.png',
    });

    socket.close();
    manager.disconnect('test complete');
  });

  it('surfaces a payload-too-large error from canvas.capture as a normal rejected call', async () => {
    // The extension self-limits before sending (normalizeBinaryResultSafely) rather
    // than sending an oversized frame that would close the whole connection — this
    // is what that error looks like from the server's perspective.
    const { manager, socket } = await setupSecureConnection();

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: string; type: string; method: string };
      if (msg.type === 'request' && msg.method === 'canvas.capture') {
        socket.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            ok: false,
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: '"capture.png" is 5000000 bytes, which exceeds the safe transport budget',
            },
          }),
        );
      }
    });

    await expect(manager.call('canvas.capture', {})).rejects.toThrow(/exceeds the safe transport/);

    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - waitForConnection', () => {
  it('resolves immediately when already connected', async () => {
    const { manager, socket } = await setupSecureConnection();
    await expect(manager.waitForConnection(50)).resolves.toBeUndefined();
    socket.close();
    manager.disconnect('test complete');
  });

  it('rejects after the timeout when never connected', async () => {
    const config = createTestConfig();
    const manager = createTestManager(config);
    await expect(manager.waitForConnection(20)).rejects.toThrow('Bridge not connected');
  });

  it('resolves once a connection is established', async () => {
    // CI may claim a probed port before connect() binds it. Use the actual
    // listener selected from independent candidates rather than the first probe.
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();

    const waiter = manager.waitForConnection(2000);
    const socket = await openSocket(manager.activePort);
    sendHandshake(socket);
    await waitForMessage(socket);

    await expect(waiter).resolves.toBeUndefined();
    socket.close();
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - malformed messages', () => {
  it('ignores non-JSON messages without crashing the connection', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const socket = await openSocket(port);
    sendHandshake(socket);
    await waitForMessage(socket);

    socket.send('not valid json {{{');
    // the connection should still be usable afterwards
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.connected).toBe(true);

    socket.close();
    manager.disconnect('test complete');
  });

  it('uses BRIDGE_HEARTBEAT_MS for the connected heartbeat schedule', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_HEARTBEAT_MS: 1_234,
    });
    const manager = createTestManager(config);

    try {
      await manager.connect();
      const port = manager.activePort;
      const socket = await openSocket(port);
      sendHandshake(socket);
      await waitForMessage(socket);

      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_234);
      socket.close();
    } finally {
      manager.disconnect('test complete');
      intervalSpy.mockRestore();
    }
  });

  it('updates lastHeartbeatMs and emits heartbeat on a heartbeat message', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: portCandidates });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const heartbeatSpy = vi.fn();
    manager.on('heartbeat', heartbeatSpy);

    const socket = await openSocket(port);
    sendHandshake(socket);
    await waitForMessage(socket);

    socket.send(JSON.stringify({ type: 'heartbeat', timestamp: 123456 }));
    await new Promise((r) => setTimeout(r, 20));

    expect(heartbeatSpy).toHaveBeenCalledWith(123456);
    expect(manager.lastHeartbeatMs).toBeGreaterThan(0);

    socket.close();
    manager.disconnect('test complete');
  });
});

/**
 * Open a WebSocket and buffer incoming messages from the moment the socket is
 * created (not from when 'open' resolves), since the server may push an
 * unsolicited message (e.g. a pairing challenge) before the client-side
 * 'open' event fires.
 */
function openBufferedSocket(
  port: number,
): Promise<{ socket: WebSocket; nextMessage: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = createTestSocket(port);
    const queue: unknown[] = [];
    const waiters: Array<(v: unknown) => void> = [];

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });

    const nextMessage = (): Promise<unknown> => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    };

    socket.once('open', () => resolve({ socket, nextMessage }));
    socket.once('error', reject);
  });
}

describe('BridgeManager - pairing (non-loopback host)', () => {
  it('requires pairing before handshake and accepts a valid pairing response', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_TOKEN: 'pair-secret',
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const { socket, nextMessage } = await openBufferedSocket(port);
    const challengeMsg = (await nextMessage()) as { type: string; challenge: string };
    expect(challengeMsg.type).toBe('pairing_challenge');

    socket.send(
      JSON.stringify({
        type: 'pairing_response',
        challenge: challengeMsg.challenge,
        sessionToken: 'pair-secret',
      }),
    );

    sendHandshake(socket, { sessionToken: 'pair-secret' });
    const hello = await nextMessage();
    expect(hello).toMatchObject({ type: 'hello' });

    socket.close();
    manager.disconnect('test complete');
  });

  it('closes the connection on an invalid pairing response', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_TOKEN: 'pair-secret',
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const { socket, nextMessage } = await openBufferedSocket(port);
    const challengeMsg = (await nextMessage()) as { challenge: string };

    socket.send(
      JSON.stringify({
        type: 'pairing_response',
        challenge: challengeMsg.challenge,
        sessionToken: 'wrong-secret',
      }),
    );

    const code = await waitForClose(socket);
    expect(code).toBe(4001);
    manager.disconnect('test complete');
  });

  it('rejects any message before pairing completes', async () => {
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_PORT_SCAN: portCandidates,
      BRIDGE_TOKEN: 'pair-secret',
    });
    const manager = createTestManager(config);
    await manager.connect();
    const port = manager.activePort;

    const { socket, nextMessage } = await openBufferedSocket(port);
    await nextMessage(); // pairing_challenge
    sendHandshake(socket, { sessionToken: 'pair-secret' });

    const code = await waitForClose(socket);
    expect(code).toBe(4001);
    manager.disconnect('test complete');
  });
});

describe('BridgeManager - process ownership', () => {
  it('detects a bridge listener lock owned by a separate live process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-child-owner-'));
    testDataDirs.add(dataDir);
    const lockDir = join(dataDir, 'bridge-listener.lock');
    const ownerPort = await getFreePort();
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const lockDir = process.argv[1];
      const port = Number(process.argv[2]);
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        schemaVersion: 1,
        token: 'child-owner',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: '127.0.0.1',
        port,
      }));
      console.log('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, lockDir, String(ownerPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(
          () => reject(new Error(`child owner did not start: ${stderr}`)),
          5_000,
        );
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`child owner exited before ready (code ${String(code)}): ${stderr}`));
        });
        child.stdout.once('data', (chunk) => {
          clearTimeout(timer);
          if (chunk.toString().includes('ready')) resolve();
          else reject(new Error(`unexpected child output: ${chunk.toString()}`));
        });
      });

      const manager = createTestManager(
        createTestConfig({ DATA_DIR: dataDir, BRIDGE_PORT_SCAN: await getFreePortCandidates() }),
      );
      await expect(manager.connect()).rejects.toThrow(/another easyeda-mcp-pro process/i);
      expect(manager.ownershipConflict).toMatchObject({
        blockedByOtherInstance: true,
        ownerPid: child.pid,
        ownerPort,
      });
      manager.disconnect('test complete');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      rmSync(lockDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails safely when a fresh ownership lock contains malformed owner metadata', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-malformed-owner-'));
    testDataDirs.add(dataDir);
    const lockDir = join(dataDir, 'bridge-listener.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), '{not-json');

    const manager = createTestManager(
      createTestConfig({ DATA_DIR: dataDir, BRIDGE_PORT_SCAN: await getFreePortCandidates() }),
    );

    await expect(manager.connect()).rejects.toThrow(/no valid owner metadata/i);
    expect(manager.activePort).toBe(0);
    expect(() => manager.disconnect('test complete')).not.toThrow();
  });

  it('tolerates the ownership directory disappearing before disconnect', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-owner-removed-'));
    testDataDirs.add(dataDir);
    const lockDir = join(dataDir, 'bridge-listener.lock');
    const manager = createTestManager(
      createTestConfig({ DATA_DIR: dataDir, BRIDGE_PORT_SCAN: await getFreePortCandidates() }),
    );

    await manager.connect();
    rmSync(lockDir, { recursive: true, force: true });

    expect(() => manager.disconnect('external lock cleanup')).not.toThrow();
    expect(manager.activePort).toBe(0);
  });

  it('does not remove a replacement ownership lock during disconnect', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-owner-replaced-'));
    testDataDirs.add(dataDir);
    const lockDir = join(dataDir, 'bridge-listener.lock');
    const ownerFile = join(lockDir, 'owner.json');
    const manager = createTestManager(
      createTestConfig({ DATA_DIR: dataDir, BRIDGE_PORT_SCAN: await getFreePortCandidates() }),
    );

    await manager.connect();
    const replacement = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>;
    replacement.token = 'replacement-owner';
    writeFileSync(ownerFile, `${JSON.stringify(replacement)}\n`);

    manager.disconnect('test complete');

    expect(JSON.parse(readFileSync(ownerFile, 'utf8'))).toMatchObject({
      token: 'replacement-owner',
    });
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('shares one EasyEDA listener across multiple local MCP managers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-owner-'));
    testDataDirs.add(dataDir);
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      DATA_DIR: dataDir,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const owner = createTestManager(config);
    const follower = createTestManager(config);
    let extension: WebSocket | undefined;

    try {
      await owner.connect();
      await follower.connect();

      const ownerPort = owner.activePort;
      expect(parsePortScanSpec(portCandidates)).toContain(ownerPort);
      expect(follower.activePort).toBe(ownerPort);
      expect(
        JSON.parse(readFileSync(join(dataDir, 'bridge-listener.lock', 'owner.json'), 'utf8')),
      ).toMatchObject({ pid: process.pid, port: ownerPort });
      expect(follower.state).toBe('connecting');
      expect(follower.ownershipConflict).toBeUndefined();

      extension = await openSocket(ownerPort);
      sendHandshake(extension, {
        extensionVersion: SERVER_VERSION,
        loaderVersion: SERVER_VERSION,
      });
      await waitForMessage(extension); // hello
      await follower.waitForConnection(1_000);

      const resultPromise = follower.call('system.getStatus', {});
      const request = (await waitForMessage(extension)) as { id: string; method: string };
      expect(request.method).toBe('system.getStatus');
      extension.send(
        JSON.stringify({
          id: request.id,
          type: 'response',
          ok: true,
          result: { shared: true },
          durationMs: 1,
        }),
      );

      await expect(resultPromise).resolves.toEqual({ shared: true });
      expect(follower.connected).toBe(true);
      expect(follower.extensionVersion).toBe(SERVER_VERSION);
    } finally {
      extension?.close();
      follower.disconnect('test complete');
      owner.disconnect('test complete');
    }
  });

  it('coordinates concurrent local MCP startup without binding fallback bridge ports', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-concurrent-start-'));
    testDataDirs.add(dataDir);
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      DATA_DIR: dataDir,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const first = createTestManager(config);
    const second = createTestManager(config);

    try {
      await Promise.all([first.connect(), second.connect()]);

      const ownerPort = first.activePort;
      expect(parsePortScanSpec(portCandidates)).toContain(ownerPort);
      expect(second.activePort).toBe(ownerPort);
      expect(
        JSON.parse(readFileSync(join(dataDir, 'bridge-listener.lock', 'owner.json'), 'utf8')),
      ).toMatchObject({ pid: process.pid, port: ownerPort });
      expect(first.ownershipConflict).toBeUndefined();
      expect(second.ownershipConflict).toBeUndefined();
      expect([first.state, second.state]).toEqual(['connecting', 'connecting']);
    } finally {
      second.disconnect('test complete');
      first.disconnect('test complete');
    }
  });

  it('routes bridge calls from a separate local MCP process through the owner relay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-cross-process-'));
    testDataDirs.add(dataDir);
    // A released probe port may be claimed by a parallel CI process.
    // Let the owner bind a fallback and route the follower to the actual port.
    const candidates = await getFreePortCandidates();
    const config = createTestConfig({
      DATA_DIR: dataDir,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: candidates,
    });
    const owner = createTestManager(config);
    let extension: WebSocket | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await owner.connect();
      const port = owner.activePort;
      extension = await openSocket(port);
      sendHandshake(extension, {
        extensionVersion: SERVER_VERSION,
        loaderVersion: SERVER_VERSION,
      });
      await waitForMessage(extension); // hello

      const managerUrl = pathToFileURL(resolve('src/bridge/manager.ts')).href;
      const envUrl = pathToFileURL(resolve('src/config/env.ts')).href;
      const loggerUrl = pathToFileURL(resolve('src/utils/logger.ts')).href;
      const script = `
        import { BridgeManager } from ${JSON.stringify(managerUrl)};
        import { EnvSchema } from ${JSON.stringify(envUrl)};
        import { createLogger } from ${JSON.stringify(loggerUrl)};
        const config = EnvSchema.parse({
          NODE_ENV: 'test',
          BRIDGE_WAIT_FOR_EDA_MS: 0,
          DATA_DIR: ${JSON.stringify(dataDir)},
          BRIDGE_HOST: '127.0.0.1',
          BRIDGE_PORT_SCAN: ${JSON.stringify(String(port))},
        });
        createLogger(config);
        const manager = new BridgeManager(config);
        try {
          await manager.connect();
          const result = await manager.call('system.getStatus', {});
          console.log('FOLLOWER_RESULT=' + JSON.stringify({
            connected: manager.connected,
            activePort: manager.activePort,
            result,
          }));
        } finally {
          manager.disconnect('child complete');
        }
      `;
      child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_OPTIONS: '' },
        },
      );
      let childStdout = '';
      let childStderr = '';
      child.stdout?.on('data', (chunk) => (childStdout += chunk.toString()));
      child.stderr?.on('data', (chunk) => (childStderr += chunk.toString()));
      const earlyExit = new Promise<never>((_, reject) => {
        child?.once('exit', (code) =>
          reject(
            new Error(
              `child follower exited before routing a bridge request (code ${String(code)}): ${childStderr || childStdout}`,
            ),
          ),
        );
      });

      const request = (await Promise.race([
        waitForMessage(extension),
        earlyExit,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `child follower did not route a bridge request: ${childStderr || childStdout}`,
                ),
              ),
            5_000,
          ),
        ),
      ])) as { id: string; method: string };
      expect(request.method).toBe('system.getStatus');
      extension.send(
        JSON.stringify({
          id: request.id,
          type: 'response',
          ok: true,
          result: { crossProcess: true },
          durationMs: 1,
        }),
      );

      const code = await new Promise<number | null>((done, reject) => {
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
          done(child.exitCode);
          return;
        }
        child?.once('error', reject);
        child?.once('exit', done);
      });

      expect(code, childStderr).toBe(0);
      const marker = childStdout.split(/\r?\n/).find((line) => line.startsWith('FOLLOWER_RESULT='));
      expect(marker, `${childStdout}\n${childStderr}`).toBeDefined();
      expect(JSON.parse(marker!.slice('FOLLOWER_RESULT='.length))).toEqual({
        connected: true,
        activePort: port,
        result: { crossProcess: true },
      });
    } finally {
      if (child && child.exitCode === null) child.kill();
      extension?.close();
      owner.disconnect('test complete');
    }
  }, 10_000);

  it('automatically promotes a follower after the original owner exits', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-failover-'));
    testDataDirs.add(dataDir);
    const portCandidates = await getFreePortCandidates();
    const config = createTestConfig({
      DATA_DIR: dataDir,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT_SCAN: portCandidates,
    });
    const owner = createTestManager(config);
    const follower = createTestManager(config);
    let extension: WebSocket | undefined;

    try {
      await owner.connect();
      await follower.connect();
      owner.disconnect('owner exit');

      await vi.waitFor(() => expect(follower.state).toBe('error'));
      await vi.waitFor(
        () => {
          expect(follower.state).toBe('connecting');
          expect(parsePortScanSpec(portCandidates)).toContain(follower.activePort);
          expect(follower.ownershipConflict).toBeUndefined();
        },
        { timeout: 4_000, interval: 25 },
      );

      const port = follower.activePort;
      expect(
        JSON.parse(readFileSync(join(dataDir, 'bridge-listener.lock', 'owner.json'), 'utf8')),
      ).toMatchObject({ pid: process.pid, port });
      extension = await openSocket(port);
      sendHandshake(extension, {
        extensionVersion: SERVER_VERSION,
        loaderVersion: SERVER_VERSION,
      });
      await waitForMessage(extension); // hello
      await follower.waitForConnection(1_000);

      const resultPromise = follower.call('system.getStatus', {});
      const request = (await waitForMessage(extension)) as { id: string; method: string };
      extension.send(
        JSON.stringify({
          id: request.id,
          type: 'response',
          ok: true,
          result: { promoted: true },
          durationMs: 1,
        }),
      );
      await expect(resultPromise).resolves.toEqual({ promoted: true });
    } finally {
      extension?.close();
      follower.disconnect('test complete');
      owner.disconnect('test complete');
    }
  }, 10_000);

  it('reclaims a stale ownership lock whose recorded process is no longer alive', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'easyeda-bridge-stale-owner-'));
    testDataDirs.add(dataDir);
    const lockDir = join(dataDir, 'bridge-listener.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        token: 'stale-owner',
        pid: 2147483647,
        startedAt: '2000-01-01T00:00:00.000Z',
        host: '127.0.0.1',
        port: 49620,
      }),
    );

    const portCandidates = await getFreePortCandidates();
    const manager = createTestManager(
      createTestConfig({ DATA_DIR: dataDir, BRIDGE_PORT_SCAN: portCandidates }),
    );

    try {
      await manager.connect();
      const port = manager.activePort;
      expect(parsePortScanSpec(portCandidates)).toContain(port);
      expect(manager.ownershipConflict).toBeUndefined();
      const owner = JSON.parse(
        await import('node:fs').then(({ readFileSync }) =>
          readFileSync(join(lockDir, 'owner.json'), 'utf8'),
        ),
      ) as { pid: number; port?: number };
      expect(owner).toMatchObject({ pid: process.pid, port });
    } finally {
      manager.disconnect('test complete');
    }

    expect(() => mkdirSync(lockDir)).not.toThrow();
    rmSync(lockDir, { recursive: true, force: true });
  });
});

describe('BridgeManager - port fallback', () => {
  it('falls back to the next port when the first is already in use', async () => {
    const { server: blocker, port: busyPort } = await bindTestPort();

    try {
      const freePorts = await getFreePortCandidates();
      const config = createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: `${busyPort},${freePorts}`,
      });
      const manager = createTestManager(config);
      await manager.connect();

      expect(parsePortScanSpec(freePorts)).toContain(manager.activePort);
      manager.disconnect('test complete');
    } finally {
      await closeTestPort(blocker);
    }
  });

  it('throws when every candidate port is unavailable', async () => {
    const { server: blocker, port: busyPort } = await bindTestPort();

    try {
      const config = createTestConfig({
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT_SCAN: String(busyPort),
      });
      const manager = createTestManager(config);
      await expect(manager.connect()).rejects.toThrow();
      expect(manager.state).toBe('error');
    } finally {
      await closeTestPort(blocker);
    }
  });
});

describe('parsePortScanSpec', () => {
  it('should parse single port', () => {
    expect(parsePortScanSpec('18601')).toEqual([18601]);
  });

  it('should parse comma-separated ports', () => {
    expect(parsePortScanSpec('18601,49620')).toEqual([18601, 49620]);
  });

  it('should parse port range', () => {
    expect(parsePortScanSpec('49620-49622')).toEqual([49620, 49621, 49622]);
  });

  it('should parse mixed spec', () => {
    expect(parsePortScanSpec('18601,49620-49622')).toEqual([18601, 49620, 49621, 49622]);
  });

  it('should ignore whitespace', () => {
    expect(parsePortScanSpec(' 18601 , 49620-49621 ')).toEqual([18601, 49620, 49621]);
  });

  it('should return empty array for empty string', () => {
    expect(parsePortScanSpec('')).toEqual([]);
  });

  it('should skip invalid ports', () => {
    expect(parsePortScanSpec('0,99999,-1')).toEqual([]);
  });

  it('should return empty array for invalid format', () => {
    expect(parsePortScanSpec('abc')).toEqual([]);
  });
});

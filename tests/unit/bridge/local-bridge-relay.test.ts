import { describe, expect, it, vi } from 'vitest';
import {
  LocalBridgeRelayClient,
  LocalBridgeRelayServer,
  type SharedBridgeSnapshot,
} from '../../../src/bridge/local-bridge-relay.js';

function snapshot(state: SharedBridgeSnapshot['state'] = 'connected'): SharedBridgeSnapshot {
  return {
    state,
    hello: {
      type: 'hello',
      bridgeVersion: '1.1.0',
      contractVersion: '1.0.0',
      supportedProtocolVersions: ['1.0.0'],
      capabilities: [],
      methodRegistryHash: 'test-registry',
      maxPayloadSize: 1024 * 1024,
      supportsChunking: true,
      maxAggregatePayloadSize: 8 * 1024 * 1024,
      devMode: false,
    },
    activePort: 49620,
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now(),
    extensionVersion: '1.1.0',
    extensionMethodListHash: 'test-registry',
    loaderVersion: '1.1.0',
  };
}

describe('local bridge follower relay', () => {
  it('authenticates a follower and proxies allowed bridge calls', async () => {
    let current = snapshot();
    const call = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => current,
      call,
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await expect(client.connect()).resolves.toMatchObject({
        state: 'connected',
        activePort: 49620,
      });
      await expect(
        client.call('system.getStatus', { detail: true }, { timeoutMs: 500 }, 1_500),
      ).resolves.toEqual({ method: 'system.getStatus', params: { detail: true } });
      expect(call).toHaveBeenCalledWith('system.getStatus', { detail: true }, { timeoutMs: 500 });

      const statusPromise = new Promise<SharedBridgeSnapshot>((resolve) =>
        client.once('status', (value) => resolve(value as SharedBridgeSnapshot)),
      );
      current = snapshot('connecting');
      server.broadcast(current);
      await expect(statusPromise).resolves.toMatchObject({ state: 'connecting' });
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it('closes unauthenticated follower sockets after a bounded attach window', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => ({}),
      authTimeoutMs: 20,
    });
    const port = await server.start();
    const { WebSocket } = await import('ws');
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
      const close = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      await expect(close).resolves.toEqual({ code: 4003, reason: 'relay_auth_timeout' });
    } finally {
      socket.close();
      server.close();
    }
  });

  it('enforces a small local follower connection cap when configured', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => ({}),
      maxClients: 1,
    });
    const port = await server.start();
    const first = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });
    const second = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await first.connect();
      await expect(second.connect(1_000)).rejects.toThrow(/disconnected|closed/i);
    } finally {
      first.disconnect();
      second.disconnect();
      server.close();
    }
  });

  it('fails closed for an invalid follower token', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => ({}),
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'wrong-secret' });

    try {
      await expect(client.connect(1_000)).rejects.toThrow(/disconnected|closed/i);
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it('rejects bridge methods outside the published API registry', async () => {
    const call = vi.fn(async () => ({}));
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call,
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await client.connect();
      await expect(
        client.call('system.notReal', {}, { timeoutMs: 500 }, 1_500),
      ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
      expect(call).not.toHaveBeenCalled();
    } finally {
      client.disconnect();
      server.close();
    }
  });
  it('preserves structured bridge errors across the follower relay', async () => {
    const bridgeError = Object.assign(new Error('bridge exploded'), {
      code: 'BRIDGE_EXPLODED',
      suggestion: 'Retry after refreshing EasyEDA.',
      data: { stage: 'dispatch' },
    });
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => {
        throw bridgeError;
      },
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await client.connect();
      await expect(client.call('system.getStatus', {}, {}, 1_000)).rejects.toMatchObject({
        message: 'bridge exploded',
        code: 'BRIDGE_EXPLODED',
        suggestion: 'Retry after refreshing EasyEDA.',
        data: { stage: 'dispatch' },
      });
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it('rejects malformed and invalid authenticated relay messages', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => ({}),
    });
    const port = await server.start();
    const { WebSocket } = await import('ws');

    const malformed = new WebSocket(`ws://127.0.0.1:${port}`);
    const malformedClose = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      malformed.once('error', reject);
      malformed.once('open', () => malformed.send('{'));
      malformed.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await expect(malformedClose).resolves.toEqual({ code: 4001, reason: 'invalid_message' });

    const invalid = new WebSocket(`ws://127.0.0.1:${port}`);
    const invalidClose = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      invalid.once('error', reject);
      invalid.once('open', () => {
        invalid.send(
          JSON.stringify({
            type: 'attach',
            protocolVersion: 1,
            token: 'relay-secret',
          }),
        );
      });
      invalid.once('message', () => {
        invalid.send(JSON.stringify({ type: 'not-a-call' }));
      });
      invalid.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    try {
      await expect(invalidClose).resolves.toEqual({
        code: 4001,
        reason: 'invalid_relay_message',
      });
    } finally {
      malformed.close();
      invalid.close();
      server.close();
    }
  });

  it('bounds follower attach and response waits', async () => {
    const { WebSocketServer } = await import('ws');
    const silentServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => silentServer.once('listening', resolve));
    const address = silentServer.address();
    if (!address || typeof address === 'string')
      throw new Error('silent relay did not expose a port');

    const silentClient = new LocalBridgeRelayClient({
      host: '127.0.0.1',
      port: address.port,
      token: 'relay-secret',
    });
    try {
      await expect(silentClient.connect(30)).rejects.toThrow(
        'Timed out attaching to the local EasyEDA bridge owner.',
      );
    } finally {
      silentClient.disconnect();
      silentServer.close();
    }

    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => await new Promise<never>(() => {}),
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await client.connect();
      await expect(client.call('system.getStatus', {}, {}, 30)).rejects.toThrow(
        'Shared bridge method "system.getStatus" timed out after 30ms',
      );
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it('rejects pending calls when the follower disconnects', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => await new Promise<never>(() => {}),
    });
    const port = await server.start();
    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });

    try {
      await client.connect();
      const pending = client.call('system.getStatus', {}, {}, 5_000);
      client.disconnect();
      await expect(pending).rejects.toThrow('Local EasyEDA bridge follower disconnected.');
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it('rejects duplicate starts and calls before attachment', async () => {
    const server = new LocalBridgeRelayServer({
      token: 'relay-secret',
      maxPayloadBytes: 1024 * 1024,
      snapshot: () => snapshot(),
      call: async () => ({}),
    });
    const port = await server.start();
    await expect(server.start()).rejects.toThrow('already running');

    const client = new LocalBridgeRelayClient({ host: '127.0.0.1', port, token: 'relay-secret' });
    await expect(client.call('system.getStatus', {}, {}, 50)).rejects.toThrow('not connected');

    try {
      await client.connect();
      await expect(client.connect()).rejects.toThrow('already connected');
    } finally {
      client.disconnect();
      server.close();
    }
  });
});

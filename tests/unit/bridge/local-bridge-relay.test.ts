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
});

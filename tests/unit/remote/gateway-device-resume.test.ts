import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HostedDeviceResumeStore } from '../../../src/cloud/device-resume.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import { REMOTE_RELAY_PROTOCOL_VERSION } from '../../../src/remote/protocol.js';

const opened: Array<{ server: Server; socket: WebSocket }> = [];
afterEach(async () => {
  for (const { socket, server } of opened.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.terminate();
      });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function openGateway(store: HostedDeviceResumeStore) {
  const gateway = new RemoteGateway({ resumeStore: store });
  gateway.requireExplicitProjectSelection();
  const server = createServer();
  gateway.attachWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing relay port');
  const socket = new WebSocket('ws://127.0.0.1:' + address.port + '/remote/relay');
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  opened.push({ socket, server });
  return { gateway, socket };
}

let sequence = 0;
function register(socket: WebSocket, extra: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Registration timeout')), 1500);
    socket.once('message', (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    socket.send(
      JSON.stringify({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        messageId: 'msg_test_' + ++sequence,
        timestamp: new Date().toISOString(),
        type: 'register_session',
        mode: 'hosted',
        extensionVersion: '1.15.6',
        capabilities: [],
        activeProject: {
          projectId: 'fixture-project',
          documentId: 'fixture-pcb',
          documentType: 'pcb',
        },
        ...extra,
      }),
    );
  });
}

describe('Hosted Cloud socket pairing after process restart', () => {
  it('resumes only with the persisted owner credential and cannot bypass explicit project selection', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new HostedDeviceResumeStore(db);
      const original = await openGateway(store);
      const owner = { userId: 'owner-a', scopes: ['easyeda.read'] as const };
      const outsider = { userId: 'owner-b', scopes: ['easyeda.read'] as const };
      const code = original.gateway.createPairingCode({ identity: owner });
      const first = await register(original.socket, { pairingCode: code });
      expect(first.type).toBe('session_registered');
      expect(first.paired).toBe(true);
      expect(first.resumeCredential).toMatch(/^ers_[a-f0-9]{64}$/);
      expect(store.list('owner-a')).toHaveLength(1);
      expect(store.list('owner-b')).toEqual([]);

      // Create a fresh gateway as if the previous Cloud process restarted.
      const restarted = await openGateway(new HostedDeviceResumeStore(db));
      expect(restarted.gateway.listPairedExtensions(owner)).toMatchObject([
        { sessionId: first.sessionId, connected: false },
      ]);
      expect(restarted.gateway.revokePairedExtension(outsider, String(first.sessionId))).toBe(
        false,
      );

      // A durable but temporarily offline device must not require a new
      // pairing code merely to recover transport connectivity.
      const offlineRead = await restarted.gateway.routeToolRequest({
        identity: owner,
        toolName: 'easyeda_project_list',
        riskLevel: 'read',
      });
      expect(offlineRead).toMatchObject({
        ok: false,
        code: 'SESSION_DISCONNECTED',
        message: expect.stringContaining('existing Cloud pairing'),
      });
      expect(offlineRead).not.toMatchObject({
        message: expect.stringContaining('using a fresh pairing code'),
      });

      const recovered = await register(restarted.socket, {
        resumeCredential: first.resumeCredential,
      });
      expect(recovered.type).toBe('session_registered');
      expect(recovered.paired).toBe(true);
      expect(recovered.resumeCredential).toMatch(/^ers_[a-f0-9]{64}$/);
      expect(recovered.resumeCredential).not.toBe(first.resumeCredential);
      expect(restarted.gateway.hasRoutableSession(owner)).toBe(false);
      expect(restarted.gateway.selectPairedProject(outsider, String(recovered.sessionId))).toBe(
        false,
      );
      expect(restarted.gateway.selectPairedProject(owner, String(recovered.sessionId))).toBe(true);
      expect(restarted.gateway.hasRoutableSession(owner)).toBe(true);
      expect(restarted.gateway.revokePairedExtension(owner, String(recovered.sessionId))).toBe(
        true,
      );

      const afterRevoke = await openGateway(new HostedDeviceResumeStore(db));
      const rejected = await register(afterRevoke.socket, {
        resumeCredential: recovered.resumeCredential,
      });
      expect(rejected.paired).toBe(false);
      expect(afterRevoke.gateway.listPairedExtensions(owner)).toEqual([]);
    } finally {
      // Test fixtures only; no external database or native EasyEDA mutation.
      for (const { socket, server } of opened.splice(0)) {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      db.close();
    }
  });
});

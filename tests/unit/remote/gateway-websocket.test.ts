import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteGateway, allowRelayUpgradeAttempt } from '../../../src/remote/gateway.js';
import { REMOTE_RELAY_PROTOCOL_VERSION } from '../../../src/remote/protocol.js';
import type { RemoteIdentity } from '../../../src/remote/scope.js';
import { EnvSchema } from '../../../src/config/env.js';

type RelayRecord = Record<string, unknown>;

const readIdentity: RemoteIdentity = {
  userId: 'relay-user',
  scopes: ['easyeda.read'],
};

const writeIdentity: RemoteIdentity = {
  userId: 'relay-user',
  scopes: ['easyeda.write'],
};

class RelayClient {
  readonly messages: RelayRecord[] = [];
  private readonly waiters: Array<{
    predicate: (message: RelayRecord) => boolean;
    resolve: (message: RelayRecord) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as RelayRecord;
      this.messages.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) return;
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    });
  }

  send(payload: RelayRecord): void {
    this.socket.send(JSON.stringify(payload));
  }

  sendRaw(payload: string): void {
    this.socket.send(payload);
  }

  waitFor(predicate: (message: RelayRecord) => boolean, timeoutMs = 1_000): Promise<RelayRecord> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for relay message.'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

interface GatewayHarness {
  gateway: RemoteGateway;
  server: Server;
  client: RelayClient;
}

const harnesses: GatewayHarness[] = [];

async function waitForCondition(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for relay state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createHarness(rateLimit?: number, allowedOrigins = ''): Promise<GatewayHarness> {
  let counter = 0;
  const gateway = new RemoteGateway({ makeId: () => `id-${++counter}` });
  const server = createServer();
  gateway.attachWebSocketServer(
    server,
    rateLimit === undefined
      ? undefined
      : EnvSchema.parse({
          NODE_ENV: 'test',
          HTTP_RATE_LIMIT_MAX: rateLimit,
          ALLOWED_ORIGINS: allowedOrigins,
          HTTP_HOST: '127.0.0.1',
          BRIDGE_MAX_PAYLOAD_SIZE: 1024,
        }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway test server has no port.');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/remote/relay`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const harness = { gateway, server, client: new RelayClient(socket) };
  harnesses.push(harness);
  return harness;
}

function envelope(type: string, extra: RelayRecord = {}): RelayRecord {
  return {
    protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
    type,
    messageId: `client-${Math.random()}`,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

async function registerSession(
  harness: GatewayHarness,
  identity: RemoteIdentity = readIdentity,
): Promise<string> {
  const pairingCode = harness.gateway.createPairingCode({ identity });
  const previousMessages = new Set(harness.client.messages);
  harness.client.send(
    envelope('register_session', {
      extensionVersion: '0.35.1',
      mode: 'hosted',
      capabilities: [],
      activeProject: { projectName: 'Relay Fixture', documentType: 'schematic' },
      pairingCode,
    }),
  );
  const registered = await harness.client.waitFor(
    (message) => message.type === 'session_registered' && !previousMessages.has(message),
  );
  expect(registered.paired).toBe(true);
  return String(registered.sessionId);
}

function toolResponse(input: {
  sessionId: string;
  requestMessageId: string;
  result?: unknown;
}): RelayRecord {
  return envelope('tool_response', {
    sessionId: input.sessionId,
    requestMessageId: input.requestMessageId,
    ok: true,
    result: input.result ?? { ok: true },
    durationMs: 1,
  });
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    await harness.client.close().catch(() => undefined);
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('RemoteGateway WebSocket upgrade admission accounting', () => {
  it('bounds source tracking without clearing unexpired rate limits', () => {
    const now = 100_000;
    const attempts = new Map(
      Array.from(
        { length: 1024 },
        (_, n) => [`ip-${n}`, { count: 1, expiresAt: now + 60_000 }] as const,
      ),
    );
    expect(allowRelayUpgradeAttempt(attempts, 'new-ip', now, 10)).toBe(false);
    expect(attempts.size).toBe(1024);
    expect(allowRelayUpgradeAttempt(attempts, 'ip-0', now, 1)).toBe(false);
    expect(attempts.get('ip-0')?.count).toBe(2);

    attempts.get('ip-1')!.expiresAt = now - 1;
    expect(allowRelayUpgradeAttempt(attempts, 'new-ip', now, 1)).toBe(true);
    expect(attempts.size).toBe(1024);
    expect(attempts.has('ip-1')).toBe(false);
  });

  it('resets an expired per-IP attempt window', () => {
    const attempts = new Map([['ip', { count: 4, expiresAt: 99 }]]);
    expect(allowRelayUpgradeAttempt(attempts, 'ip', 100, 1)).toBe(true);
    expect(attempts.get('ip')?.count).toBe(1);
  });
});

describe('RemoteGateway WebSocket upgrade admission', () => {
  it('rejects browser origins outside the allowlist before WebSocket admission', async () => {
    const harness = await createHarness(5);
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const rejected = new WebSocket(`ws://127.0.0.1:${address.port}/remote/relay`, {
      headers: { Origin: 'https://untrusted.example' },
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once('open', resolve);
        rejected.once('error', reject);
      }),
    ).rejects.toThrow('403');
  });

  it('rejects a mismatched Host header before allocating a relay socket', async () => {
    const harness = await createHarness(5);
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const rejected = new WebSocket(`ws://127.0.0.1:${address.port}/remote/relay`, {
      headers: { Host: 'untrusted.example' },
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once('open', resolve);
        rejected.once('error', reject);
      }),
    ).rejects.toThrow('400');
  });

  it('accepts a browser Origin explicitly configured in the allowlist', async () => {
    const harness = await createHarness(5, 'https://trusted.example');
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/remote/relay`, {
      headers: { Origin: 'https://trusted.example' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  });

  it('allows loopback web origins but rejects malformed origins', async () => {
    const harness = await createHarness(5);
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/session`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const rejected = new WebSocket(`ws://127.0.0.1:${address.port}/session`, {
      headers: { Origin: '%%%malformed' },
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once('open', resolve);
        rejected.once('error', reject);
      }),
    ).rejects.toThrow('403');
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  });

  it('rate-limits further upgrades before registering relay sessions', async () => {
    const harness = await createHarness(1);
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const rejected = new WebSocket(`ws://127.0.0.1:${address.port}/session`);
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once('open', resolve);
        rejected.once('error', reject);
      }),
    ).rejects.toThrow('429');
  });

  it('enforces a bounded WebSocket frame size at the relay boundary', async () => {
    const harness = await createHarness(5);
    const closed = new Promise<number>((resolve) => {
      harness.client.socket.once('close', (code) => resolve(code));
    });
    harness.client.sendRaw('x'.repeat(2048));
    await expect(closed).resolves.toBe(1009);
  });
});

describe('RemoteGateway WebSocket relay', () => {
  it('fails closed with stable errors for malformed and pre-registration frames', async () => {
    const harness = await createHarness();

    harness.client.sendRaw('{not-json');
    await expect(
      harness.client.waitFor((message) => message.code === 'BAD_JSON'),
    ).resolves.toMatchObject({ type: 'error', code: 'BAD_JSON' });

    harness.client.send(envelope('heartbeat', { timestamp: 'not-a-date' }));
    await expect(
      harness.client.waitFor((message) => message.code === 'BAD_MESSAGE'),
    ).resolves.toMatchObject({ type: 'error', code: 'BAD_MESSAGE' });

    harness.client.send(envelope('heartbeat'));
    await expect(
      harness.client.waitFor((message) => message.code === 'SESSION_NOT_REGISTERED'),
    ).resolves.toMatchObject({ type: 'error', code: 'SESSION_NOT_REGISTERED' });
  });

  it('re-registering one socket replaces and disconnects its previous session', async () => {
    const harness = await createHarness();
    const firstSessionId = await registerSession(harness);
    const secondSessionId = await registerSession(harness);

    expect(secondSessionId).not.toBe(firstSessionId);
    await expect(
      harness.gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: firstSessionId,
        toolName: 'schematic.listComponents',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_DISCONNECTED' });
  });

  it('rejects cross-session and duplicate tool responses without settling the wrong request', async () => {
    const harness = await createHarness();
    const sessionId = await registerSession(harness);
    let settled = false;
    const routed = harness.gateway
      .routeToolRequest({
        identity: readIdentity,
        sessionId,
        toolName: 'schematic.listComponents',
        riskLevel: 'read',
        deadlineMs: 1_000,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    const request = await harness.client.waitFor((message) => message.type === 'tool_request');

    harness.client.send(
      toolResponse({
        sessionId: 'sess_wrong',
        requestMessageId: String(request.messageId),
      }),
    );
    await expect(
      harness.client.waitFor((message) => message.code === 'SESSION_MISMATCH'),
    ).resolves.toMatchObject({ type: 'error', code: 'SESSION_MISMATCH' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    const validResponse = toolResponse({
      sessionId,
      requestMessageId: String(request.messageId),
      result: { sessionId },
    });
    harness.client.send(validResponse);
    await expect(routed).resolves.toMatchObject({ ok: true, result: { sessionId } });

    harness.client.send(validResponse);
    await expect(
      harness.client.waitFor((message) => message.code === 'REQUEST_NOT_FOUND'),
    ).resolves.toMatchObject({ type: 'error', code: 'REQUEST_NOT_FOUND' });
  });

  it('rejects approval results whose metadata does not match the active relay session', async () => {
    const harness = await createHarness();
    const sessionId = await registerSession(harness, writeIdentity);
    const first = await harness.gateway.routeToolRequest({
      identity: writeIdentity,
      sessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write',
      input: { content: 'relay fixture' },
    });
    expect(first).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    if (first.ok || !first.approvalId) throw new Error('Expected approval id.');
    const approvalRequest = await harness.client.waitFor(
      (message) => message.type === 'approval_request',
    );
    expect(approvalRequest).toMatchObject({
      sessionId,
      approvalId: first.approvalId,
      toolName: 'schematic.addText',
      riskLevel: 'write',
      inputHash: expect.any(String),
      expiresAt: expect.any(String),
    });

    harness.client.send(
      envelope('approval_result', {
        sessionId: 'sess_wrong',
        approvalId: first.approvalId,
        result: 'approved',
      }),
    );
    await expect(
      harness.client.waitFor((message) => message.code === 'SESSION_MISMATCH'),
    ).resolves.toMatchObject({ type: 'error', code: 'SESSION_MISMATCH' });

    await expect(
      harness.gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId,
        toolName: 'schematic.addText',
        riskLevel: 'write',
        input: { content: 'relay fixture' },
        approvalId: first.approvalId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_NOT_APPROVED',
      message: 'Remote approval is still pending user action.',
    });

    harness.client.send(
      envelope('approval_result', {
        sessionId,
        approvalId: first.approvalId,
        result: 'approved',
      }),
    );
    await waitForCondition(
      () => harness.gateway.approvals.get(first.approvalId)?.decision === 'approved',
    );

    const routed = harness.gateway.routeToolRequest({
      identity: writeIdentity,
      sessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write',
      input: { content: 'relay fixture' },
      approvalId: first.approvalId,
    });
    const request = await harness.client.waitFor((message) => message.type === 'tool_request');
    harness.client.send(
      toolResponse({
        sessionId,
        requestMessageId: String(request.messageId),
        result: { approved: true },
      }),
    );
    await expect(routed).resolves.toMatchObject({ ok: true, result: { approved: true } });
  });

  it('rejects in-flight requests immediately when the extension closes its session', async () => {
    const harness = await createHarness();
    const sessionId = await registerSession(harness);
    let settled = false;
    const routed = harness.gateway
      .routeToolRequest({
        identity: readIdentity,
        sessionId,
        toolName: 'schematic.listComponents',
        riskLevel: 'read',
        deadlineMs: 2_000,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await harness.client.waitFor((message) => message.type === 'tool_request');

    harness.client.send(
      envelope('session_closed', {
        sessionId: 'sess_wrong',
        reason: 'disconnected',
      }),
    );
    await expect(
      harness.client.waitFor((message) => message.code === 'SESSION_MISMATCH'),
    ).resolves.toMatchObject({ type: 'error', code: 'SESSION_MISMATCH' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    harness.client.send(
      envelope('session_closed', {
        sessionId,
        reason: 'disconnected',
      }),
    );

    await expect(routed).resolves.toMatchObject({
      ok: false,
      status: 424,
      code: 'SESSION_DISCONNECTED',
    });
    expect(harness.gateway.audit.recent(20)).toContainEqual(
      expect.objectContaining({
        event: 'remote.tool.failed',
        sessionId,
        errorCode: 'SESSION_DISCONNECTED',
      }),
    );
  });

  it('normalizes a dispatch attempted after the relay transport is already closed', async () => {
    class FakeRelaySocket extends EventEmitter {
      readonly OPEN = WebSocket.OPEN;
      readyState = WebSocket.OPEN;
      readonly sent: RelayRecord[] = [];

      send(payload: string): void {
        this.sent.push(JSON.parse(payload) as RelayRecord);
      }

      close(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
      }
    }

    const gateway = new RemoteGateway({
      makeId: (() => {
        let counter = 0;
        return () => `closed-${++counter}`;
      })(),
    });
    const socket = new FakeRelaySocket();
    const pairingCode = gateway.createPairingCode({ identity: readIdentity });
    const gatewayInternals = gateway as unknown as {
      handleRelaySocket(ws: WebSocket): void;
    };
    gatewayInternals.handleRelaySocket(socket as unknown as WebSocket);
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify(
          envelope('register_session', {
            extensionVersion: '0.35.1',
            mode: 'hosted',
            capabilities: [],
            activeProject: { projectName: 'Closed Relay', documentType: 'schematic' },
            pairingCode,
          }),
        ),
      ),
    );
    const registered = socket.sent.find((message) => message.type === 'session_registered');
    const sessionId = String(registered?.sessionId ?? '');
    expect(sessionId).toMatch(/^sess_/);

    socket.readyState = WebSocket.CLOSED;
    await expect(
      gateway.routeToolRequest({
        identity: readIdentity,
        sessionId,
        toolName: 'schematic.listComponents',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 424,
      code: 'SESSION_DISCONNECTED',
    });
    gateway.disconnect(sessionId);
  });

  it('rejects in-flight requests immediately when the relay socket closes', async () => {
    const harness = await createHarness();
    const sessionId = await registerSession(harness);
    const routed = harness.gateway.routeToolRequest({
      identity: readIdentity,
      sessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      deadlineMs: 2_000,
    });
    await harness.client.waitFor((message) => message.type === 'tool_request');

    await harness.client.close();

    await expect(routed).resolves.toMatchObject({
      ok: false,
      status: 424,
      code: 'SESSION_DISCONNECTED',
    });
    expect(harness.gateway.audit.recent(20)).toContainEqual(
      expect.objectContaining({
        event: 'remote.tool.failed',
        sessionId,
        errorCode: 'SESSION_DISCONNECTED',
      }),
    );
  });
});

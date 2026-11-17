import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { EnvSchema } from '../../../../src/config/env.js';
import { createHttpTransport } from '../../../../src/server/transports/http.js';
import { REMOTE_RELAY_PROTOCOL_VERSION } from '../../../../src/remote/protocol.js';

function createTestConfig(port: number) {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    TRANSPORT: 'http',
    HTTP_PORT: port,
  });
}

async function withRemoteServer<T>(
  port: number,
  fn: (baseUrl: string, transport: ReturnType<typeof createHttpTransport>) => Promise<T>,
): Promise<T> {
  const transport = createHttpTransport(createTestConfig(port));
  const server = http.createServer(transport.app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  try {
    return await fn(`http://127.0.0.1:${port}`, transport);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function headers(scopes = 'easyeda.read') {
  return {
    'content-type': 'application/json',
    'x-remote-user-id': 'user-a',
    'x-remote-scopes': scopes,
  };
}

describe('HTTP remote gateway endpoints', () => {
  it('creates pairing codes, pairs a fake extension, and routes tool requests', async () => {
    await withRemoteServer(3931, async (baseUrl, transport) => {
      const session = transport.gateway.registerExtension({
        connectionId: 'conn-http',
        mode: 'hosted',
        extensionVersion: '0.19.0',
        activeProject: { projectName: 'Demo', documentType: 'schematic' },
        dispatch: async (request) => ({
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response',
          messageId: `response-${request.messageId}`,
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
          ok: true,
          result: { routed: true, toolName: request.toolName },
          durationMs: 2,
        }),
      });

      const codeRes = await fetch(`${baseUrl}/remote/pairing-codes`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      expect(codeRes.status).toBe(200);
      const codeBody = (await codeRes.json()) as { pairingCode: string };
      expect(codeBody.pairingCode).toMatch(/^EDA-/);

      const pairingRes = await fetch(`${baseUrl}/remote/pairings`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ code: codeBody.pairingCode, sessionId: session.sessionId }),
      });
      expect(pairingRes.status).toBe(200);

      const toolRes = await fetch(`${baseUrl}/remote/tool-requests`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sessionId: session.sessionId,
          toolName: 'easyeda_board_read',
          riskLevel: 'read',
          input: { projectId: 'demo' },
        }),
      });
      expect(toolRes.status).toBe(200);
      await expect(toolRes.json()).resolves.toMatchObject({
        ok: true,
        sessionId: session.sessionId,
        result: { routed: true, toolName: 'easyeda_board_read' },
      });
    });
  });

  it('fails closed without identity or pairing', async () => {
    await withRemoteServer(3932, async (baseUrl, transport) => {
      const session = transport.gateway.registerExtension({
        connectionId: 'conn-unpaired',
        mode: 'hosted',
        extensionVersion: '0.19.0',
        dispatch: async (request) => ({
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response',
          messageId: 'response-unpaired',
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
          ok: true,
          result: {},
          durationMs: 1,
        }),
      });

      const missingIdentity = await fetch(`${baseUrl}/remote/tool-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          toolName: 'easyeda_board_read',
          riskLevel: 'read',
        }),
      });
      expect(missingIdentity.status).toBe(401);

      const unpaired = await fetch(`${baseUrl}/remote/tool-requests`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sessionId: session.sessionId,
          toolName: 'easyeda_board_read',
          riskLevel: 'read',
        }),
      });
      expect(unpaired.status).toBe(404);
      await expect(unpaired.json()).resolves.toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });
    });
  });

  it('does not accept a caller-supplied private invocation grant over public HTTP', async () => {
    await withRemoteServer(3933, async (baseUrl, transport) => {
      let dispatchCount = 0;
      const approvalIds: string[] = [];
      const session = transport.gateway.registerExtension({
        connectionId: 'conn-private-grant',
        mode: 'hosted',
        extensionVersion: '0.32.0',
        activeProject: { projectName: 'Demo', documentType: 'schematic' },
        requestApproval: (request) => {
          approvalIds.push(request.approvalId);
        },
        dispatch: async (request) => {
          dispatchCount += 1;
          return {
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'tool_response' as const,
            messageId: `response-${request.messageId}`,
            sessionId: request.sessionId,
            requestMessageId: request.messageId,
            timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
            ok: true,
            result: {},
            durationMs: 1,
          };
        },
      });

      const identity = { userId: 'user-a', scopes: ['easyeda.write'] as const };
      const code = transport.gateway.createPairingCode({ identity, sessionId: session.sessionId });
      expect(
        transport.gateway.completePairing({ identity, code, sessionId: session.sessionId }),
      ).toBe(true);

      const response = await fetch(`${baseUrl}/remote/tool-requests`, {
        method: 'POST',
        headers: headers('easyeda.write'),
        body: JSON.stringify({
          sessionId: session.sessionId,
          toolName: 'schematic.addText',
          riskLevel: 'write',
          input: { content: 'must not dispatch' },
          grantId: 'caller-supplied-value',
        }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: 'APPROVAL_REQUIRED',
        approvalId: expect.stringMatching(/^appr_/),
      });
      expect(approvalIds).toHaveLength(1);
      expect(dispatchCount).toBe(0);
    });
  });
});

describe('Cloud connected extensions — owner management acceptance', () => {
  it('shows only the signed-in owner’s paired extension and revokes it without affecting another account', async () => {
    await withRemoteServer(3994, async (baseUrl, transport) => {
      const user = (userId: string) => ({
        'x-remote-user-id': userId,
        'x-remote-scopes': 'easyeda.read',
      });
      const makeSession = (name: string, onClose?: () => void) =>
        transport.gateway.registerExtension({
          connectionId: `device-${name}`,
          mode: 'hosted',
          extensionVersion: '1.15.4',
          activeProject: { projectName: `Demo-${name}`, documentType: 'pcb' },
          closeConnection: onClose,
          dispatch: async (request) => ({
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'tool_response' as const,
            messageId: `result-${request.messageId}`,
            sessionId: request.sessionId,
            requestMessageId: request.messageId,
            timestamp: new Date().toISOString(),
            ok: true,
            result: { name },
            durationMs: 1,
          }),
        });
      let closedA = 0;
      const sessionA = makeSession('a', () => {
        closedA += 1;
      });
      const sessionB = makeSession('b');
      makeSession('unpaired');
      for (const [id, session] of [
        ['owner-a', sessionA],
        ['owner-b', sessionB],
      ] as const) {
        const identity = { userId: id, scopes: ['easyeda.read'] as const };
        const code = transport.gateway.createPairingCode({
          identity,
          sessionId: session.sessionId,
        });
        expect(
          transport.gateway.completePairing({ identity, code, sessionId: session.sessionId }),
        ).toBe(true);
      }

      const unauthenticated = await fetch(`${baseUrl}/remote/sessions`);
      expect(unauthenticated.status).toBe(401);

      const ownerList = await fetch(`${baseUrl}/remote/sessions`, {
        headers: user('owner-a'),
      });
      expect(ownerList.status).toBe(200);
      const ownerView = (await ownerList.json()) as {
        sessions: Record<string, unknown>[];
      };
      expect(ownerView.sessions).toHaveLength(1);
      expect(ownerView.sessions[0]).toMatchObject({
        sessionId: sessionA.sessionId,
        extensionVersion: '1.15.4',
        connected: true,
        activeProject: { projectName: 'Demo-a' },
      });
      expect(ownerView.sessions[0]).not.toHaveProperty('connectionId');
      expect(ownerView.sessions[0]).not.toHaveProperty('userId');

      const wrongOwner = await fetch(`${baseUrl}/remote/sessions/${sessionA.sessionId}`, {
        method: 'DELETE',
        headers: user('owner-b'),
      });
      expect(wrongOwner.status).toBe(404);
      expect(closedA).toBe(0);

      const ownerRevoke = await fetch(`${baseUrl}/remote/sessions/${sessionA.sessionId}`, {
        method: 'DELETE',
        headers: user('owner-a'),
      });
      expect(ownerRevoke.status).toBe(204);
      expect(closedA).toBe(1);

      const ownerAfterRevoke = await fetch(`${baseUrl}/remote/sessions`, {
        headers: user('owner-a'),
      });
      await expect(ownerAfterRevoke.json()).resolves.toMatchObject({ sessions: [] });
      const repeatedRevoke = await fetch(`${baseUrl}/remote/sessions/${sessionA.sessionId}`, {
        method: 'DELETE',
        headers: user('owner-a'),
      });
      expect(repeatedRevoke.status).toBe(404);

      const otherOwner = await fetch(`${baseUrl}/remote/sessions`, {
        headers: user('owner-b'),
      });
      await expect(otherOwner.json()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: sessionB.sessionId })],
      });

      await expect(
        transport.gateway.routeToolRequest({
          identity: { userId: 'owner-a', scopes: ['easyeda.read'] },
          sessionId: sessionA.sessionId,
          toolName: 'easyeda_pcb_read',
          riskLevel: 'read',
        }),
      ).resolves.toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });
    });
  });

  it('rejects missing, expired, or insufficient owner identity when listing or revoking extensions', async () => {
    await withRemoteServer(3995, async (baseUrl) => {
      for (const [headers, expectedStatus] of [
        [{}, 401],
        [{ 'x-remote-user-id': 'a', 'x-remote-scopes': 'easyeda.write' }, 403],
        [
          {
            'x-remote-user-id': 'a',
            'x-remote-scopes': 'easyeda.read',
            'x-remote-expires-at': '2021-01-01T00:00:00.000Z',
          },
          401,
        ],
      ] as const) {
        expect((await fetch(`${baseUrl}/remote/sessions`, { headers })).status).toBe(
          expectedStatus,
        );
        expect(
          (
            await fetch(`${baseUrl}/remote/sessions/sess_notowned`, {
              method: 'DELETE',
              headers,
            })
          ).status,
        ).toBe(expectedStatus);
      }
    });
  });
});

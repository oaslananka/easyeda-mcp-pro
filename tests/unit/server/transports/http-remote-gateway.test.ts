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
});

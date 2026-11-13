import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { HostedAuth } from '../../../src/cloud/hosted-auth.js';
import { EnvSchema } from '../../../src/config/env.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
  type ToolResponseMessage,
} from '../../../src/remote/protocol.js';
import { createServer } from '../../../src/server/factory.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';

async function unusedPort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const addr = listener.address();
  if (!addr || typeof addr === 'string') throw new Error('No port');
  return await new Promise<number>((resolve) => listener.close(() => resolve(addr.port)));
}

describe('Hosted Cloud resource-owner identity through real MCP HTTP', () => {
  it.each([false, true])(
    'uses signed OAuth sub and ignores caller-supplied remote owner headers (modern=%s)',
    async (modern) => {
      const port = await unusedPort();
      const origin = `http://127.0.0.1:${port}`;
      const keys = await generateKeyPair('EdDSA');
      const publicJwk = {
        ...(await exportJWK(keys.publicKey)),
        kid: 'hosted-test-key',
        use: 'sig',
        alg: 'EdDSA',
      };
      const dataDir = await mkdtemp(join(tmpdir(), 'easyeda-hosted-mcp-identity-'));
      const config = EnvSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        TRANSPORT: 'http',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: port,
        MCP_BRIDGE_BACKEND: 'remote_relay',
        TOOL_PROFILE: 'core',
        MCP_V2_EXPERIMENTAL: modern,
        OAUTH_ENABLED: true,
        OAUTH_ISSUER: `${origin}/api/auth`,
        OAUTH_AUDIENCE: `${origin}/mcp`,
        OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
        OAUTH_REQUIRED_SCOPES: 'easyeda.read',
        DATA_DIR: dataDir,
        SQLITE_PATH: join(dataDir, 'test.sqlite'),
        ARTIFACT_DIR: join(dataDir, 'artifacts'),
        CACHE_DIR: join(dataDir, 'cache'),
        JLCSEARCH_ENABLED: false,
      });
      const provider: HostedAuth = {
        origin,
        options: {},
        listClientConsents: async () => [],
        installGrantProtection: () => undefined,
        checkAccessGrant: () => true, // Test identity isolation independently of DB grant checks.
        handler: async (request: Request) =>
          new URL(request.url).pathname === '/api/auth/jwks'
            ? Response.json({ keys: [publicJwk] })
            : new Response(null, { status: 404 }),
        getSessionUser: async () => null,
        verifySignedQuery: async () => false,
        getClient: async () => null,
      };
      const gateway = new RemoteGateway();
      const dispatched: ToolRequestMessage[] = [];
      const owner = { userId: 'real-oauth-owner', scopes: ['easyeda.read'] as const };
      const session = gateway.registerExtension({
        connectionId: 'owned-extension',
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: { projectName: 'Disposable', documentType: 'schematic' },
        dispatch: async (message: ToolRequestMessage): Promise<ToolResponseMessage> => {
          dispatched.push(message);
          return {
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'tool_response',
            messageId: 'result-' + dispatched.length,
            sessionId: message.sessionId,
            requestMessageId: message.messageId,
            timestamp: new Date().toISOString(),
            ok: true,
            result: { total: 0, items: [] },
            durationMs: 1,
          };
        },
      });
      const code = gateway.createPairingCode({ identity: owner });
      expect(gateway.completePairing({ identity: owner, code, sessionId: session.sessionId })).toBe(
        true,
      );
      expect(gateway.selectPairedProject(owner, session.sessionId)).toBe(true);
      const instance = await createServer(config, { remoteGateway: gateway });
      const transport = createHttpTransport(config, {
        hostedAuth: provider,
        gateway,
        serverFactory: instance.createSessionServer,
      });
      instance.httpTransport = transport;
      const clients: Client[] = [];
      try {
        await transport.start();
        const accessToken = await new SignJWT({ scope: 'easyeda.read', azp: 'client-app' })
          .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'hosted-test-key' })
          .setIssuer(`${origin}/api/auth`)
          .setAudience(`${origin}/mcp`)
          .setSubject(owner.userId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(keys.privateKey);
        const client = new Client(
          { name: 'hosted-real-owner', version: '1.0.0' },
          modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
        );
        clients.push(client);
        const ownerTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'x-remote-user-id': 'forged-other-owner',
              'x-remote-scopes': 'easyeda.project_admin',
            },
          },
        });
        await client.connect(ownerTransport);
        const result = await client.callTool({
          name: 'easyeda_schematic_components',
          arguments: { projectId: 'selected-schematic' },
        });
        expect(result.isError).not.toBe(true);
        expect(dispatched).toHaveLength(2);
        expect(dispatched[0]).toMatchObject({ sessionId: session.sessionId });

        // Forged request headers must not upgrade a read-only OAuth token into
        // a write-capable identity when the MCP SDK invokes the registry.
        const deniedWrite = await client.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: {
            x: 1,
            y: 2,
            content: 'unauthorized mutation',
            confirmWrite: true,
          },
        });
        expect(deniedWrite.isError).toBe(true);
        expect(deniedWrite.structuredContent).toMatchObject({
          errorCode: 'ERR_REMOTE_RELAY',
          details: { remoteCode: 'SCOPE_MISSING' },
        });
        expect(dispatched).toHaveLength(2);

        const signedFor = (
          sub: string,
          scope = 'easyeda.read',
          typ = 'at+jwt',
          expiration = '5m',
          azp = 'client-app',
        ) =>
          new SignJWT({ scope, azp })
            .setProtectedHeader({ alg: 'EdDSA', typ, kid: 'hosted-test-key' })
            .setIssuer(`${origin}/api/auth`)
            .setAudience(`${origin}/mcp`)
            .setSubject(sub)
            .setIssuedAt()
            .setExpirationTime(expiration)
            .sign(keys.privateKey);

        const unrelated = await signedFor('other-oauth-owner');
        const unrelatedSessions = await fetch(`${origin}/remote/sessions`, {
          headers: {
            Authorization: `Bearer ${unrelated}`,
            'x-remote-user-id': owner.userId,
          },
        });
        expect(unrelatedSessions.status).toBe(200);
        await expect(unrelatedSessions.json()).resolves.toMatchObject({ sessions: [] });

        if (!modern) {
          // An attacker who learns a valid MCP session id must not reuse it with
          // their own correctly signed access token to borrow the owner's session.
          expect(ownerTransport.sessionId).toBeDefined();
          const hijackAttempt = await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${unrelated}`,
              'Mcp-Session-Id': ownerTransport.sessionId!,
              'Mcp-Protocol-Version': config.MCP_PROTOCOL_VERSION,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'x-remote-user-id': owner.userId,
              'x-remote-scopes': 'easyeda.project_admin',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 949,
              method: 'tools/call',
              params: {
                name: 'easyeda_schematic_components',
                arguments: { projectId: 'hijack-attempt' },
              },
            }),
          });
          const hijackContent = await hijackAttempt.text();
          expect(
            dispatched,
            `hijack status=${hijackAttempt.status}: ${hijackContent.slice(0, 300)}`,
          ).toHaveLength(2);

          const secondClientToken = await signedFor(
            owner.userId,
            'easyeda.read',
            'at+jwt',
            '5m',
            'another-authorized-client',
          );
          const anotherClientAttempt = await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secondClientToken}`,
              'Mcp-Session-Id': ownerTransport.sessionId!,
              'Mcp-Protocol-Version': config.MCP_PROTOCOL_VERSION,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 950,
              method: 'tools/call',
              params: {
                name: 'easyeda_schematic_components',
                arguments: { projectId: 'different-client-hijack' },
              },
            }),
          });
          const anotherClientText = await anotherClientAttempt.text();
          expect(
            anotherClientAttempt.status,
            `Other client unexpectedly gained access: ${anotherClientText.slice(0, 300)}`,
          ).toBe(403);
          expect(dispatched).toHaveLength(2);

          const foreignDelete = await fetch(`${origin}/mcp`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${secondClientToken}`,
              'Mcp-Session-Id': ownerTransport.sessionId!,
              'Mcp-Protocol-Version': config.MCP_PROTOCOL_VERSION,
            },
          });
          expect(foreignDelete.status).toBe(403);
          // A denied foreign request must not poison or terminate the owner
          // session. Repeated calls from the original OAuth client still work.
          const ownerStillWorks = await client.callTool({
            name: 'easyeda_schematic_components',
            arguments: { projectId: 'owner-after-foreign-delete' },
          });
          expect(ownerStillWorks.isError).not.toBe(true);
          expect(dispatched).toHaveLength(4);

          // Access-token rotation by the same OAuth user and client must not
          // invalidate a legitimate existing session.
          const refreshedToken = await signedFor(owner.userId);
          const refreshedAccess = await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${refreshedToken}`,
              'Mcp-Session-Id': ownerTransport.sessionId!,
              'Mcp-Protocol-Version': config.MCP_PROTOCOL_VERSION,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 951,
              method: 'tools/list',
              params: {},
            }),
          });
          expect(refreshedAccess.status).toBe(200);
          expect(await refreshedAccess.text()).toContain('easyeda_schematic_components');
        } else {
          // MCP 2026-07-28 is stateless, so there is no session identifier to reuse.
          expect(ownerTransport.sessionId).toBeUndefined();
        }

        const noScope = await signedFor(owner.userId, 'openid');
        expect(
          (
            await fetch(`${origin}/remote/sessions`, {
              headers: { Authorization: `Bearer ${noScope}` },
            })
          ).status,
        ).toBe(403);

        const sessionJwt = await signedFor(owner.userId, 'easyeda.read', 'JWT');
        expect(
          (
            await fetch(`${origin}/remote/sessions`, {
              headers: { Authorization: `Bearer ${sessionJwt}` },
            })
          ).status,
        ).toBe(401);

        const expiredToken = await signedFor(owner.userId, 'easyeda.read', 'at+jwt', '-30s');
        expect(
          (
            await fetch(`${origin}/remote/sessions`, {
              headers: { Authorization: `Bearer ${expiredToken}` },
            })
          ).status,
        ).toBe(401);

        expect(
          (
            await fetch(`${origin}/remote/sessions`, {
              headers: { 'x-remote-user-id': owner.userId, 'x-remote-scopes': 'easyeda.read' },
            })
          ).status,
        ).toBe(401);
      } finally {
        await Promise.allSettled(clients.map((client) => client.close()));
        await transport.close();
        await instance.shutdown();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});

import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { getMigrations } from 'better-auth/db/migration';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { describe, it, expect } from 'vitest';
import { createHostedAuth } from '../../../src/cloud/hosted-auth.js';
import { EnvSchema } from '../../../src/config/env.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
} from '../../../src/remote/protocol.js';
import { createServer as createMcpServer } from '../../../src/server/factory.js';

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe('Hosted OAuth real provider authorization-code flow (fixture identity only)', () => {
  it('issues a real provider PKCE token through an owner-paired WebSocket relay and rejects stale projects, disconnects and revoked consent', async () => {
    const port = await ephemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    const secret = 'fixture-only-hosted-strong-secret-12345678';
    const database = new DatabaseSync(':memory:');
    const auth = createHostedAuth({
      origin,
      secret,
      database,
      github: { clientId: 'fixture-github', clientSecret: 'fixture-secret' },
      google: { clientId: 'fixture-google', clientSecret: 'fixture-secret' },
    });
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    auth.installGrantProtection();
    const fixtureAuth = betterAuth({
      baseURL: origin,
      secret,
      database,
      plugins: [testUtils()],
    });
    const test = (await fixtureAuth.$context).test;
    const saved = await test.saveUser(
      test.createUser({ email: 'owner@test.invalid', name: 'Fixture Owner' }),
    );
    const headers = await test.getAuthHeaders({ userId: saved.id });
    const user = await auth.getSessionUser(headers);
    expect(user?.id).toBe(saved.id);

    const dataDir = await mkdtemp(join(tmpdir(), 'easyeda-hosted-auth-real-provider-'));
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      TOOL_PROFILE: 'core',
      JLCSEARCH_ENABLED: false,
      BRIDGE_TIMEOUT_MS: 1000,
      DATA_DIR: dataDir,
      SQLITE_PATH: join(dataDir, 'app.sqlite'),
      ARTIFACT_DIR: join(dataDir, 'artifacts'),
      CACHE_DIR: join(dataDir, 'cache'),
      TRANSPORT: 'http',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: port,
      OAUTH_ENABLED: true,
      OAUTH_ISSUER: `${origin}/api/auth`,
      OAUTH_AUDIENCE: `${origin}/mcp`,
      OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
      OAUTH_REQUIRED_SCOPES: 'easyeda.read',
      MCP_BRIDGE_BACKEND: 'remote_relay',
    });
    const gateway = new RemoteGateway();
    const dispatched: ToolRequestMessage[] = [];
    const ownerIdentity = { userId: saved.id, scopes: ['easyeda.read'] as const };
    let socket: WebSocket | undefined;
    let sessionId = '';
    const mcpServer = await createMcpServer(config, { remoteGateway: gateway });
    const transport = createHttpTransport(config, {
      hostedAuth: auth,
      gateway,
      serverFactory: mcpServer.createSessionServer,
    });
    mcpServer.httpTransport = transport;
    let client: Client | undefined;
    try {
      await transport.start();
      // Pair over a REAL WebSocket upgrade and wire protocol instead of
      // injecting a fake dispatcher directly into the gateway.
      const relay = new WebSocket(`ws://127.0.0.1:${port}/remote/relay`);
      socket = relay;
      await new Promise<void>((resolve, reject) => {
        relay.once('open', () => resolve());
        relay.once('error', reject);
      });
      const registration = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Relay registration timed out')), 3000);
        relay.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === 'session_registered') {
            clearTimeout(timeout);
            resolve(message);
          } else if (message.type === 'tool_request') {
            const request = message as unknown as ToolRequestMessage;
            dispatched.push(request);
            relay.send(
              JSON.stringify({
                protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
                type: 'tool_response',
                messageId: 'fixture-response-' + dispatched.length,
                sessionId: request.sessionId,
                requestMessageId: request.messageId,
                timestamp: new Date().toISOString(),
                ok: true,
                result: { total: 0, items: [] },
                durationMs: 1,
              }),
            );
          } else if (message.type === 'error') {
            clearTimeout(timeout);
            reject(new Error('Relay rejected frame: ' + String(message.code)));
          }
        });
      });
      const pairingCode = gateway.createPairingCode({ identity: ownerIdentity });
      relay.send(
        JSON.stringify({
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'register_session',
          messageId: 'fixture-register',
          timestamp: new Date().toISOString(),
          mode: 'hosted',
          extensionVersion: 'fixture-1.15.4',
          capabilities: [],
          pairingCode,
          activeProject: {
            projectId: 'disposable-project',
            documentId: 'schematic-page-one',
            projectName: 'Disposable',
            documentType: 'schematic',
          },
        }),
      );
      const registered = await registration;
      expect(registered.paired).toBe(true);
      sessionId = String(registered.sessionId);
      expect(sessionId).toMatch(/^sess_/);
      expect(gateway.selectPairedProject(ownerIdentity, sessionId)).toBe(true);
      const createClient = await fetch(`${origin}/api/auth/oauth2/create-client`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_name: 'Fixture MCP Agent',
          redirect_uris: ['http://127.0.0.1/callback'],
          token_endpoint_auth_method: 'none',
          application_type: 'native',
          scope: 'easyeda.read',
        }),
      });
      const body = await createClient.text();
      expect(createClient.status, body).toBe(201);
      const oauthClient = JSON.parse(body) as { client_id: string };
      expect(oauthClient).toMatchObject({ client_id: expect.any(String) });

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const redirectUri = 'http://127.0.0.1/callback';
      const authorizeQuery = new URLSearchParams({
        response_type: 'code',
        client_id: oauthClient.client_id,
        redirect_uri: redirectUri,
        scope: 'easyeda.read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'fixture-state',
        resource: `${origin}/mcp`,
      });
      const authorize = await fetch(`${origin}/api/auth/oauth2/authorize?${authorizeQuery}`, {
        redirect: 'manual',
        headers,
      });
      expect(authorize.status).toBe(200);
      const authorization = (await authorize.json()) as { redirect: boolean; url: string };
      expect(authorization).toMatchObject({
        redirect: true,
        url: expect.stringContaining('/consent?'),
      });
      const consentUrl = new URL(authorization.url, origin);
      const consentPage = await fetch(consentUrl, { headers });
      expect(consentPage.status).toBe(200);
      expect(await consentPage.text()).toContain('Fixture MCP Agent');

      const consentResponse = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
      });
      const consentBody = await consentResponse.text();
      expect(consentResponse.status, consentBody).toBe(200);
      expect(JSON.parse(consentBody)).toMatchObject({ redirect: true, url: expect.any(String) });
      const callback = new URL((JSON.parse(consentBody) as { url: string }).url, origin);
      expect(callback.searchParams.get('state')).toBe('fixture-state');
      expect(callback.searchParams.get('iss')).toBe(`${origin}/api/auth`);
      const code = callback.searchParams.get('code');
      expect(code).toBeTruthy();

      const exchangeBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauthClient.client_id,
        code: code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${origin}/mcp`,
      });
      const tokenEndpoint = `${origin}/api/auth/oauth2/token`;
      const exchange = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: exchangeBody,
      });
      const issued = (await exchange.json()) as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      expect(exchange.status, `error=${issued.error} ${issued.error_description}`).toBe(200);
      expect(issued).toMatchObject({
        access_token: expect.any(String),
        token_type: 'Bearer',
      });
      const tokenClaims = decodeJwt(issued.access_token!);
      expect(tokenClaims).toMatchObject({
        sub: saved.id,
        azp: oauthClient.client_id,
        aud: `${origin}/mcp`,
      });
      expect(decodeProtectedHeader(issued.access_token!).typ).toBe('at+jwt');
      expect(issued.scope).toContain('easyeda.read');

      const replay = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: exchangeBody,
      });
      const replayResponse = (await replay.json()) as { error?: string };
      expect(replay.status).toBe(400);
      expect(replayResponse.error).toBe('invalid_grant');

      const unauthenticatedClients = await fetch(`${origin}/cloud/api/clients`);
      expect(unauthenticatedClients.status).toBe(401);
      const namedClients = await fetch(`${origin}/cloud/api/clients`, { headers });
      expect(namedClients.status).toBe(200);
      await expect(namedClients.json()).resolves.toMatchObject({
        clients: [
          {
            id: expect.any(String),
            clientId: oauthClient.client_id,
            name: 'Fixture MCP Agent',
            scopes: expect.arrayContaining(['easyeda.read']),
          },
        ],
      });

      const resourceCheck = await fetch(`${origin}/remote/sessions`, {
        headers: { Authorization: `Bearer ${issued.access_token}` },
      });
      expect(resourceCheck.status, `resource status ${resourceCheck.status}`).toBe(200);
      await expect(resourceCheck.json()).resolves.toMatchObject({
        ok: true,
        sessions: [expect.objectContaining({ sessionId })],
      });

      client = new Client({ name: 'real-provider-mcp-fixture', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${issued.access_token}` } },
        }),
      );
      const read = await client.callTool({
        name: 'easyeda_schematic_components',
        arguments: { projectId: 'disposable-project' },
      });
      expect(read.isError).not.toBe(true);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]).toMatchObject({ sessionId, riskLevel: 'read' });

      // The currently open extension can switch projects. The previously
      // approved selection must not authorize the new project until the owner
      // explicitly chooses it again in the Cloud dashboard.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Missing relay heartbeat ack')), 1_500);
        const onMessage = (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === 'heartbeat' && message.source === 'server') {
            clearTimeout(timeout);
            relay.off('message', onMessage);
            resolve();
          }
        };
        relay.on('message', onMessage);
        relay.send(
          JSON.stringify({
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'heartbeat',
            messageId: 'fixture-project-change',
            sessionId,
            timestamp: new Date().toISOString(),
            source: 'extension',
            activeProject: {
              projectId: 'disposable-project',
              documentId: 'schematic-page-two',
              projectName: 'Disposable',
              documentType: 'schematic',
            },
          }),
        );
      });
      const oldProjectRead = await client.callTool({
        name: 'easyeda_schematic_components',
        arguments: { projectId: 'disposable-project' },
      });
      expect(dispatched).toHaveLength(2);
      expect(oldProjectRead.isError).toBe(true);
      expect(oldProjectRead.structuredContent).toMatchObject({
        errorCode: 'ERR_REMOTE_RELAY',
        details: { remoteCode: 'PROJECT_INACTIVE' },
      });
      expect(gateway.selectPairedProject(ownerIdentity, sessionId)).toBe(true);
      const newProjectRead = await client.callTool({
        name: 'easyeda_schematic_components',
        arguments: { projectId: 'disposable-project' },
      });
      expect(newProjectRead.isError).not.toBe(true);
      expect(dispatched).toHaveLength(4);

      // If the paired extension drops off the network, the same authenticated
      // MCP client must receive an explicit failure rather than a fabricated
      // empty schematic, and no more tool calls may reach that extension.
      await new Promise<void>((resolve) => {
        relay.once('close', () => resolve());
        relay.close();
      });
      const offlineRead = await client.callTool({
        name: 'easyeda_schematic_components',
        arguments: { projectId: 'disposable-project' },
      });
      expect(offlineRead.isError).toBe(true);
      expect(offlineRead.structuredContent).toMatchObject({
        errorCode: 'ERR_REMOTE_RELAY',
        details: { remoteCode: 'SESSION_DISCONNECTED' },
      });
      expect(dispatched).toHaveLength(4);

      // A browser cannot turn a signed read-only consent into a write grant.
      const tamperedConsent = new URL(consentUrl);
      tamperedConsent.searchParams.set('scope', 'easyeda.write');
      const modifiedPage = await fetch(tamperedConsent, { headers });
      expect(modifiedPage.status).toBe(400);

      const deniedQuery = new URLSearchParams(authorizeQuery);
      deniedQuery.set('prompt', 'consent');
      const authorizeAgain = await fetch(`${origin}/api/auth/oauth2/authorize?${deniedQuery}`, {
        headers,
      });
      expect(authorizeAgain.status).toBe(200);
      const authorizeAgainData = (await authorizeAgain.json()) as { url?: string };
      expect(authorizeAgainData.url).toContain('/consent?');
      const denyConsent = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: false,
          oauth_query: new URL(authorizeAgainData.url!, origin).search.slice(1),
        }),
      });
      const rejected = (await denyConsent.json()) as {
        redirect?: boolean;
        url?: string;
        error?: string;
        error_description?: string;
      };
      expect(denyConsent.status, `error=${rejected.error} ${rejected.error_description}`).toBe(200);
      expect(rejected.redirect).toBe(true);
      const deniedCallback = new URL(rejected.url!, origin);
      expect(deniedCallback.searchParams.get('error')).toBe('access_denied');
      expect(deniedCallback.searchParams.get('code')).toBeNull();

      // An intercepted OAuth authorization code must not be redeemable with
      // a different S256 PKCE verifier even after explicit user consent.
      const pkceQuery = new URLSearchParams(authorizeQuery);
      pkceQuery.set('prompt', 'consent');
      pkceQuery.set('state', 'wrong-pkce-test');
      const pkceStart = await fetch(`${origin}/api/auth/oauth2/authorize?${pkceQuery}`, {
        headers,
      });
      expect(pkceStart.status).toBe(200);
      const pkceLocation = (await pkceStart.json()) as { url: string };
      const approve = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(pkceLocation.url, origin).search.slice(1),
        }),
      });
      expect(approve.status).toBe(200);
      const approvalData = (await approve.json()) as { url: string };
      const approvalCode = new URL(approvalData.url, origin).searchParams.get('code');
      expect(approvalCode).toBeTruthy();
      const invalidVerifier = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oauthClient.client_id,
          code: approvalCode!,
          code_verifier: randomBytes(32).toString('base64url'),
          redirect_uri: redirectUri,
          resource: `${origin}/mcp`,
        }),
      });
      const invalidPkceBody = (await invalidVerifier.json()) as {
        error?: string;
        access_token?: string;
      };
      expect(invalidVerifier.status).toBe(400);
      expect(invalidPkceBody.access_token).toBeUndefined();
      expect(invalidPkceBody.error).toBe('invalid_grant');

      // User-facing revoke must take away an existing OAuth client's
      // ability to use the already-issued MCP resource access token.
      const consentList = await fetch(`${origin}/api/auth/oauth2/get-consents`, { headers });
      expect(consentList.status).toBe(200);
      const consents = (await consentList.json()) as Array<{
        id: string;
        clientId: string;
        scopes: string[];
        userId: string;
      }>;
      const activeConsent = consents.find((entry) => entry.clientId === oauthClient.client_id);
      expect(activeConsent).toMatchObject({
        id: expect.any(String),
        clientId: oauthClient.client_id,
        userId: saved.id,
      });
      const revoke = await fetch(`${origin}/api/auth/oauth2/delete-consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: activeConsent!.id }),
      });
      expect(revoke.status).toBe(200);
      const afterRevoke = await fetch(`${origin}/remote/sessions`, {
        headers: { Authorization: `Bearer ${issued.access_token}` },
      });
      expect(
        afterRevoke.status,
        'An OAuth bearer must stop accessing Cloud immediately after the owner revokes its consent.',
      ).toBe(403);
      const beforeRevokedCall = dispatched.length;
      await expect(
        client.callTool({
          name: 'easyeda_schematic_components',
          arguments: { projectId: 'must-not-reach-extension-after-revoke' },
        }),
      ).rejects.toThrow(/consent_revoked/);
      expect(dispatched).toHaveLength(beforeRevokedCall);

      // Reauthorization creates a new grant. A previously revoked JWT cannot
      // regain access even when the same owner authorizes the same client again.
      // JWT iat has second resolution; the new grant must mint after the
      // recorded revocation second.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const reauthorize = await fetch(
        `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
          ...Object.fromEntries(authorizeQuery),
          prompt: 'consent',
          state: 'regrant-state',
        })}`,
        { headers },
      );
      expect(reauthorize.status).toBe(200);
      const renewedAuthorization = (await reauthorize.json()) as { url: string };
      const renewedConsent = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(renewedAuthorization.url, origin).search.slice(1),
        }),
      });
      expect(renewedConsent.status).toBe(200);
      const renewedCallback = (await renewedConsent.json()) as { url: string };
      const renewedCode = new URL(renewedCallback.url, origin).searchParams.get('code');
      expect(renewedCode).toBeTruthy();
      const replacementToken = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oauthClient.client_id,
          code: renewedCode!,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: `${origin}/mcp`,
        }),
      });
      expect(replacementToken.status).toBe(200);
      const newGrant = (await replacementToken.json()) as { access_token: string };
      expect(newGrant.access_token).toBeTruthy();
      expect(
        (
          await fetch(`${origin}/remote/sessions`, {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${origin}/remote/sessions`, {
            headers: { Authorization: `Bearer ${newGrant.access_token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await client?.close();
      if (socket && socket.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          socket!.once('close', resolve);
          socket!.close();
        });
      }
      await transport.close();
      await mcpServer.shutdown();
      database.close();
      await rm(dataDir, { force: true, recursive: true });
    }
  }, 20_000);
});

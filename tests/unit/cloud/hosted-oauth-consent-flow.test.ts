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
    const approvalRequests: Array<Record<string, unknown>> = [];
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
                result:
                  request.toolName === 'schematic.addText'
                    ? { primitiveId: 'fixture-disposable-text' }
                    : { total: 0, items: [] },
                durationMs: 1,
              }),
            );
          } else if (message.type === 'approval_request') {
            approvalRequests.push(message);
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
      const pairedHealth = await client.callTool({
        name: 'easyeda_health_check',
        arguments: {},
      });
      expect(pairedHealth.structuredContent).toMatchObject({
        status: 'ok',
        bridge_connected: true,
      });

      const read = await client.callTool({
        name: 'easyeda_schematic_components',
        arguments: { projectId: 'disposable-project' },
      });
      expect(read.isError).not.toBe(true);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]).toMatchObject({ sessionId, riskLevel: 'read' });

      // The previously approved read-only bearer may enumerate tools, but
      // must NOT request a mutation or an approval from the owner's extension.
      const deniedByScope = await client.callTool({
        name: 'easyeda_schematic_add_text',
        arguments: { x: 10, y: 20, content: 'Denied by read-only OAuth', confirmWrite: true },
      });
      expect(deniedByScope.isError).toBe(true);
      expect(deniedByScope.structuredContent).toMatchObject({
        errorCode: 'ERR_REMOTE_RELAY',
        details: { remoteCode: 'SCOPE_MISSING' },
      });
      expect(JSON.stringify(deniedByScope)).toContain(
        'Reconnect your MCP client requesting easyeda.write',
      );
      const deniedExportByScope = await client.callTool({
        name: 'easyeda_export_gerbers',
        arguments: { projectId: 'disposable-project' },
      });
      expect(deniedExportByScope.isError).toBe(true);
      expect(deniedExportByScope.structuredContent).toMatchObject({
        errorCode: 'ERR_REMOTE_RELAY',
        details: { remoteCode: 'SCOPE_MISSING' },
      });
      expect(JSON.stringify(deniedExportByScope)).toContain(
        'Reconnect your MCP client requesting easyeda.export',
      );
      expect(approvalRequests).toHaveLength(0);
      expect(dispatched).toHaveLength(2);

      // Register a SECOND OAuth client for the same owner and request explicit
      // read/write/export scopes through the actual first-party authorization
      // server and signed consent page, not a forged self-signed bearer token.
      const fullScopes = 'easyeda.read easyeda.write easyeda.export';
      const registerFullClient = await fetch(`${origin}/api/auth/oauth2/create-client`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_name: 'Fixture Full-Scope Client',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          application_type: 'native',
          scope: fullScopes,
        }),
      });
      const fullRegistration = (await registerFullClient.json()) as {
        client_id?: string;
        error?: string;
      };
      expect(registerFullClient.status, fullRegistration.error).toBe(201);
      expect(fullRegistration.client_id).toBeTruthy();
      const fullVerifier = randomBytes(32).toString('base64url');
      const fullQuery = new URLSearchParams({
        response_type: 'code',
        client_id: fullRegistration.client_id!,
        redirect_uri: redirectUri,
        scope: fullScopes,
        code_challenge: createHash('sha256').update(fullVerifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: 'full-scope-fixture',
        resource: `${origin}/mcp`,
      });
      const fullAuthorize = await fetch(`${origin}/api/auth/oauth2/authorize?${fullQuery}`, {
        headers,
      });
      expect(fullAuthorize.status).toBe(200);
      const fullConsentUrl = new URL(((await fullAuthorize.json()) as { url: string }).url, origin);
      const fullConsentPage = await fetch(fullConsentUrl, { headers });
      expect(fullConsentPage.status).toBe(200);
      const consentHtml = await fullConsentPage.text();
      expect(consentHtml).toContain('Request design changes');
      expect(consentHtml).toContain('Export design files');

      const grantFullScopes = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: fullConsentUrl.search.slice(1),
        }),
      });
      expect(grantFullScopes.status).toBe(200);
      const grantedCallback = new URL(
        ((await grantFullScopes.json()) as { url: string }).url,
        origin,
      );
      const fullCode = grantedCallback.searchParams.get('code');
      expect(fullCode).toBeTruthy();
      const fullExchange = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: fullRegistration.client_id!,
          code: fullCode!,
          code_verifier: fullVerifier,
          redirect_uri: redirectUri,
          resource: `${origin}/mcp`,
        }),
      });
      const fullIssued = (await fullExchange.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      expect(fullExchange.status, fullIssued.error_description).toBe(200);
      expect(decodeJwt(fullIssued.access_token!)).toMatchObject({
        sub: saved.id,
        azp: fullRegistration.client_id,
      });
      expect(fullIssued.scope?.split(' ')).toEqual(expect.arrayContaining(fullScopes.split(' ')));

      const fullClient = new Client({ name: 'full-scope-fixture', version: '1.0.0' });
      try {
        await fullClient.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: {
              headers: { Authorization: `Bearer ${fullIssued.access_token}` },
            },
          }),
        );
        const writeArguments = {
          x: 15,
          y: 25,
          content: 'Fixture only',
          confirmWrite: true,
        };
        const pendingApproval = await fullClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: writeArguments,
        });
        expect(pendingApproval.isError).toBe(true);
        expect(pendingApproval.structuredContent).toMatchObject({
          errorCode: 'ERR_REMOTE_RELAY',
          details: { remoteCode: 'APPROVAL_REQUIRED', approvalId: expect.any(String) },
        });
        const approvalId = (
          pendingApproval.structuredContent as { details: { approvalId: string } }
        ).details.approvalId;
        expect(approvalRequests).toHaveLength(1);
        expect(approvalRequests[0]).toMatchObject({
          type: 'approval_request',
          approvalId,
          sessionId,
          riskLevel: 'write',
          toolName: 'easyeda_schematic_add_text',
        });
        expect(dispatched).toHaveLength(2);

        // A rejected extension-side approval can never perform the mutation.
        relay.send(
          JSON.stringify({
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'approval_result',
            messageId: 'fixture-reject-write',
            sessionId,
            approvalId,
            result: 'rejected',
            timestamp: new Date().toISOString(),
          }),
        );
        const rejected = await fullClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: { ...writeArguments, remoteApprovalId: approvalId },
        });
        expect(rejected.isError).toBe(true);
        expect(rejected.structuredContent).toMatchObject({
          errorCode: 'ERR_REMOTE_RELAY',
          details: { remoteCode: 'APPROVAL_NOT_APPROVED' },
        });
        expect(dispatched).toHaveLength(2);

        // A distinct approved request may be dispatched ONCE to the fake
        // WebSocket peer. This is NOT a live EasyEDA design modification.
        const approvedInput = { ...writeArguments, content: 'Approved fixture only' };
        const newApproval = await fullClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: approvedInput,
        });
        const approvedId = (newApproval.structuredContent as { details: { approvalId: string } })
          .details.approvalId;
        expect(approvalRequests).toHaveLength(2);
        relay.send(
          JSON.stringify({
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'approval_result',
            messageId: 'fixture-approve-write',
            sessionId,
            approvalId: approvedId,
            result: 'approved',
            timestamp: new Date().toISOString(),
          }),
        );
        const approvedWrite = await fullClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: { ...approvedInput, remoteApprovalId: approvedId },
        });
        expect(approvedWrite.isError).not.toBe(true);
        expect(approvedWrite.structuredContent).toMatchObject({
          success: true,
          text: { primitiveId: 'fixture-disposable-text' },
        });
        expect(dispatched).toHaveLength(3);
        expect(dispatched[2]).toMatchObject({
          sessionId,
          toolName: 'schematic.addText',
          riskLevel: 'write',
        });
        const replay = await fullClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: { ...approvedInput, remoteApprovalId: approvedId },
        });
        expect(replay.isError).toBe(true);
        expect(dispatched).toHaveLength(3);

        // Export has its OWN scope and extension-side approval. Rejecting
        // the simulated export must not write a Gerber artifact.
        const exportInput = { projectId: 'disposable-project' };
        const pendingExport = await fullClient.callTool({
          name: 'easyeda_export_gerbers',
          arguments: exportInput,
        });
        expect(pendingExport.isError).toBe(true);
        expect(pendingExport.structuredContent).toMatchObject({
          errorCode: 'ERR_REMOTE_RELAY',
          details: { remoteCode: 'APPROVAL_REQUIRED', approvalId: expect.any(String) },
        });
        const exportApprovalId = (
          pendingExport.structuredContent as { details: { approvalId: string } }
        ).details.approvalId;
        expect(approvalRequests).toHaveLength(3);
        expect(approvalRequests[2]).toMatchObject({
          type: 'approval_request',
          approvalId: exportApprovalId,
          sessionId,
          riskLevel: 'export',
          toolName: 'easyeda_export_gerbers',
        });
        relay.send(
          JSON.stringify({
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'approval_result',
            messageId: 'fixture-reject-export',
            sessionId,
            approvalId: exportApprovalId,
            result: 'rejected',
            timestamp: new Date().toISOString(),
          }),
        );
        const deniedExport = await fullClient.callTool({
          name: 'easyeda_export_gerbers',
          arguments: { ...exportInput, remoteApprovalId: exportApprovalId },
        });
        expect(deniedExport.isError).toBe(true);
        expect(deniedExport.structuredContent).toMatchObject({
          errorCode: 'ERR_REMOTE_RELAY',
          details: { remoteCode: 'APPROVAL_NOT_APPROVED' },
        });
        expect(dispatched).toHaveLength(3);
      } finally {
        await fullClient.close();
      }

      // OAuth consent must grant only the selected subset, not all requested scopes.
      const selectiveVerifier = randomBytes(32).toString('base64url');
      const selectiveQuery = new URLSearchParams(fullQuery);
      selectiveQuery.set('prompt', 'consent');
      selectiveQuery.set('state', 'selective-read-only');
      selectiveQuery.set(
        'code_challenge',
        createHash('sha256').update(selectiveVerifier).digest('base64url'),
      );
      const selectiveAuthorize = await fetch(
        origin + '/api/auth/oauth2/authorize?' + selectiveQuery,
        { headers },
      );
      expect(selectiveAuthorize.status).toBe(200);
      const selectiveUrl = new URL(
        ((await selectiveAuthorize.json()) as { url: string }).url,
        origin,
      );
      const selectiveConsent = await fetch(origin + '/api/auth/oauth2/consent', {
        method: 'POST',
        headers: {
          cookie: headers.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: true,
          scope: 'easyeda.read',
          oauth_query: selectiveUrl.search.slice(1),
        }),
      });
      const selectiveResult = (await selectiveConsent.json()) as { url?: string; error?: string };
      expect(selectiveConsent.status, selectiveResult.error).toBe(200);
      const selectiveCode = new URL(selectiveResult.url!, origin).searchParams.get('code');
      expect(selectiveCode).toBeTruthy();
      const selectiveExchange = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: fullRegistration.client_id!,
          code: selectiveCode!,
          code_verifier: selectiveVerifier,
          redirect_uri: redirectUri,
          resource: origin + '/mcp',
        }),
      });
      const selectiveIssued = (await selectiveExchange.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
      };
      expect(selectiveExchange.status, selectiveIssued.error).toBe(200);
      expect(selectiveIssued.scope?.split(' ')).toEqual(['easyeda.read']);
      const selectiveClient = new Client({
        name: 'selective-read-client',
        version: '1.0.0',
      });
      try {
        await selectiveClient.connect(
          new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
            requestInit: {
              headers: { Authorization: 'Bearer ' + selectiveIssued.access_token },
            },
          }),
        );
        const prohibitedWrite = await selectiveClient.callTool({
          name: 'easyeda_schematic_add_text',
          arguments: { x: 1, y: 1, content: 'Must not execute', confirmWrite: true },
        });
        expect(prohibitedWrite.isError).toBe(true);
        expect(prohibitedWrite.structuredContent).toMatchObject({
          details: { remoteCode: 'SCOPE_MISSING' },
        });
        expect(dispatched).toHaveLength(3);
      } finally {
        await selectiveClient.close();
      }

      // Two distinct users with real provider-issued OAuth tokens must never
      // share sessions, consent or native dispatch. These identities come from
      // an isolated fixture database, not independently logged-in real people.
      const outsider = await test.saveUser(
        test.createUser({ email: 'second-owner@test.invalid', name: 'Second Fixture Owner' }),
      );
      expect(outsider.id).not.toBe(saved.id);
      const outsiderHeaders = await test.getAuthHeaders({ userId: outsider.id });
      const outsiderExtensions = await fetch(`${origin}/cloud/api/extensions`, {
        headers: outsiderHeaders,
      });
      expect(outsiderExtensions.status).toBe(200);
      await expect(outsiderExtensions.json()).resolves.toMatchObject({ sessions: [] });

      // A signed-in second owner cannot select or remove the first owner's
      // extension by guessing its session ID. These are real fixture-backed
      // HTTP routes; independent human-account acceptance remains separate.
      const outsiderSelect = await fetch(`${origin}/cloud/api/selection`, {
        method: 'PUT',
        headers: {
          cookie: outsiderHeaders.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
      });
      expect(outsiderSelect.status).toBe(404);
      await expect(outsiderSelect.json()).resolves.toMatchObject({
        code: 'PROJECT_NOT_AVAILABLE',
      });

      const outsiderRemove = await fetch(`${origin}/cloud/api/extensions/${sessionId}`, {
        method: 'DELETE',
        headers: { cookie: outsiderHeaders.get('cookie') ?? '', origin },
      });
      expect(outsiderRemove.status).toBe(404);
      await expect(outsiderRemove.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });

      // Rejected cross-owner actions must leave the original owner's
      // paired extension and selected document untouched.
      const retainedOwnerExtension = await fetch(`${origin}/cloud/api/extensions`, { headers });
      expect(retainedOwnerExtension.status).toBe(200);
      await expect(retainedOwnerExtension.json()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId, connected: true })],
        selection: expect.objectContaining({ sessionId }),
      });

      const outsiderClients = await fetch(`${origin}/cloud/api/clients`, {
        headers: outsiderHeaders,
      });
      expect(outsiderClients.status).toBe(200);
      await expect(outsiderClients.json()).resolves.toMatchObject({ clients: [] });

      const outsiderVerifier = randomBytes(32).toString('base64url');
      const outsiderQuery = new URLSearchParams(authorizeQuery);
      outsiderQuery.set('state', 'second-owner-state');
      outsiderQuery.set(
        'code_challenge',
        createHash('sha256').update(outsiderVerifier).digest('base64url'),
      );
      const outsiderAuthorization = await fetch(
        `${origin}/api/auth/oauth2/authorize?${outsiderQuery}`,
        { headers: outsiderHeaders },
      );
      expect(outsiderAuthorization.status).toBe(200);
      const outsiderConsentUrl = new URL(
        ((await outsiderAuthorization.json()) as { url: string }).url,
        origin,
      );
      const outsiderConsent = await fetch(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: {
          cookie: outsiderHeaders.get('cookie') ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: outsiderConsentUrl.search.slice(1),
        }),
      });
      expect(outsiderConsent.status).toBe(200);
      const outsiderCallback = new URL(
        ((await outsiderConsent.json()) as { url: string }).url,
        origin,
      );
      expect(outsiderCallback.searchParams.get('state')).toBe('second-owner-state');
      const outsiderExchange = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oauthClient.client_id,
          code: outsiderCallback.searchParams.get('code') ?? '',
          code_verifier: outsiderVerifier,
          redirect_uri: redirectUri,
          resource: `${origin}/mcp`,
        }),
      });
      const outsiderIssued = (await outsiderExchange.json()) as {
        access_token?: string;
        error?: string;
      };
      expect(outsiderExchange.status, outsiderIssued.error).toBe(200);
      expect(decodeJwt(outsiderIssued.access_token!)).toMatchObject({ sub: outsider.id });

      const outsiderSessions = await fetch(`${origin}/remote/sessions`, {
        headers: { Authorization: `Bearer ${outsiderIssued.access_token}` },
      });
      expect(outsiderSessions.status).toBe(200);
      await expect(outsiderSessions.json()).resolves.toMatchObject({ sessions: [] });

      const secondClient = new Client({ name: 'second-oauth-owner-fixture', version: '1.0.0' });
      try {
        await secondClient.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: {
              headers: { Authorization: `Bearer ${outsiderIssued.access_token}` },
            },
          }),
        );
        const forbiddenRead = await secondClient.callTool({
          name: 'easyeda_schematic_components',
          arguments: { projectId: 'disposable-project' },
        });
        expect(forbiddenRead.isError).toBe(true);
        expect(dispatched).toHaveLength(3);
      } finally {
        await secondClient.close();
      }

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
      expect(dispatched).toHaveLength(3);
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
      expect(dispatched).toHaveLength(5);

      // If the paired extension drops off the network, the same authenticated
      // MCP client must receive an explicit failure rather than a fabricated
      // empty schematic, and no more tool calls may reach that extension.
      await new Promise<void>((resolve) => {
        relay.once('close', () => resolve());
        relay.close();
      });
      const offlineHealth = await client.callTool({
        name: 'easyeda_health_check',
        arguments: {},
      });
      expect(offlineHealth.structuredContent).toMatchObject({
        status: 'degraded',
        bridge_connected: false,
        status_error: expect.stringContaining('Pair your extension'),
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
      expect(dispatched).toHaveLength(5);

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
      ).toBe(401);
      expect(afterRevoke.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(afterRevoke.headers.get('www-authenticate')).toContain(
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
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
      const staleToken = await fetch(`${origin}/remote/sessions`, {
        headers: { Authorization: `Bearer ${issued.access_token}` },
      });
      expect(staleToken.status).toBe(401);
      expect(staleToken.headers.get('www-authenticate')).toContain('error="invalid_token"');
      const refreshedToken = await fetch(`${origin}/remote/sessions`, {
        headers: { Authorization: `Bearer ${newGrant.access_token}` },
      });
      expect(refreshedToken.status).toBe(200);
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

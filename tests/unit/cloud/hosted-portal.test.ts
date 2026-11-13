import * as http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import type { HostedAuth } from '../../../src/cloud/hosted-auth.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';

function fakeProvider(origin: string): HostedAuth {
  return {
    origin,
    options: {},
    handler: async () => new Response(null, { status: 404 }),
    getSessionUser: async (headers: Headers) =>
      headers.get('cookie') === 'session=owner-a'
        ? { id: 'owner-a', name: 'Test Owner', email: 'example@example.com' }
        : headers.get('cookie') === 'session=owner-b'
          ? { id: 'owner-b', name: 'Second Owner', email: 'other@example.com' }
          : null,
    verifySignedQuery: async (query: string) =>
      query ===
      'client_id=valid&scope=easyeda.read&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid',
    getClient: async (_clientId: string, headers: Headers) =>
      headers.get('cookie') === 'session=owner-a'
        ? { name: '<script>alert(1)</script>', redirectUri: 'https://client.example/callback' }
        : null,
  } as HostedAuth;
}

async function withPortal(
  callback: (base: string, gateway: RemoteGateway) => Promise<void>,
): Promise<void> {
  const unused = createNetServer();
  await new Promise<void>((resolve) => unused.listen(0, '127.0.0.1', resolve));
  const unusedAddress = unused.address();
  if (!unusedAddress || typeof unusedAddress === 'string') throw new Error('No port');
  const port = unusedAddress.port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    TRANSPORT: 'http',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: port,
    OAUTH_ENABLED: true,
    OAUTH_ISSUER: `${origin}/api/auth`,
    OAUTH_AUDIENCE: `${origin}/mcp`,
    OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
  });
  const gateway = new RemoteGateway();
  const transport = createHttpTransport(config, { gateway, hostedAuth: fakeProvider(origin) });
  const server = http.createServer(transport.app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await callback(origin, gateway);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Hosted Cloud browser portal', () => {
  it('renders discoverable GitHub and Google sign-in with strict executable asset CSP', async () => {
    await withPortal(async (base) => {
      const login = await fetch(`${base}/sign-in`);
      const html = await login.text();
      expect(login.status).toBe(200);
      expect(html).toContain('Continue with GitHub');
      expect(html).toContain('Continue with Google');
      expect(html).toContain('/cloud/app.js');
      expect(login.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(login.headers.get('cache-control')).toContain('no-store');
      expect(await (await fetch(`${base}/cloud/app.js`)).text()).toContain('oauth_query');
      expect((await fetch(`${base}/cloud`, { redirect: 'manual' })).status).toBe(303);
      const noAuth = await fetch(`${base}/cloud/api/me`);
      expect(noAuth.status).toBe(401);
    });
  });

  it('blocks unsigned, modified or anonymous consent and never interprets client HTML', async () => {
    await withPortal(async (base) => {
      const tampered = await fetch(`${base}/consent?client_id=valid&scope=easyeda.write&sig=valid`);
      expect(tampered.status).toBe(400);
      const query =
        'client_id=valid&scope=easyeda.read&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid';
      const anonymous = await fetch(`${base}/consent?${query}`);
      expect(anonymous.status).toBe(401);
      const signed = await fetch(`${base}/consent?${query}`, {
        headers: { cookie: 'session=owner-a' },
      });
      const html = await signed.text();
      expect(signed.status).toBe(200);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('easyeda.read');
      expect(html).toContain('client.example');
    });
  });

  it('lets only the signed-in owner list, pair and revoke their extensions, with CSRF checks', async () => {
    await withPortal(async (base, gateway) => {
      const unpaired = gateway.registerExtension({
        connectionId: 'extension-1',
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: { projectId: 'board-a', projectName: 'Example board', documentType: 'pcb' },
        dispatch: async (message) => ({
          version: message.version,
          type: 'tool_response',
          requestId: message.requestId,
          ok: true,
          result: null,
        }),
      });
      const send = async (path: string, method: string, cookie: string, site = base) =>
        fetch(`${base}${path}`, {
          method,
          headers: { cookie, origin: site, 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        });
      const unauth = await send('/cloud/api/pairing-code', 'POST', '');
      expect(unauth.status).toBe(401);
      const foreignOrigin = await send(
        '/cloud/api/pairing-code',
        'POST',
        'session=owner-a',
        'https://attacker.example',
      );
      expect(foreignOrigin.status).toBe(403);

      const codeRes = await send('/cloud/api/pairing-code', 'POST', 'session=owner-a');
      expect(codeRes.status).toBe(200);
      const code = (await codeRes.json()) as { code: string; expiresInSeconds: number };
      expect(code.code).toMatch(/^EDA-[A-Z0-9]{8}$/);
      expect(code.expiresInSeconds).toBeLessThanOrEqual(600);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-b', scopes: ['easyeda.read'] },
          code: code.code,
          sessionId: unpaired.sessionId,
        }),
      ).toBe(false);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-a', scopes: ['easyeda.read'] },
          code: code.code,
          sessionId: unpaired.sessionId,
        }),
      ).toBe(true);

      const owner = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(owner.status).toBe(200);
      const sessions = (await owner.json()) as { sessions: Array<{ sessionId: string }> };
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.sessionId).toBe(unpaired.sessionId);
      const putSelection = async (cookie: string, site = base) =>
        fetch(`${base}/cloud/api/selection`, {
          method: 'PUT',
          headers: { cookie, origin: site, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: unpaired.sessionId }),
        });
      expect((await putSelection('session=owner-a', 'https://attacker.example')).status).toBe(403);
      expect((await putSelection('session=owner-b')).status).toBe(404);
      const selected = await putSelection('session=owner-a');
      expect(selected.status).toBe(200);
      await expect(selected.json()).resolves.toMatchObject({
        selection: { sessionId: unpaired.sessionId, projectId: 'board-a' },
      });
      const ownerAfterSelection = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-a' },
      });
      await expect(ownerAfterSelection.json()).resolves.toMatchObject({
        selection: { projectId: 'board-a' },
      });

      const outsider = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-b' },
      });
      expect((await outsider.json()).sessions).toEqual([]);
      expect(
        (await send(`/cloud/api/extensions/${unpaired.sessionId}`, 'DELETE', 'session=owner-b'))
          .status,
      ).toBe(404);
      expect(
        (await send(`/cloud/api/extensions/${unpaired.sessionId}`, 'DELETE', 'session=owner-a'))
          .status,
      ).toBe(204);
      expect(gateway.listPairedExtensions({ userId: 'owner-a', scopes: ['easyeda.read'] })).toEqual(
        [],
      );
      expect(
        gateway.getSelectedProject({ userId: 'owner-a', scopes: ['easyeda.read'] }),
      ).toBeUndefined();
    });
  });

  it('does not expose the portal in the original no-account Local HTTP mode', async () => {
    const transport = createHttpTransport(EnvSchema.parse({ TRANSPORT: 'http' }));
    const server = http.createServer(transport.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No test port');
      const response = await fetch(`http://127.0.0.1:${addr.port}/sign-in`);
      expect(response.status).toBe(404);
      const data = await fetch(`http://127.0.0.1:${addr.port}/cloud/api/me`);
      expect(data.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

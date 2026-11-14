import * as http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';
import type { HostedAuth } from '../../../src/cloud/hosted-auth.js';

describe('Hosted Cloud MCP token verification', () => {
  it('accepts an EdDSA resource-bound OAuth access token from the provider defaults', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-signing-key';
    const jwks = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const jwksAddress = jwks.address();
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('Missing JWKS port');

    const port = 3993;
    const baseURL = `http://127.0.0.1:${port}`;
    const hostedAuth: HostedAuth = {
      origin: 'https://easyeda-mcp-pro.oaslananka.dev',
      options: {},
      listClientConsents: async () => [],
      installGrantProtection: () => undefined,
      checkAccessGrant: () => true, // Cryptographic-only test; real grants use the provider integration test.
      handler: async () => new Response(null, { status: 404 }),
    };
    const transport = createHttpTransport(
      EnvSchema.parse({
        TRANSPORT: 'http',
        NODE_ENV: 'test',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: port,
        OAUTH_ENABLED: true,
        OAUTH_ISSUER: `${baseURL}/api/auth`,
        OAUTH_AUDIENCE: `${baseURL}/mcp`,
        OAUTH_JWKS_URI: `http://127.0.0.1:${jwksAddress.port}/jwks`,
      }),
      { hostedAuth },
    );
    const server = http.createServer(transport.app);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const makeToken = async (typ: string, extra: Record<string, unknown> = {}) =>
      new SignJWT({ sub: 'owner-1', scope: 'easyeda.read', azp: 'client-1', ...extra })
        .setProtectedHeader({ alg: 'EdDSA', typ, kid: 'test-signing-key' })
        .setIssuer(`${baseURL}/api/auth`)
        .setAudience(`${baseURL}/mcp`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    try {
      const valid = await makeToken('at+jwt');
      const accepted = await fetch(`${baseURL}/remote/sessions`, {
        headers: { Authorization: `Bearer ${valid}` },
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ ok: true, sessions: [] });
      // A hosted reverse proxy forwards the public Host, even when the
      // application listens only on loopback. Discovery must stay canonical.
      const requestWithHost = async (host: string) =>
        await new Promise<{ status: number; challenge?: string }>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port, path: '/remote/sessions', headers: { host } },
            (response) => {
              response.resume();
              response.on('end', () =>
                resolve({
                  status: response.statusCode ?? 0,
                  challenge: String(response.headers['www-authenticate'] ?? ''),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        });
      const unauthenticated = await requestWithHost('easyeda-mcp-pro.oaslananka.dev');
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.challenge).toContain(
        'https://easyeda-mcp-pro.oaslananka.dev/.well-known/oauth-protected-resource/mcp',
      );
      expect((await requestWithHost('untrusted.example')).status).toBe(400);

      for (const [label, token] of [
        ['browser session JWT', await makeToken('JWT')],
        ['access token without authorized client', await makeToken('at+jwt', { azp: undefined })],
        [
          'DPoP-bound token without proof',
          await makeToken('at+jwt', { cnf: { jkt: 'proof-key' } }),
        ],
      ] as const) {
        const denied = await fetch(`${baseURL}/remote/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(denied.status, label).toBe(401);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    }
  });
});

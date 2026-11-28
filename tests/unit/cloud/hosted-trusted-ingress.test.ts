import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EnvSchema, detectUnknownEnvVars } from '../../../src/config/env.js';
import { createHostedAuth } from '../../../src/cloud/hosted-auth.js';
import { parseHostedCloudSettings } from '../../../src/cloud/runtime.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';

const origin = 'http://127.0.0.1:3997';
const config = EnvSchema.parse({
  NODE_ENV: 'test',
  TRANSPORT: 'http',
  HTTP_HOST: '127.0.0.1',
  MCP_BRIDGE_BACKEND: 'remote_relay',
  OAUTH_ENABLED: true,
  OAUTH_ISSUER: origin + '/api/auth',
  OAUTH_AUDIENCE: origin + '/mcp',
  OAUTH_JWKS_URI: origin + '/api/auth/jwks',
  HTTP_RATE_LIMIT_MAX: 2,
});
const env = {
  CLOUD_HOSTED_ENABLED: 'true',
  CLOUD_HOSTED_ORIGIN: origin,
  CLOUD_AUTH_SECRET: 'fixture-only-secret-fixture-only-secret',
  CLOUD_GITHUB_CLIENT_ID: 'fake-github',
  CLOUD_GITHUB_CLIENT_SECRET: 'fake-secret',
  CLOUD_GOOGLE_CLIENT_ID: 'fake-google',
  CLOUD_GOOGLE_CLIENT_SECRET: 'fake-secret',
};

describe('Hosted trusted ingress', () => {
  it('is deployment-private, opt-in and validates an exact IPv4 peer', () => {
    expect(parseHostedCloudSettings(config, env)?.trustedProxyIp).toBeUndefined();
    expect(
      parseHostedCloudSettings(config, { ...env, CLOUD_TRUSTED_PROXY_IP: '127.0.0.1' })
        ?.trustedProxyIp,
    ).toBe('127.0.0.1');
    expect(detectUnknownEnvVars({ CLOUD_TRUSTED_PROXY_IP: '127.0.0.1' })).toEqual([]);
    for (const ip of ['true', '0.0.0.0', '127.0.0.0/8', '::1', '127.0.0.1,127.0.0.2']) {
      expect(() =>
        parseHostedCloudSettings(config, { ...env, CLOUD_TRUSTED_PROXY_IP: ip }),
      ).toThrow(/proxy/i);
    }
    expect(
      parseHostedCloudSettings(config, {
        ...env,
        CLOUD_HOSTED_ENABLED: 'false',
        CLOUD_TRUSTED_PROXY_IP: '127.0.0.1',
      }),
    ).toBeUndefined();
  });

  async function withServer(peer: string, run: (base: string) => Promise<void>) {
    const database = new DatabaseSync(':memory:');
    const auth = createHostedAuth({
      origin,
      secret: env.CLOUD_AUTH_SECRET,
      database,
      trustedProxyIp: peer,
      github: { clientId: 'fake-github', clientSecret: 'fake-secret' },
      google: { clientId: 'fake-google', clientSecret: 'fake-secret' },
    });
    await (await getMigrations(auth.options)).runMigrations();
    await auth.ready();
    const transport = createHttpTransport(config, { hostedAuth: auth });
    const server = createServer(transport.app);
    transport.gateway.attachWebSocketServer(server, config, origin, peer);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('no listener');
      await run('http://127.0.0.1:' + address.port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    }
  }

  it('keeps separate client budgets while rejecting missing and multi-hop identities', async () => {
    await withServer('127.0.0.1', async (base) => {
      const call = (ip?: string) =>
        fetch(base + '/mcp', { headers: ip ? { 'x-forwarded-for': ip } : {} });
      expect((await call()).status).toBe(400);
      expect((await call('192.0.2.2, 192.0.2.3')).status).toBe(400);
      expect((await call('192.0.2.2')).status).toBe(401);
      expect((await call('192.0.2.2')).status).toBe(401);
      expect((await call('192.0.2.2')).status).toBe(429);
      expect((await call('192.0.2.3')).status).toBe(401);
      expect((await fetch(base + '/healthz')).status).toBe(200);
    });
  });

  it('normalizes IPv4-mapped addresses and preserves IPv6 subnet limits', async () => {
    await withServer('127.0.0.1', async (base) => {
      const call = (ip: string) => fetch(base + '/mcp', { headers: { 'x-forwarded-for': ip } });
      expect((await call('192.0.2.2')).status).toBe(401);
      expect((await call('::ffff:c000:202')).status).toBe(401);
      expect((await call('::ffff:192.0.2.2')).status).toBe(429);
      expect((await call('2001:db8:1::1')).status).toBe(401);
      expect((await call('2001:0db8:0001:0:0:0:0:1')).status).toBe(401);
      expect((await call('2001:db8:1::2')).status).toBe(429);
      expect((await call('2001:db8:2::1')).status).toBe(401);
      expect((await call('fe80::1%eth0')).status).toBe(400);
    });
  });

  it('rejects untrusted direct HTTP and WS peers even with an asserted IP', async () => {
    await withServer('192.0.2.100', async (base) => {
      expect(
        (await fetch(base + '/mcp', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status,
      ).toBe(403);
      expect((await fetch(base + '/healthz')).status).toBe(200);
      expect(await upgrade(base, '192.0.2.2')).toBe(403);
    });
  });

  it('applies the same admission identity to WebSocket upgrades', async () => {
    await withServer('127.0.0.1', async (base) => {
      expect(await upgrade(base)).toBe(400);
      expect(await upgrade(base, '192.0.2.2, 192.0.2.3')).toBe(400);
      expect(await upgrade(base, '192.0.2.2')).toBe(101);
      expect(await upgrade(base, '192.0.2.2')).toBe(101);
      expect(await upgrade(base, '192.0.2.2')).toBe(429);
      expect(await upgrade(base, '192.0.2.3')).toBe(101);
    });
  });
});

async function upgrade(base: string, ip?: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/remote/relay', {
      headers: { Host: '127.0.0.1:3997', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    });
    ws.once('open', () => {
      ws.once('close', () => resolve(101));
      ws.close();
    });
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once('error', reject);
  });
}

import { DatabaseSync } from 'node:sqlite';
import * as http from 'node:http';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { createHostedAuth } from '../../../src/cloud/hosted-auth.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('explicitly hosted HTTP auth', () => {
  it('serves provider OAuth discovery, resource metadata and secure sessions without local MCP sign-in', async () => {
    const database = new DatabaseSync(':memory:');
    const auth = createHostedAuth({
      origin: 'http://127.0.0.1:3996',
      secret: '1234567890abcdef1234567890abcdef1234567890abcdef',
      database,
      github: { clientId: 'fake-github', clientSecret: 'fake-secret' },
      google: { clientId: 'fake-google', clientSecret: 'fake-secret' },
    });
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      TRANSPORT: 'http',
      HTTP_PORT: 3996,
      HTTP_HOST: '127.0.0.1',
      OAUTH_ENABLED: true,
      OAUTH_ISSUER: 'http://127.0.0.1:3996/api/auth',
      OAUTH_AUDIENCE: 'http://127.0.0.1:3996/mcp',
      OAUTH_JWKS_URI: 'http://127.0.0.1:3996/api/auth/jwks',
    });
    const transport = createHttpTransport(config, { hostedAuth: auth });
    const server = http.createServer(transport.app);
    await new Promise<void>((resolve) => server.listen(3996, '127.0.0.1', resolve));
    try {
      // The container health probe has no bearer token, but MCP still must.
      const health = await fetch('http://127.0.0.1:3996/healthz');
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok' });
      const readiness = await fetch('http://127.0.0.1:3996/readyz');
      expect(readiness.status).toBe(200);
      await expect(readiness.json()).resolves.toMatchObject({ status: 'ok' });
      const protectedMcp = await fetch('http://127.0.0.1:3996/mcp');
      expect(protectedMcp.status).toBe(401);
      const protectedSessions = await fetch('http://127.0.0.1:3996/remote/sessions');
      expect(protectedSessions.status).toBe(401);

      const metadata = await fetch(
        'http://127.0.0.1:3996/api/auth/.well-known/oauth-authorization-server',
      );
      expect(metadata.status).toBe(200);
      expect(metadata.headers.get('content-type')).toMatch(/application\/json/);
      await expect(metadata.json()).resolves.toMatchObject({
        client_id_metadata_document_supported: true,
        issuer: 'http://127.0.0.1:3996/api/auth',
        token_endpoint: 'http://127.0.0.1:3996/api/auth/oauth2/token',
      });

      const resource = await fetch('http://127.0.0.1:3996/.well-known/oauth-protected-resource');
      expect(resource.status).toBe(200);
      await expect(resource.json()).resolves.toMatchObject({
        resource: 'http://127.0.0.1:3996/mcp',
        authorization_servers: ['http://127.0.0.1:3996/api/auth'],
      });

      const register = await fetch('http://127.0.0.1:3996/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect([403, 404]).toContain(register.status);

      const currentSession = await fetch('http://127.0.0.1:3996/api/auth/get-session');
      expect(currentSession.status).toBe(200);
      expect(await currentSession.json()).toBeNull();
      expect(metadata.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    }
  });

  it('refuses to enable hosted Cloud when MCP bearer-token authentication is disabled', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const auth = createHostedAuth({
        origin: 'http://127.0.0.1:3998',
        secret: '1234567890abcdef1234567890abcdef1234567890abcdef',
        database,
        github: { clientId: 'fake-github', clientSecret: 'fake-secret' },
        google: { clientId: 'fake-google', clientSecret: 'fake-secret' },
      });
      const unsafe = EnvSchema.parse({
        NODE_ENV: 'test',
        TRANSPORT: 'http',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: 3998,
        OAUTH_ENABLED: false,
      });
      expect(() => createHttpTransport(unsafe, { hostedAuth: auth })).toThrow(
        /Hosted Cloud requires OAuth bearer-token validation/,
      );
    } finally {
      database.close();
    }
  });

  it('does not silently mount an identity provider in existing no-account Local mode', async () => {
    const transport = createHttpTransport(EnvSchema.parse({ NODE_ENV: 'test', TRANSPORT: 'http' }));
    const server = http.createServer(transport.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No HTTP address');
      expect(
        (
          await fetch(
            `http://127.0.0.1:${address.port}/api/auth/.well-known/oauth-authorization-server`,
          )
        ).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

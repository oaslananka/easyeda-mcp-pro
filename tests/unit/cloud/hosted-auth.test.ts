import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { createHostedAuth, type HostedAuthSettings } from '../../../src/cloud/hosted-auth.js';

function settings(database: DatabaseSync): HostedAuthSettings {
  return {
    origin: 'http://127.0.0.1:3997',
    secret: '1234567890abcdef1234567890abcdef1234567890abcdef',
    database,
    github: { clientId: 'github-client-for-tests', clientSecret: 'github-secret-for-tests' },
    google: { clientId: 'google-client-for-tests', clientSecret: 'google-secret-for-tests' },
  };
}

describe('Hosted Cloud OAuth provider (opt-in)', () => {
  it('uses the existing Node.js SQLite runtime for provider state and produces resource-bound CIMD discovery', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      const auth = createHostedAuth(settings(database));
      const migrations = await getMigrations(auth.options);
      await migrations.runMigrations();
      auth.installGrantProtection();
      auth.installGrantProtection(); // Restart-safe, idempotent initialization.
      const trigger = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='cloudConsentRemoved'",
        )
        .get();
      expect(trigger).toMatchObject({ name: 'cloudConsentRemoved' });
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining(['user', 'session', 'oauthClient', 'jwks', 'cloudClientRevocation']),
      );

      const issuer = await auth.handler(
        new Request('http://127.0.0.1:3997/api/auth/.well-known/oauth-authorization-server'),
      );
      expect(issuer.status).toBe(200);
      const metadata = (await issuer.json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        issuer: 'http://127.0.0.1:3997/api/auth',
        token_endpoint: 'http://127.0.0.1:3997/api/auth/oauth2/token',
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ['S256'],
      });
      expect(metadata).not.toHaveProperty('registration_endpoint');
      const resource = await auth.handler(
        new Request('http://127.0.0.1:3997/.well-known/oauth-protected-resource'),
      );
      expect(resource.status).toBe(200);
      await expect(resource.json()).resolves.toMatchObject({
        resource: 'http://127.0.0.1:3997/mcp',
        authorization_servers: ['http://127.0.0.1:3997/api/auth'],
      });
    } finally {
      database.close();
    }
  });

  it('rejects incomplete providers, insecure public URLs, and weak secrets instead of silently enabling Cloud', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const valid = settings(database);
      for (const broken of [
        { ...valid, origin: 'http://cloud.example.com' },
        { ...valid, origin: 'https://example.com/unsafe-path' },
        { ...valid, origin: 'https://user:pass@example.com' },
        { ...valid, secret: 'short' },
        { ...valid, github: { ...valid.github, clientId: '' } },
        { ...valid, google: { ...valid.google, clientSecret: '' } },
      ]) {
        expect(() => createHostedAuth(broken)).toThrow(/Hosted Cloud/);
      }
    } finally {
      database.close();
    }
  });
});

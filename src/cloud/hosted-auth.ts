import type { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';

type ProviderCredentials = { clientId: string; clientSecret: string };

/** Only the explicitly enabled hosted service constructs an OAuth provider. Local MCP does not. */
export interface HostedAuthSettings {
  origin: string;
  secret: string;
  database: DatabaseSync;
  github: ProviderCredentials;
  google: ProviderCredentials;
}

function validHostedOrigin(origin: URL): boolean {
  const loopback =
    origin.hostname === '127.0.0.1' ||
    origin.hostname === 'localhost' ||
    origin.hostname === '[::1]';
  return (
    ['http:', 'https:'].includes(origin.protocol) &&
    (origin.protocol === 'https:' || loopback) &&
    origin.pathname === '/' &&
    !origin.username &&
    !origin.password &&
    !origin.search &&
    !origin.hash
  );
}

function validateHostedAuthSettings(settings: HostedAuthSettings): void {
  let origin: URL;
  try {
    origin = new URL(settings.origin);
  } catch {
    throw new Error('Hosted Cloud requires a canonical public HTTPS URL.');
  }
  if (!validHostedOrigin(origin)) {
    throw new Error('Hosted Cloud requires a public HTTPS origin (loopback HTTP only for tests).');
  }

  if (settings.secret.length < 32) {
    throw new Error('Hosted Cloud requires a strong, separately configured signing secret.');
  }

  for (const [provider, config] of [
    ['GitHub', settings.github],
    ['Google', settings.google],
  ] as const) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new Error(`Hosted Cloud requires configured ${provider} OAuth credentials.`);
    }
  }
}

/**
 * OAuth 2.1 provider + social identity, reusing Node's built-in SQLite.
 * OAuth client consent and PKCE/CIMD remain owned by Better Auth: no duplicate token engine.
 * A separate HTTP adapter will mount this only when Cloud is explicitly enabled.
 */
export interface HostedAccessGrant {
  ownerId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  issuedAt: number;
}

function storedStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
  } catch {
    return [];
  }
}

function hasActiveClientGrant(database: DatabaseSync, request: HostedAccessGrant): boolean {
  if (!request.ownerId || !request.clientId || !Number.isSafeInteger(request.issuedAt)) {
    return false;
  }
  try {
    const revoked = database
      .prepare(
        'SELECT "revokedAt" FROM "cloudClientRevocation" WHERE "userId" = ? AND "clientId" = ?',
      )
      .get(request.ownerId, request.clientId) as { revokedAt?: number } | undefined;
    // JWT iat is second-resolution. Reject the whole revocation second;
    // a re-grant must mint a NEW token in a later second to regain access.
    if (typeof revoked?.revokedAt === 'number' && request.issuedAt <= revoked.revokedAt) {
      return false;
    }
    const grants = database
      .prepare(
        'SELECT "scopes", "resources", "createdAt" FROM "oauthConsent" WHERE "userId" = ? AND "clientId" = ?',
      )
      .all(request.ownerId, request.clientId) as Array<{
      scopes: unknown;
      resources?: unknown;
      createdAt: unknown;
    }>;
    return grants.some((grant) => {
      const createdAt = typeof grant.createdAt === 'string' ? Date.parse(grant.createdAt) : NaN;
      if (!Number.isFinite(createdAt) || request.issuedAt < Math.floor(createdAt / 1000)) {
        return false;
      }
      const allowedScopes = new Set(storedStringArray(grant.scopes));
      if (!request.scopes.every((scope) => allowedScopes.has(scope))) return false;
      const resources = grant.resources == null ? [] : storedStringArray(grant.resources);
      return resources.length === 0 || resources.includes(request.resource);
    });
  } catch {
    // No implicit permission on missing DB tables, closed database or storage errors.
    return false;
  }
}

export interface HostedAuth {
  readonly origin: string;
  readonly options: BetterAuthOptions;
  /** Install the grant-revocation ledger AFTER Better Auth schema migrations. */
  installGrantProtection(): void;
  /** Called after signature verification on every protected Cloud request. */
  checkAccessGrant(request: HostedAccessGrant): boolean;
  handler(request: Request): Promise<Response>;
  getSessionUser(headers: Headers): Promise<{ id: string; name: string; email: string } | null>;
  verifySignedQuery(query: string): Promise<boolean>;
  /** Return only the signed-in user's recognized OAuth clients. */
  listClientConsents(
    headers: Headers,
  ): Promise<Array<{ id: string; clientId: string; name: string; scopes: string[] }>>;
  getClient(
    clientId: string,
    headers: Headers,
  ): Promise<{ name: string; redirectUri?: string } | null>;
}

export function createHostedAuth(settings: HostedAuthSettings): HostedAuth {
  validateHostedAuthSettings(settings);
  const provider = betterAuth({
    baseURL: settings.origin,
    secret: settings.secret,
    database: settings.database,
    disabledPaths: ['/token'],
    socialProviders: {
      github: settings.github,
      google: settings.google,
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: '/sign-in',
        consentPage: '/consent',
        resource: `${settings.origin}/mcp`,
        scopes: [
          'openid',
          'profile',
          'email',
          'offline_access',
          'easyeda.read',
          'easyeda.write',
          'easyeda.export',
          'easyeda.project_admin',
        ],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
  return {
    origin: settings.origin,
    options: provider.options,
    installGrantProtection() {
      // A SQLite trigger survives process restarts and catches Better Auth's
      // own consent deletion, not only our browser's Revoke button.
      settings.database.exec(`
        CREATE TABLE IF NOT EXISTS "cloudClientRevocation" (
          "userId" TEXT NOT NULL,
          "clientId" TEXT NOT NULL,
          "revokedAt" INTEGER NOT NULL,
          PRIMARY KEY ("userId", "clientId")
        );
        CREATE TRIGGER IF NOT EXISTS "cloudConsentRemoved"
        AFTER DELETE ON "oauthConsent"
        WHEN OLD."userId" IS NOT NULL
        BEGIN
          INSERT INTO "cloudClientRevocation" ("userId", "clientId", "revokedAt")
          VALUES (OLD."userId", OLD."clientId", CAST(strftime('%s', 'now') AS INTEGER))
          ON CONFLICT ("userId", "clientId") DO UPDATE
          SET "revokedAt" = MAX("revokedAt", excluded."revokedAt");
        END;
      `);
    },
    checkAccessGrant: (request) => hasActiveClientGrant(settings.database, request),
    handler: provider.handler,
    async getSessionUser(headers) {
      const result = await provider.api.getSession({ headers });
      return result?.user
        ? { id: result.user.id, name: result.user.name, email: result.user.email }
        : null;
    },
    async verifySignedQuery(query) {
      if (!query || query.length > 8192) return false;
      return verifyOAuthQueryParams(query, settings.secret);
    },
    async listClientConsents(headers) {
      const consents = await provider.api.getOAuthConsents({ headers });
      return Promise.all(
        consents.map(async (consent) => {
          let name = 'Unrecognized MCP client';
          try {
            const client = await provider.api.getOAuthClientPublic({
              query: { client_id: consent.clientId },
              headers,
            });
            if (client?.client_name) name = client.client_name;
          } catch {
            // An unavailable client must not prevent the owner from revoking its consent.
          }
          return { id: consent.id, clientId: consent.clientId, name, scopes: consent.scopes };
        }),
      );
    },
    async getClient(clientId, headers) {
      try {
        const client = await provider.api.getOAuthClientPublic({
          query: { client_id: clientId },
          headers,
        });
        if (!client) return null;
        return {
          name: client.client_name || client.client_id,
          redirectUri: client.redirect_uris?.[0],
        };
      } catch {
        return null;
      }
    },
  };
}

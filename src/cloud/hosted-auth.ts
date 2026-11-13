import type { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

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
export interface HostedAuth {
  readonly options: BetterAuthOptions;
  handler(request: Request): Promise<Response>;
}

export function createHostedAuth(settings: HostedAuthSettings): HostedAuth {
  validateHostedAuthSettings(settings);
  return betterAuth({
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
}

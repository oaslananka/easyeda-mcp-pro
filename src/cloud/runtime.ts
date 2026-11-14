import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import type { EnvConfig } from '../config/env.js';
import { createHostedAuth, type HostedAuth, type HostedAuthSettings } from './hosted-auth.js';

export interface HostedCloudSettings extends Omit<HostedAuthSettings, 'database'> {
  databasePath: string;
}

export interface HostedCloudRuntime {
  auth: HostedAuth;
  close: () => void;
}

const PRIVATE_CLOUD_KEYS = [
  'CLOUD_HOSTED_ORIGIN',
  'CLOUD_AUTH_SECRET',
  'CLOUD_GITHUB_CLIENT_ID',
  'CLOUD_GITHUB_CLIENT_SECRET',
  'CLOUD_GOOGLE_CLIENT_ID',
  'CLOUD_GOOGLE_CLIENT_SECRET',
] as const;

// Keep OAuth secret reads statically named, without growing validation complexity.
function privateCloudValues(env: Record<string, string | undefined>) {
  return {
    CLOUD_HOSTED_ORIGIN: env.CLOUD_HOSTED_ORIGIN?.trim() ?? '',
    CLOUD_AUTH_SECRET: env.CLOUD_AUTH_SECRET?.trim() ?? '',
    CLOUD_GITHUB_CLIENT_ID: env.CLOUD_GITHUB_CLIENT_ID?.trim() ?? '',
    CLOUD_GITHUB_CLIENT_SECRET: env.CLOUD_GITHUB_CLIENT_SECRET?.trim() ?? '',
    CLOUD_GOOGLE_CLIENT_ID: env.CLOUD_GOOGLE_CLIENT_ID?.trim() ?? '',
    CLOUD_GOOGLE_CLIENT_SECRET: env.CLOUD_GOOGLE_CLIENT_SECRET?.trim() ?? '',
  } satisfies Record<(typeof PRIVATE_CLOUD_KEYS)[number], string>;
}

function canonicalCloudOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return (
      url.origin === origin &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function hostedCloudEnabled(flag: string | undefined): boolean {
  const normalized = (flag ?? 'false').trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true' || normalized === '1') return true;
  throw new Error('Hosted Cloud requires CLOUD_HOSTED_ENABLED=true or false.');
}

function assertHostedTransport(config: EnvConfig): void {
  if (
    config.TRANSPORT !== 'http' ||
    config.MCP_BRIDGE_BACKEND !== 'remote_relay' ||
    !config.OAUTH_ENABLED ||
    config.HTTP_AUTH_DISABLED
  ) {
    throw new Error('Hosted Cloud requires authenticated HTTP remote_relay mode.');
  }
}

/**
 * Explicit hosted-only configuration. Provider credentials deliberately remain
 * outside the public MCP Registry environment metadata for Local-mode users.
 */
export function parseHostedCloudSettings(
  config: EnvConfig,
  env: Record<string, string | undefined>,
): HostedCloudSettings | undefined {
  if (!hostedCloudEnabled(env.CLOUD_HOSTED_ENABLED)) return undefined;
  assertHostedTransport(config);
  const values = privateCloudValues(env);
  const value = (key: (typeof PRIVATE_CLOUD_KEYS)[number]): string => values[key];
  for (const name of PRIVATE_CLOUD_KEYS) {
    if (!value(name)) {
      throw new Error(`Hosted Cloud requires configuration ${name}.`);
    }
  }
  const origin = value('CLOUD_HOSTED_ORIGIN');
  if (!canonicalCloudOrigin(origin)) {
    throw new Error('Hosted Cloud requires a canonical public HTTPS origin.');
  }
  if (value('CLOUD_AUTH_SECRET').length < 32) {
    throw new Error('Hosted Cloud requires a strong signing secret.');
  }
  if (
    config.OAUTH_ISSUER !== `${origin}/api/auth` ||
    config.OAUTH_AUDIENCE !== `${origin}/mcp` ||
    config.OAUTH_JWKS_URI !== `${origin}/api/auth/jwks`
  ) {
    throw new Error('Hosted Cloud OAuth issuer, audience or JWKS URL does not match the origin.');
  }
  return {
    origin,
    secret: value('CLOUD_AUTH_SECRET'),
    databasePath: join(config.DATA_DIR, 'hosted-cloud.sqlite'),
    github: {
      clientId: value('CLOUD_GITHUB_CLIENT_ID'),
      clientSecret: value('CLOUD_GITHUB_CLIENT_SECRET'),
    },
    google: {
      clientId: value('CLOUD_GOOGLE_CLIENT_ID'),
      clientSecret: value('CLOUD_GOOGLE_CLIENT_SECRET'),
    },
  };
}

/** Initializes the hosted provider only after the opt-in checks, and never on Local. */
export async function createHostedCloudRuntime(
  config: EnvConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<HostedCloudRuntime | undefined> {
  const settings = parseHostedCloudSettings(config, env);
  if (!settings) return undefined;

  await mkdir(dirname(settings.databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(settings.databasePath);
  try {
    const auth = createHostedAuth({ ...settings, database });
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    auth.installGrantProtection();
    return { auth, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

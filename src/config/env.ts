import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const DEFAULT_DATA_DIR = join(homedir(), '.easyeda-mcp-pro');
const DEFAULT_SQLITE_PATH = join(DEFAULT_DATA_DIR, 'easyeda-mcp-pro.sqlite');
const DEFAULT_ARTIFACT_DIR = join(DEFAULT_DATA_DIR, 'artifacts');
const DEFAULT_CACHE_DIR = join(DEFAULT_DATA_DIR, 'cache');

const STRICT_BOOLEAN_MESSAGE = 'Invalid boolean literal. Expected one of: true, false, 1, or 0.';

function envBoolean() {
  return z.union([z.boolean(), z.string()]).transform((value, ctx) => {
    if (typeof value === 'boolean') return value;

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;

    ctx.addIssue({ code: 'custom', message: STRICT_BOOLEAN_MESSAGE });
    return z.NEVER;
  });
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  TOOL_PROFILE: z.enum(['core', 'pro', 'full', 'dev', 'experimental']).default('core'),
  TOOL_SCOPES: z.string().default(''),
  MCP_PROTOCOL_VERSION: z.string().default('2025-11-25'),
  MCP_BRIDGE_BACKEND: z.enum(['local_bridge', 'remote_relay']).default('local_bridge'),
  MCP_REMOTE_SESSION_ID: z.string().default(''),

  TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_AUTH_DISABLED: envBoolean().default(false),
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(100),
  CORS_ORIGIN: z.string().default(''),
  ALLOWED_ORIGINS: z.string().default(''),

  MCP_TASKS_ENABLED: envBoolean().default(false),
  MCP_APPS_ENABLED: envBoolean().default(false),
  MCP_V2_EXPERIMENTAL: envBoolean().default(false),
  MCP_RAW_EXEC_EXPERIMENTAL: envBoolean().default(false),

  BRIDGE_HOST: z.string().default('127.0.0.1'),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(49620),
  BRIDGE_PORT_SCAN: z.string().default('49620-49629'),
  BRIDGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  BRIDGE_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  BRIDGE_RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(100).default(0),
  BRIDGE_WAIT_FOR_EDA_MS: z.coerce.number().int().min(0).max(60000).default(30000),
  BRIDGE_MAX_PAYLOAD_SIZE: z.coerce.number().int().min(1024).max(10485760).default(1048576),
  BRIDGE_TOKEN: z.string().default(''),
  EASYEDA_DEV_BRIDGE: envBoolean().default(false),
  BRIDGE_RAW_EXEC_ENABLED: envBoolean().default(false),
  // Dev-only dispatcher hot swap: push a freshly built extension dispatcher
  // bundle over the bridge without re-importing the .eext. Remote code
  // execution by design — refused in production, mirrors BRIDGE_RAW_EXEC_ENABLED.
  BRIDGE_HOT_SWAP_ENABLED: envBoolean().default(false),
  // Path to the dispatcher bundle to watch/push (easyeda-bridge-extension/dist/dispatcher.js).
  BRIDGE_HOT_SWAP_WATCH: z.string().default(''),
  BRIDGE_HOT_SWAP_CHUNK_BYTES: z.coerce.number().int().min(4096).max(1048576).default(65536),

  DATA_DIR: z.string().default(DEFAULT_DATA_DIR),
  SQLITE_PATH: z.string().default(DEFAULT_SQLITE_PATH),
  ARTIFACT_DIR: z.string().default(DEFAULT_ARTIFACT_DIR),
  CACHE_DIR: z.string().default(DEFAULT_CACHE_DIR),

  AI_PROVIDER: z.enum(['none', 'anthropic', 'openai', 'openrouter', 'local']).default('none'),
  AI_MODEL: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_MAX_TOKENS: z.coerce.number().int().min(1).max(128000).default(8000),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  AI_ALLOW_DESIGN_MUTATIONS: envBoolean().default(false),

  JLCPCB_MODE: z.enum(['disabled', 'mock', 'approved_api']).default('disabled'),
  JLCPCB_CLIENT_ID: z.string().default(''),
  JLCPCB_CLIENT_SECRET: z.string().default(''),
  JLCPCB_API_BASE_URL: z.string().default('https://api.jlcpcb.com'),
  JLCPCB_ENABLE_ORDERING: envBoolean().default(false),
  JLCPCB_DEFAULT_CURRENCY: z.enum(['USD', 'CNY']).default('USD'),

  JLCSEARCH_ENABLED: envBoolean().default(true),
  JLCSEARCH_BASE_URL: z.string().default('https://jlcsearch.tscircuit.com'),
  LCSC_API_KEY: z.string().default(''),
  LCSC_API_SECRET: z.string().default(''),

  KEYLESS_SOURCING_ENABLED: envBoolean().default(true),
  SOURCING_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(604800).default(21600),
  VENDOR_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(10000).default(150),

  MOUSER_ENABLED: envBoolean().default(false),
  MOUSER_API_KEY: z.string().default(''),
  MOUSER_API_BASE_URL: z.string().default('https://api.mouser.com'),

  DIGIKEY_ENABLED: envBoolean().default(false),
  DIGIKEY_CLIENT_ID: z.string().default(''),
  DIGIKEY_CLIENT_SECRET: z.string().default(''),
  DIGIKEY_SANDBOX: envBoolean().default(true),
  DIGIKEY_LOCALE: z.string().default('en-US'),
  DIGIKEY_CURRENCY: z.string().default('USD'),

  OAUTH_ENABLED: envBoolean().default(false),
  OAUTH_ISSUER: z.string().default(''),
  OAUTH_AUDIENCE: z.string().default('easyeda-mcp-pro'),
  OAUTH_JWKS_URI: z.string().default(''),
  OAUTH_REQUIRED_SCOPES: z.string().default('easyeda:read'),

  OTEL_ENABLED: envBoolean().default(false),
  OTEL_SERVICE_NAME: z.string().default('easyeda-mcp-pro'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

const PROJECT_VAR_PREFIXES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'TOOL_PROFILE',
  'TOOL_',
  'MCP_PROTOCOL_VERSION',
  'TRANSPORT',
  'HTTP_',
  'CORS_',
  'MCP_',
  'BRIDGE_',
  'EASYEDA_',
  'DATA_DIR',
  'SQLITE_',
  'ARTIFACT_',
  'CACHE_',
  'AI_',
  'JLCPCB_',
  'JLCSEARCH_',
  'LCSC_',
  'KEYLESS_',
  'SOURCING_',
  'VENDOR_',
  'MOUSER_',
  'DIGIKEY_',
  'OAUTH_',
  'OTEL_',
  'TRACE_',
];

export function detectUnknownEnvVars(env: Record<string, string | undefined>): string[] {
  const knownKeys = new Set(Object.keys(EnvSchema.shape));
  const warnings: string[] = [];
  for (const key of Object.keys(env)) {
    if (knownKeys.has(key)) continue;
    const isProjectVar = PROJECT_VAR_PREFIXES.some(
      (prefix) => key === prefix || key.startsWith(prefix),
    );
    if (!isProjectVar) continue;
    const msg =
      `Unknown environment variable "${key}" is not recognized by this server. ` +
      'Check for typos or remove if unused.';
    // Logger not yet initialized — env config is loaded first
    console.warn('WARNING:', msg);
    warnings.push(msg);
  }
  return warnings;
}

export function loadEnvConfig(): EnvConfig {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // Logger not yet initialized — env config is loaded first
    console.error('Config validation failed:');
    for (const issue of result.error.issues) {
      // Logger not yet initialized — env config is loaded first
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  detectUnknownEnvVars(process.env);
  validateSafeConfig(result.data);
  return result.data;
}

/** Check whether a host refers to a loopback address. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function getBridgePairingConfigIssue(config: EnvConfig): string | undefined {
  if (isLoopbackHost(config.BRIDGE_HOST) || config.BRIDGE_TOKEN) return undefined;
  return (
    'SAFETY: BRIDGE_HOST is not a loopback address but BRIDGE_TOKEN is empty. ' +
    'Non-loopback bridge listeners require a pairing token. ' +
    'Set BRIDGE_TOKEN to a strong secret or use BRIDGE_HOST=127.0.0.1 for local operation.'
  );
}

export function validateSafeConfig(config: EnvConfig): void {
  // ── Bridge pairing policy ────────────────────────────────
  const bridgePairingIssue = getBridgePairingConfigIssue(config);
  if (bridgePairingIssue) {
    console.error(bridgePairingIssue);
    process.exit(1);
  }

  // ── CORS / origin policy ─────────────────────────────────
  if (config.TRANSPORT === 'http' && !isLoopbackHost(config.HTTP_HOST) && !config.ALLOWED_ORIGINS) {
    // Logger not yet initialized — env config is loaded first
    console.error(
      'SAFETY: HTTP_HOST is not a loopback address but ALLOWED_ORIGINS is empty. ' +
        'Non-loopback HTTP deployments must declare an explicit origin allowlist. ' +
        'Set ALLOWED_ORIGINS to a comma-separated list of allowed origins or use HTTP_HOST=127.0.0.1.',
    );
    process.exit(1);
  }

  // ── HTTP auth bypass policy ───────────────────────────────
  if (config.TRANSPORT === 'http' && config.HTTP_AUTH_DISABLED) {
    if (config.NODE_ENV === 'production' || !isLoopbackHost(config.HTTP_HOST)) {
      console.error(
        'SAFETY: HTTP_AUTH_DISABLED=true is only allowed for non-production loopback HTTP. ' +
          'Use OAUTH_ENABLED=true for remote or production HTTP deployments.',
      );
      process.exit(1);
    }
  }

  // ── OAuth/JWKS validation ─────────────────────────────────
  if (config.OAUTH_ENABLED && !isLoopbackHost(config.HTTP_HOST)) {
    const missing: string[] = [];
    if (!config.OAUTH_JWKS_URI) missing.push('OAUTH_JWKS_URI');
    if (!config.OAUTH_ISSUER) missing.push('OAUTH_ISSUER');
    if (!config.OAUTH_AUDIENCE) missing.push('OAUTH_AUDIENCE');
    if (missing.length > 0) {
      // Logger not yet initialized — env config is loaded first
      console.error(
        `SAFETY: OAuth is enabled for non-loopback HTTP but required variables are missing: ${missing.join(', ')}. ` +
          'Set all required OAuth variables or use HTTP_HOST=127.0.0.1 for local development.',
      );
      process.exit(1);
    }
  }

  // No weak-token fallback: if OAuth is enabled, JWKS must be configured
  if (config.OAUTH_ENABLED && !config.OAUTH_JWKS_URI) {
    // Logger not yet initialized — env config is loaded first
    console.error(
      'SAFETY: OAUTH_ENABLED=true requires OAUTH_JWKS_URI. ' +
        'The weak bearer-token fallback (no JWKS) is no longer supported. ' +
        'Configure a valid JWKS endpoint or disable OAuth.',
    );
    process.exit(1);
  }

  // ── NODE_ENV production checks ──────────────────────────
  if (config.NODE_ENV === 'production') {
    if (!isLoopbackHost(config.HTTP_HOST) && !config.OAUTH_ENABLED) {
      // Logger not yet initialized — env config is loaded first
      console.error(
        'SAFETY: HTTP_HOST is not localhost but OAUTH_ENABLED is false. ' +
          'Set OAUTH_ENABLED=true or use HTTP_HOST=127.0.0.1.',
      );
      process.exit(1);
    }
    if (config.BRIDGE_RAW_EXEC_ENABLED) {
      // Logger not yet initialized — env config is loaded first
      console.error('SAFETY: BRIDGE_RAW_EXEC_ENABLED=true is not allowed in production mode.');
      process.exit(1);
    }
    if (config.BRIDGE_HOT_SWAP_ENABLED) {
      // Logger not yet initialized — env config is loaded first
      console.error('SAFETY: BRIDGE_HOT_SWAP_ENABLED=true is not allowed in production mode.');
      process.exit(1);
    }
    if (config.JLCPCB_ENABLE_ORDERING && config.JLCPCB_MODE !== 'approved_api') {
      // Logger not yet initialized — env config is loaded first
      console.error('SAFETY: JLCPCB_ENABLE_ORDERING=true requires JLCPCB_MODE=approved_api.');
      process.exit(1);
    }
  }
}

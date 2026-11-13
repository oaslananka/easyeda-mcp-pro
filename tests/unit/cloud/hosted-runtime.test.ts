import { describe, expect, it } from 'vitest';
import { EnvSchema, detectUnknownEnvVars } from '../../../src/config/env.js';
import { parseHostedCloudSettings } from '../../../src/cloud/runtime.js';

const origin = 'https://easyeda-mcp-pro.oaslananka.dev';
const credentials = {
  CLOUD_HOSTED_ENABLED: 'true',
  CLOUD_HOSTED_ORIGIN: origin,
  CLOUD_AUTH_SECRET: 'test-signing-secret-test-signing-secret-test-signing-secret',
  CLOUD_GITHUB_CLIENT_ID: 'github-client',
  CLOUD_GITHUB_CLIENT_SECRET: 'github-secret',
  CLOUD_GOOGLE_CLIENT_ID: 'google-client',
  CLOUD_GOOGLE_CLIENT_SECRET: 'google-secret',
};
const baseConfig = EnvSchema.parse({
  NODE_ENV: 'test',
  TRANSPORT: 'http',
  HTTP_HOST: '127.0.0.1',
  MCP_BRIDGE_BACKEND: 'remote_relay',
  OAUTH_ENABLED: true,
  OAUTH_ISSUER: `${origin}/api/auth`,
  OAUTH_AUDIENCE: `${origin}/mcp`,
  OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
});

describe('Hosted Cloud runtime configuration', () => {
  it('does not enable a Cloud identity provider for the normal local no-account flow', () => {
    expect(parseHostedCloudSettings(EnvSchema.parse({}), {})).toBeUndefined();
    expect(parseHostedCloudSettings(baseConfig, { CLOUD_HOSTED_ENABLED: 'false' })).toBeUndefined();
  });

  it('requires canonical auth endpoints and explicit remote HTTP + OAuth configuration', () => {
    const settings = parseHostedCloudSettings(baseConfig, credentials);
    expect(settings).toMatchObject({
      origin,
      github: { clientId: 'github-client' },
      google: { clientId: 'google-client' },
    });
    expect(settings?.databasePath).toMatch(/hosted-cloud\.sqlite$/);

    for (const [label, config] of [
      ['local backend', { ...baseConfig, MCP_BRIDGE_BACKEND: 'local_bridge' }],
      ['stdio transport', { ...baseConfig, TRANSPORT: 'stdio' }],
      ['no OAuth', { ...baseConfig, OAUTH_ENABLED: false }],
      ['authentication bypass', { ...baseConfig, HTTP_AUTH_DISABLED: true }],
      ['wrong issuer', { ...baseConfig, OAUTH_ISSUER: 'https://other.example/api/auth' }],
      ['wrong audience', { ...baseConfig, OAUTH_AUDIENCE: 'https://other.example/mcp' }],
      ['wrong JWKS', { ...baseConfig, OAUTH_JWKS_URI: 'https://other.example/jwks' }],
    ] as const) {
      expect(
        () => parseHostedCloudSettings(config as typeof baseConfig, credentials),
        label,
      ).toThrow(/Hosted Cloud/);
    }
  });

  it('rejects missing credentials or invalid flag without creating an anonymous provider', () => {
    for (const [label, candidate] of [
      ['invalid flag', { ...credentials, CLOUD_HOSTED_ENABLED: 'maybe' }],
      ['insecure origin', { ...credentials, CLOUD_HOSTED_ORIGIN: 'http://public.example' }],
      ['missing secret', { ...credentials, CLOUD_AUTH_SECRET: '' }],
      ['no GitHub', { ...credentials, CLOUD_GITHUB_CLIENT_ID: '' }],
      ['no Google', { ...credentials, CLOUD_GOOGLE_CLIENT_SECRET: '' }],
    ] as const) {
      expect(() => parseHostedCloudSettings(baseConfig, candidate), label).toThrow(/Hosted Cloud/);
    }
  });

  it('recognizes private deployment environment keys without exposing them in server.json', () => {
    expect(detectUnknownEnvVars(credentials)).toEqual([]);
    expect(detectUnknownEnvVars({ CLOUD_HOSTED_ENABELD: 'true' })).toHaveLength(1);
  });
});

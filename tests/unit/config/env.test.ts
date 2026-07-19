import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnvSchema, detectUnknownEnvVars, validateSafeConfig } from '../../../src/config/env.js';

describe('EnvSchema', () => {
  it('should use defaults for empty input', () => {
    const result = EnvSchema.parse({});
    expect(result.NODE_ENV).toBe('development');
    expect(result.TOOL_PROFILE).toBe('core');
    expect(result.TOOL_SCOPES).toBe('');
    expect(result.TRANSPORT).toBe('stdio');
    expect(result.BRIDGE_HOST).toBe('127.0.0.1');
    expect(result.BRIDGE_PORT).toBe(49620);
    expect(result.JLCPCB_MODE).toBe('disabled');
    expect(result.JLCPCB_ENABLE_ORDERING).toBe(false);
    expect(result.AI_PROVIDER).toBe('none');
  });

  it('should anchor default writable paths in the user home directory', () => {
    const result = EnvSchema.parse({});
    const dataDir = join(homedir(), '.easyeda-mcp-pro');

    expect(result.DATA_DIR).toBe(dataDir);
    expect(result.SQLITE_PATH).toBe(join(dataDir, 'easyeda-mcp-pro.sqlite'));
    expect(result.ARTIFACT_DIR).toBe(join(dataDir, 'artifacts'));
    expect(result.CACHE_DIR).toBe(join(dataDir, 'cache'));
    for (const path of [
      result.DATA_DIR,
      result.SQLITE_PATH,
      result.ARTIFACT_DIR,
      result.CACHE_DIR,
    ]) {
      expect(isAbsolute(path)).toBe(true);
    }
  });

  it('should preserve explicitly configured relative paths', () => {
    const result = EnvSchema.parse({
      DATA_DIR: './custom-data',
      SQLITE_PATH: './custom-data/database.sqlite',
      ARTIFACT_DIR: './custom-artifacts',
      CACHE_DIR: './custom-cache',
    });

    expect(result.DATA_DIR).toBe('./custom-data');
    expect(result.SQLITE_PATH).toBe('./custom-data/database.sqlite');
    expect(result.ARTIFACT_DIR).toBe('./custom-artifacts');
    expect(result.CACHE_DIR).toBe('./custom-cache');
  });

  it('should parse production config', () => {
    const result = EnvSchema.parse({
      NODE_ENV: 'production',
      TOOL_PROFILE: 'pro',
      TRANSPORT: 'http',
    });
    expect(result.NODE_ENV).toBe('production');
    expect(result.TOOL_PROFILE).toBe('pro');
    expect(result.TRANSPORT).toBe('http');
  });

  it('should parse boolean flags from string values', () => {
    const result = EnvSchema.parse({
      MCP_TASKS_ENABLED: 'true',
      MCP_APPS_ENABLED: 'true',
      JLCSEARCH_ENABLED: 'false',
    });
    expect(result.MCP_TASKS_ENABLED).toBe(true);
    expect(result.MCP_APPS_ENABLED).toBe(true);
    expect(EnvSchema.parse({}).MCP_RAW_EXEC_EXPERIMENTAL).toBe(false);
    expect(result.JLCSEARCH_ENABLED).toBe(false);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['  true  ', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['  false  ', false],
    ['0', false],
  ] as const)('should parse strict boolean literal %j as %s', (literal, expected) => {
    expect(EnvSchema.parse({ MCP_TASKS_ENABLED: literal }).MCP_TASKS_ENABLED).toBe(expected);
  });

  it('should preserve native boolean values and defaults', () => {
    expect(EnvSchema.parse({ MCP_TASKS_ENABLED: true }).MCP_TASKS_ENABLED).toBe(true);
    expect(EnvSchema.parse({ MCP_TASKS_ENABLED: false }).MCP_TASKS_ENABLED).toBe(false);
    expect(EnvSchema.parse({}).MCP_TASKS_ENABLED).toBe(false);
    expect(EnvSchema.parse({}).JLCSEARCH_ENABLED).toBe(true);
  });

  it.each([
    ['HTTP_AUTH_DISABLED', 'off'],
    ['BRIDGE_RAW_EXEC_ENABLED', 'flase'],
    ['MCP_RAW_EXEC_EXPERIMENTAL', 'no'],
    ['BRIDGE_HOT_SWAP_ENABLED', 'yes'],
    ['AI_ALLOW_DESIGN_MUTATIONS', 'disabled'],
    ['JLCPCB_ENABLE_ORDERING', 'arbitrary'],
    ['OAUTH_ENABLED', 'on'],
  ] as const)('should reject invalid security boolean %s=%j', (key, literal) => {
    const result = EnvSchema.safeParse({ [key]: literal });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [key],
            message: expect.stringContaining('true, false, 1, or 0'),
          }),
        ]),
      );
    }
  });

  it('should apply strict literal validation to every boolean environment field', () => {
    const booleanKeys = Object.entries(EnvSchema.parse({}))
      .filter(([, value]) => typeof value === 'boolean')
      .map(([key]) => key);

    expect(booleanKeys).toEqual([
      'HTTP_AUTH_DISABLED',
      'MCP_TASKS_ENABLED',
      'MCP_APPS_ENABLED',
      'MCP_V2_EXPERIMENTAL',
      'MCP_RAW_EXEC_EXPERIMENTAL',
      'EASYEDA_DEV_BRIDGE',
      'BRIDGE_RAW_EXEC_ENABLED',
      'BRIDGE_HOT_SWAP_ENABLED',
      'AI_ALLOW_DESIGN_MUTATIONS',
      'JLCPCB_ENABLE_ORDERING',
      'JLCSEARCH_ENABLED',
      'KEYLESS_SOURCING_ENABLED',
      'MOUSER_ENABLED',
      'DIGIKEY_ENABLED',
      'DIGIKEY_SANDBOX',
      'OAUTH_ENABLED',
      'OTEL_ENABLED',
    ]);

    for (const key of booleanKeys) {
      const result = EnvSchema.safeParse({ [key]: 'invalid-boolean' });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path[0] === key),
          key,
        ).toBe(true);
      }
    }
  });

  it('should coerce numeric strings', () => {
    const result = EnvSchema.parse({
      BRIDGE_PORT: '8080',
      BRIDGE_TIMEOUT_MS: '30000',
    });
    expect(result.BRIDGE_PORT).toBe(8080);
    expect(result.BRIDGE_TIMEOUT_MS).toBe(30000);
  });

  it('should reject invalid profile', () => {
    expect(() => EnvSchema.parse({ TOOL_PROFILE: 'invalid' })).toThrow();
  });

  it('should reject invalid transport', () => {
    expect(() => EnvSchema.parse({ TRANSPORT: 'grpc' })).toThrow();
  });

  it('should have default HTTP_RATE_LIMIT_MAX', () => {
    const result = EnvSchema.parse({});
    expect(result.HTTP_RATE_LIMIT_MAX).toBe(100);
  });

  it('should parse HTTP_RATE_LIMIT_MAX from string', () => {
    const result = EnvSchema.parse({ HTTP_RATE_LIMIT_MAX: '200' });
    expect(result.HTTP_RATE_LIMIT_MAX).toBe(200);
  });

  it('should reject HTTP_RATE_LIMIT_MAX below 1', () => {
    expect(() => EnvSchema.parse({ HTTP_RATE_LIMIT_MAX: 0 })).toThrow();
  });

  it('should reject HTTP_RATE_LIMIT_MAX above 10000', () => {
    expect(() => EnvSchema.parse({ HTTP_RATE_LIMIT_MAX: 99999 })).toThrow();
  });

  it('should have empty ALLOWED_ORIGINS by default', () => {
    const result = EnvSchema.parse({});
    expect(result.ALLOWED_ORIGINS).toBe('');
  });

  it('should parse ALLOWED_ORIGINS as string', () => {
    const result = EnvSchema.parse({
      ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
    });
    expect(result.ALLOWED_ORIGINS).toBe('https://app.example.com,https://admin.example.com');
  });
});

describe('validateSafeConfig', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject non-loopback HTTP without ALLOWED_ORIGINS', () => {
    const config = EnvSchema.parse({
      TRANSPORT: 'http',
      HTTP_HOST: '0.0.0.0',
      ALLOWED_ORIGINS: '',
    });

    validateSafeConfig(config);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_ORIGINS is empty'));
  });

  it('should allow non-loopback HTTP with OAuth and an explicit origin allowlist', () => {
    const config = EnvSchema.parse({
      TRANSPORT: 'http',
      HTTP_HOST: '0.0.0.0',
      ALLOWED_ORIGINS: 'https://app.example.com',
      OAUTH_ENABLED: true,
      OAUTH_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
      OAUTH_ISSUER: 'https://auth.example.com',
      OAUTH_AUDIENCE: 'easyeda-mcp-pro',
    });

    validateSafeConfig(config);

    expect(process.exit).not.toHaveBeenCalled();
  });

  it('should allow loopback HTTP without ALLOWED_ORIGINS', () => {
    const config = EnvSchema.parse({
      TRANSPORT: 'http',
      HTTP_HOST: '127.0.0.1',
      ALLOWED_ORIGINS: '',
    });

    validateSafeConfig(config);

    expect(process.exit).not.toHaveBeenCalled();
  });

  it('should allow stdio transport without ALLOWED_ORIGINS', () => {
    const config = EnvSchema.parse({
      TRANSPORT: 'stdio',
      HTTP_HOST: '0.0.0.0',
      ALLOWED_ORIGINS: '',
    });

    validateSafeConfig(config);

    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe('detectUnknownEnvVars', () => {
  it('should not warn on known env vars', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectUnknownEnvVars({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      TOOL_PROFILE: 'core',
      BRIDGE_HOST: '127.0.0.1',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });

  it('should warn on unknown project-prefixed env var', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectUnknownEnvVars({
      BRIDGE_MADEUP_KEY: 'something',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('WARNING:', expect.stringContaining('BRIDGE_MADEUP_KEY'));
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('BRIDGE_MADEUP_KEY');
    warnSpy.mockRestore();
  });

  it('should warn on unknown MCP_ prefixed env var', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectUnknownEnvVars({
      MCP_UNKNOWN_FEATURE: 'true',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('MCP_UNKNOWN_FEATURE');
    warnSpy.mockRestore();
  });

  it('should not warn on unrelated system env vars', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectUnknownEnvVars({
      PATH: '/usr/bin',
      HOME: '/home/user',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      npm_package_name: 'test',
      PNPM_HOME: '/pnpm',
      USERNAME: 'user',
      OS: 'Windows_NT',
      SHELL: 'pwsh',
      _: '/usr/bin/node',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });

  it('should combine known, system, and unknown vars correctly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectUnknownEnvVars({
      NODE_ENV: 'development',
      PATH: '/usr/bin',
      BRIDGE_HOST: '127.0.0.1',
      HTTP_TYPO_MISTAKE: 'true',
      OAUTH_MISSING_CONFIG: '',
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('HTTP_TYPO_MISTAKE');
    expect(result[1]).toContain('OAUTH_MISSING_CONFIG');
    warnSpy.mockRestore();
  });
});

describe('validateSafeConfig', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const baseConfig = {
    NODE_ENV: 'test' as const,
    TRANSPORT: 'http' as const,
    HTTP_HOST: '127.0.0.1',
    ALLOWED_ORIGINS: '',
    OAUTH_ENABLED: false,
    HTTP_AUTH_DISABLED: false,
    OAUTH_JWKS_URI: '',
    OAUTH_ISSUER: '',
    OAUTH_AUDIENCE: 'easyeda-mcp-pro',
    HTTP_PORT: 3000,
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_TOKEN: '',
    BRIDGE_RAW_EXEC_ENABLED: false,
    JLCPCB_ENABLE_ORDERING: false,
    JLCPCB_MODE: 'disabled' as const,
  } as const;

  it('should pass when OAuth is disabled', () => {
    expect(() => validateSafeConfig({ ...baseConfig, OAUTH_ENABLED: false })).not.toThrow();
  });

  it('should reject HTTP_AUTH_DISABLED in production even on loopback', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        NODE_ENV: 'production',
        HTTP_AUTH_DISABLED: true,
      }),
    ).toThrow('process.exit called');
  });

  it('should reject HTTP_AUTH_DISABLED on non-loopback HTTP', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        HTTP_AUTH_DISABLED: true,
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: 'https://example.com',
      }),
    ).toThrow('process.exit called');
  });

  it('should reject OAUTH_ENABLED without OAUTH_JWKS_URI', () => {
    expect(() =>
      validateSafeConfig({ ...baseConfig, OAUTH_ENABLED: true, OAUTH_JWKS_URI: '' }),
    ).toThrow('process.exit called');
  });

  it('should reject non-loopback OAUTH_ENABLED without OAUTH_ISSUER', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        OAUTH_ENABLED: true,
        OAUTH_JWKS_URI: 'https://example.com/jwks',
        OAUTH_ISSUER: '',
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow('process.exit called');
  });

  it('should reject non-loopback OAUTH_ENABLED without OAUTH_AUDIENCE', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        OAUTH_ENABLED: true,
        OAUTH_JWKS_URI: 'https://example.com/jwks',
        OAUTH_ISSUER: 'https://example.com',
        OAUTH_AUDIENCE: '',
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow('process.exit called');
  });

  it('should pass when OAUTH_ENABLED with all required vars on loopback', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        OAUTH_ENABLED: true,
        OAUTH_JWKS_URI: 'https://example.com/jwks',
        OAUTH_ISSUER: 'https://example.com',
        OAUTH_AUDIENCE: 'easyeda-mcp-pro',
        HTTP_HOST: '127.0.0.1',
      }),
    ).not.toThrow();
  });

  it('should pass when OAUTH_ENABLED with all required vars on non-loopback', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        OAUTH_ENABLED: true,
        OAUTH_JWKS_URI: 'https://example.com/jwks',
        OAUTH_ISSUER: 'https://example.com',
        OAUTH_AUDIENCE: 'my-app',
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: 'https://example.com',
      }),
    ).not.toThrow();
  });

  it('should reject a non-loopback bridge without a pairing token', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        BRIDGE_HOST: '0.0.0.0',
        BRIDGE_TOKEN: '',
      }),
    ).toThrow('process.exit called');
  });

  it.each(['127.0.0.1', 'localhost', '::1'])(
    'should allow loopback bridge host %s without a pairing token',
    (bridgeHost) => {
      expect(() =>
        validateSafeConfig({
          ...baseConfig,
          BRIDGE_HOST: bridgeHost,
          BRIDGE_TOKEN: '',
        }),
      ).not.toThrow();
    },
  );

  it('should allow a non-loopback bridge when a pairing token is configured', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        BRIDGE_HOST: '0.0.0.0',
        BRIDGE_TOKEN: 'test-pairing-secret',
      }),
    ).not.toThrow();
  });

  it('should reject BRIDGE_RAW_EXEC_ENABLED in production', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        NODE_ENV: 'production',
        BRIDGE_RAW_EXEC_ENABLED: true,
      }),
    ).toThrow('process.exit called');
  });

  it.each(['development', 'test', 'production'] as const)(
    'should reject non-loopback HTTP without OAuth in %s mode',
    (nodeEnv) => {
      expect(() =>
        validateSafeConfig({
          ...baseConfig,
          NODE_ENV: nodeEnv,
          OAUTH_ENABLED: false,
          HTTP_HOST: '0.0.0.0',
          ALLOWED_ORIGINS: 'https://app.example.com',
        }),
      ).toThrow('process.exit called');
    },
  );

  it('should reject a wildcard origin on non-loopback HTTP', () => {
    expect(() =>
      validateSafeConfig({
        ...baseConfig,
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: '*',
        OAUTH_ENABLED: true,
        OAUTH_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
        OAUTH_ISSUER: 'https://auth.example.com',
        OAUTH_AUDIENCE: 'easyeda-mcp-pro',
      }),
    ).toThrow('process.exit called');
  });

  it.each(['development', 'test'] as const)(
    'should allow loopback HTTP without OAuth in %s mode',
    (nodeEnv) => {
      expect(() =>
        validateSafeConfig({
          ...baseConfig,
          NODE_ENV: nodeEnv,
          HTTP_HOST: '127.0.0.1',
          OAUTH_ENABLED: false,
        }),
      ).not.toThrow();
    },
  );
});

describe('loadFeatureFlags', () => {
  it('maps environment config into feature flag booleans', async () => {
    const { loadFeatureFlags } = await import('../../../src/config/feature-flags.js');
    const config = EnvSchema.parse({
      MCP_TASKS_ENABLED: 'true',
      MCP_APPS_ENABLED: 'true',
      MCP_V2_EXPERIMENTAL: 'true',
      JLCPCB_ENABLE_ORDERING: 'true',
      JLCSEARCH_ENABLED: 'true',
      MOUSER_ENABLED: 'true',
      DIGIKEY_ENABLED: 'true',
      OAUTH_ENABLED: 'true',
      OTEL_ENABLED: 'true',
      AI_PROVIDER: 'openai',
      EASYEDA_DEV_BRIDGE: 'true',
      BRIDGE_RAW_EXEC_ENABLED: 'true',
      MCP_RAW_EXEC_EXPERIMENTAL: 'true',
    });

    expect(loadFeatureFlags(config)).toEqual({
      mcpTasksEnabled: true,
      mcpAppsEnabled: true,
      mcpV2Experimental: true,
      jlcpcbOrderingEnabled: true,
      jlcsearchEnabled: true,
      mouserEnabled: true,
      digikeyEnabled: true,
      oauthEnabled: true,
      otelEnabled: true,
      aiEnabled: true,
      devBridge: true,
      bridgeRawExecEnabled: true,
      rawExecExperimental: true,
    });
  });

  it('keeps ai disabled when the provider is none', async () => {
    const { loadFeatureFlags } = await import('../../../src/config/feature-flags.js');
    const config = EnvSchema.parse({ AI_PROVIDER: 'none' });

    expect(loadFeatureFlags(config).aiEnabled).toBe(false);
  });
});

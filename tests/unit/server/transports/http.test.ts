import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EnvSchema } from '../../../../src/config/env.js';
import { SERVER_VERSION } from '../../../../src/config/version.js';
import {
  createHttpTransport,
  createOriginValidator,
  handleCorsPreflight,
  isLoopback,
  parseOriginAllowlist,
  validateMcpProtocolVersion,
} from '../../../../src/server/transports/http.js';
import type { Request, Response, NextFunction } from 'express';
import * as http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

/** Create mock Express req/res/next for middleware unit tests. */
function mockReqRes(overrides: Partial<Request> = {}): {
  req: Request;
  res: Response;
  next: NextFunction;
} {
  const headers: Record<string, string | string[] | undefined> = {};
  const { headers: overrideHeaders, ...restOverrides } = overrides;
  const req = {
    method: 'GET',
    ...restOverrides,
    headers: { ...headers, ...(overrideHeaders || {}) },
  } as Request;

  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    status,
    json,
    setHeader,
    end,
    headersSent: false,
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

function createTestConfig(overrides: Record<string, unknown> = {}) {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    TRANSPORT: 'http',
    HTTP_PORT: 3001,
    ...overrides,
  });
}

// ── OAuth / JWKS test infrastructure ──────────────────────
interface OAuthTestContext {
  jwksUrl: string;
  jwksServer: http.Server;
  privateKey: CryptoKey;
  /** Sign a test JWT with specific claims */
  signToken: (opts: {
    issuer?: string;
    audience?: string;
    exp?: string;
    nbf?: string;
    sub?: string;
    typ?: string;
    alg?: string;
    scope?: string;
    scp?: string[];
    permissions?: string[];
  }) => Promise<string>;
}

async function createOAuthContext(): Promise<OAuthTestContext> {
  // Generate a fresh RSA key pair for each test suite
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jwksBody = JSON.stringify({ keys: [publicJwk] });

  // Start a minimal JWKS endpoint
  const jwksServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(jwksBody);
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const addr = jwksServer.address() as { port: number };
  const jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;

  const signToken = async ({
    issuer = 'https://auth.example.com',
    audience = 'test-audience',
    exp = '2h',
    nbf,
    sub = 'test-user',
    typ = 'JWT',
    alg = 'RS256',
    scope = 'easyeda:read',
    scp,
    permissions,
  }) => {
    const payload: Record<string, unknown> = { sub, scope };
    if (scp !== undefined) payload.scp = scp;
    if (permissions !== undefined) payload.permissions = permissions;

    const signer = new SignJWT(payload)
      .setProtectedHeader({ alg, typ })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(exp)
      .setIssuedAt();

    if (nbf !== undefined) {
      signer.setNotBefore(nbf);
    }

    return await signer.sign(privateKey);
  };

  return { jwksUrl, jwksServer, privateKey, signToken };
}

async function destroyOAuthContext(ctx: OAuthTestContext): Promise<void> {
  await new Promise<void>((resolve) => ctx.jwksServer.close(() => resolve()));
}

describe('createHttpTransport', () => {
  it('should return transport instance with required methods', () => {
    const config = createTestConfig();
    const transport = createHttpTransport(config);

    expect(transport).toHaveProperty('app');
    expect(transport).toHaveProperty('transport');
    expect(transport).toHaveProperty('start');
    expect(transport).toHaveProperty('close');
    expect(typeof transport.start).toBe('function');
    expect(typeof transport.close).toBe('function');
  });

  it('should respond on healthz endpoint', async () => {
    const config = createTestConfig({ HTTP_PORT: 3891 });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3891, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3891/healthz');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toBe(SERVER_VERSION);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should respond on readyz endpoint', async () => {
    const config = createTestConfig({ HTTP_PORT: 3892 });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3892, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3892/readyz');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; uptime: number };
      expect(body.status).toBe('ok');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should add CORS headers when origin configured', async () => {
    const config = createTestConfig({ HTTP_PORT: 3893, CORS_ORIGIN: 'https://example.com' });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3893, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3893/healthz', {
        headers: { Origin: 'https://example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should start and close via transport interface', async () => {
    const config = createTestConfig({ HTTP_PORT: 3894 });
    const httpTransport = createHttpTransport(config);
    await httpTransport.start();
    expect(httpTransport).toBeDefined();
    await httpTransport.close();
  });

  it('should reject unknown origin with ALLOWED_ORIGINS', async () => {
    const config = createTestConfig({
      HTTP_PORT: 3895,
      ALLOWED_ORIGINS: 'https://trusted.example.com',
    });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3895, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3895/healthz', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.error).toBe('Origin not allowed');
      expect(body.code).toBe('origin_not_allowed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should allow request without Origin header', async () => {
    const config = createTestConfig({ HTTP_PORT: 3896 });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3896, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3896/healthz');
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should handle OPTIONS preflight request', async () => {
    const config = createTestConfig({ HTTP_PORT: 3897 });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3897, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3897/healthz', { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe(
        'Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
      );
      expect(res.headers.get('access-control-max-age')).toBe('86400');
      expect(res.headers.get('vary')).toBe('Origin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should accept configured origin in ALLOWED_ORIGINS', async () => {
    const config = createTestConfig({
      HTTP_PORT: 3898,
      ALLOWED_ORIGINS: 'https://foo.example.com',
    });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(3898, '127.0.0.1', resolve));

    try {
      const res = await fetch('http://127.0.0.1:3898/healthz', {
        headers: { Origin: 'https://foo.example.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://foo.example.com');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('isLoopback', () => {
  it('should return true for 127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });

  it('should return true for localhost', () => {
    expect(isLoopback('localhost')).toBe(true);
  });

  it('should return true for ::1', () => {
    expect(isLoopback('::1')).toBe(true);
  });

  it('should return false for 0.0.0.0', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
  });

  it('should return false for a public IP', () => {
    expect(isLoopback('192.168.1.1')).toBe(false);
  });
});

describe('parseOriginAllowlist', () => {
  it('should return empty set for empty string', () => {
    const result = parseOriginAllowlist('');
    expect(result.size).toBe(0);
  });

  it('should parse comma-separated origins', () => {
    const result = parseOriginAllowlist('https://a.com,https://b.com');
    expect(result.size).toBe(2);
    expect(result.has('https://a.com')).toBe(true);
    expect(result.has('https://b.com')).toBe(true);
  });

  it('should trim whitespace around origins', () => {
    const result = parseOriginAllowlist(' https://a.com , https://b.com ');
    expect(result.has('https://a.com')).toBe(true);
    expect(result.has('https://b.com')).toBe(true);
  });

  it('should include wildcard when present', () => {
    const result = parseOriginAllowlist('*');
    expect(result.size).toBe(1);
    expect(result.has('*')).toBe(true);
  });

  it('should filter out empty entries', () => {
    const result = parseOriginAllowlist('https://a.com,,https://b.com');
    expect(result.size).toBe(2);
  });
});

describe('createOriginValidator', () => {
  it('should pass through requests without Origin header', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should allow request with known origin from allowlist', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: 'https://app.example.com',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://app.example.com' },
    });
    middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://app.example.com',
    );
    expect(next).toHaveBeenCalled();
  });

  it('should reject request with unknown origin', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: 'https://trusted.com',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://evil.com' },
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Origin not allowed',
      code: 'origin_not_allowed',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow all origins when wildcard is set', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '*',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://anything.com' },
    });
    middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://anything.com',
    );
    expect(next).toHaveBeenCalled();
  });

  it('should allow loopback origin with an explicit development port', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'http://localhost:5173' },
    });
    middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'http://localhost:5173',
    );
    expect(next).toHaveBeenCalled();
  });

  it('should reject non-loopback Host header while bound to loopback', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { host: 'evil.example.com:3000' },
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid Host header',
      code: 'host_mismatch',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow localhost origin on loopback', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'http://localhost' },
    });
    middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost');
    expect(next).toHaveBeenCalled();
  });

  it('should allow null origin on loopback', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'null' },
    });
    middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'null');
    expect(next).toHaveBeenCalled();
  });

  it('should reject unknown origin on non-loopback with empty allowlist', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: '',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://evil.com' },
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject Host header mismatch on non-loopback', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: 'https://app.example.com',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: {
        host: 'evil.com:3000',
        origin: 'https://app.example.com',
      },
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid Host header',
      code: 'host_mismatch',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass Host header that matches HTTP_HOST on non-loopback', () => {
    const config = EnvSchema.parse({
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 3000,
      ALLOWED_ORIGINS: 'https://app.example.com',
    });
    const middleware = createOriginValidator(config);
    const { req, res, next } = mockReqRes({
      headers: {
        host: '0.0.0.0:3000',
        origin: 'https://app.example.com',
      },
    });
    middleware(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('validateMcpProtocolVersion', () => {
  it('should pass through non-MCP requests', () => {
    const config = createTestConfig({ MCP_PROTOCOL_VERSION: '2025-11-25' });
    const middleware = validateMcpProtocolVersion(config);
    const { req, res, next } = mockReqRes({ path: '/healthz' });

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should allow MCP requests without a protocol-version header for compatibility', () => {
    const config = createTestConfig({ MCP_PROTOCOL_VERSION: '2025-11-25' });
    const middleware = validateMcpProtocolVersion(config);
    const { req, res, next } = mockReqRes({ path: '/mcp' });

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should allow MCP requests with the configured protocol version', () => {
    const config = createTestConfig({ MCP_PROTOCOL_VERSION: '2025-11-25' });
    const middleware = validateMcpProtocolVersion(config);
    const { req, res, next } = mockReqRes({
      path: '/mcp',
      headers: { 'mcp-protocol-version': '2025-11-25' },
    });

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should reject MCP requests with an unsupported protocol version', () => {
    const config = createTestConfig({ MCP_PROTOCOL_VERSION: '2025-11-25' });
    const middleware = validateMcpProtocolVersion(config);
    const { req, res, next } = mockReqRes({
      path: '/mcp',
      headers: { 'mcp-protocol-version': '2024-11-05' },
    });

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unsupported MCP protocol version',
      code: 'unsupported_protocol_version',
      supportedVersion: '2025-11-25',
      requestedVersion: '2024-11-05',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('handleCorsPreflight', () => {
  it('should respond 204 for OPTIONS request', () => {
    const { req, res, next } = mockReqRes({ method: 'OPTIONS' });
    handleCorsPreflight(req, res, next);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Methods',
      'GET, POST, DELETE, OPTIONS',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
    expect(res.end).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass through for GET request', () => {
    const { req, res, next } = mockReqRes({ method: 'GET' });
    handleCorsPreflight(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should pass through for POST request', () => {
    const { req, res, next } = mockReqRes({ method: 'POST' });
    handleCorsPreflight(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('createHttpTransport — OAuth/JWKS validation', () => {
  let ctx: OAuthTestContext;
  let nextPort = 3895;

  beforeAll(async () => {
    ctx = await createOAuthContext();
  });

  afterAll(async () => {
    await destroyOAuthContext(ctx);
  });

  async function createOAuthApp(overrides: Record<string, unknown> = {}) {
    const port = nextPort++;
    const config = createTestConfig({
      HTTP_PORT: port,
      OAUTH_ENABLED: true,
      OAUTH_JWKS_URI: ctx.jwksUrl,
      OAUTH_ISSUER: 'https://auth.example.com',
      OAUTH_AUDIENCE: 'test-audience',
      ...overrides,
    });
    const httpTransport = createHttpTransport(config);
    const server = http.createServer(httpTransport.app);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { server, port };
  }

  function fetchWithPort(port: number, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}/healthz`, init);
  }

  it('should allow CORS preflight before OAuth token validation', async () => {
    const { server, port } = await createOAuthApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject a no-Origin request without Authorization on non-loopback HTTP', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { server, port } = await createOAuthApp({
        HTTP_HOST: '0.0.0.0',
        ALLOWED_ORIGINS: 'https://app.example.com',
      });
      try {
        const res = await fetchWithPort(port);
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string; code: string };
        expect(body.code).toBe('missing_auth');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should reject requests without Authorization header', async () => {
    const { server, port } = await createOAuthApp();
    try {
      const res = await fetchWithPort(port);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('missing_auth');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject requests with malformed Authorization header', async () => {
    const { server, port } = await createOAuthApp();
    try {
      // HTTP clients strip trailing whitespace, so "Bearer " becomes "Bearer"
      // which fails the "Bearer " prefix check → missing_auth
      const res = await fetchWithPort(port, {
        headers: { Authorization: 'Bearer' },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('missing_auth');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject requests with malformed token', async () => {
    const { server, port } = await createOAuthApp();
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: 'Bearer definitely-not-a-real-token' },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('invalid_signature');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject expired token', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({ exp: '-1h' });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('token_expired');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject token with wrong issuer', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({ issuer: 'https://evil.example.com' });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('invalid_issuer');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject token with wrong audience', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({ audience: 'wrong-audience' });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('invalid_audience');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject token signed with different key', async () => {
    const { server, port } = await createOAuthApp();
    // Generate a second key pair and sign with it
    const { privateKey: evilKey } = await generateKeyPair('RS256');
    const evilToken = await new SignJWT({ sub: 'evil' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://auth.example.com')
      .setAudience('test-audience')
      .setExpirationTime('2h')
      .setIssuedAt()
      .sign(evilKey);
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${evilToken}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('invalid_signature');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should accept valid token', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({});
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject valid token without the required OAuth scope', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({ scope: '' });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        code: string;
        requiredScopes: string[];
        missingScopes: string[];
      };
      expect(body.code).toBe('insufficient_scope');
      expect(body.requiredScopes).toEqual(['easyeda:read']);
      expect(body.missingScopes).toEqual(['easyeda:read']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should accept required scopes from scp array claim', async () => {
    const { server, port } = await createOAuthApp({
      OAUTH_REQUIRED_SCOPES: 'easyeda:read easyeda:write',
    });
    const token = await ctx.signToken({ scope: '', scp: ['easyeda:read', 'easyeda:write'] });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should bypass OAuth only when HTTP_AUTH_DISABLED is true', async () => {
    const { server, port } = await createOAuthApp({ HTTP_AUTH_DISABLED: true });
    try {
      const res = await fetchWithPort(port);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should reject unsupported token type', async () => {
    const { server, port } = await createOAuthApp();
    const token = await ctx.signToken({ typ: 'invalid-type' });
    try {
      const res = await fetchWithPort(port, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('unsupported_token_type');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { randomUUID } from 'node:crypto';
import { type Express, type Request, type Response, type NextFunction } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { type EnvConfig } from '../../config/env.js';
import { SERVER_VERSION } from '../../config/version.js';
import { getLogger } from '../../utils/logger.js';
import {
  createProtectedResourceMetadata,
  setProtectedResourceChallenge,
} from './oauth-resource-metadata.js';

export interface HttpTransportInstance {
  app: Express;
  transport: StreamableHTTPServerTransport;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function createRateLimiter(windowMs: number, maxRequests: number) {
  const store = new Map<string, RateLimitEntry>();
  const CLEANUP_THRESHOLD = 1000;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();

    if (store.size > CLEANUP_THRESHOLD) {
      for (const [k, entry] of store) {
        if (entry.resetAt <= now) store.delete(k);
      }
    }

    let entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests', retryAfterMs: entry.resetAt - now });
      return;
    }
    next();
  };
}

/**
 * Supported token type hints (typ claim).
 * We accept JWT by default and only reject tokens with an explicit non-JWT typ.
 */
const SUPPORTED_TOKEN_TYPES = new Set(['JWT', undefined]);

export function normalizeOAuthScope(scope: string): string {
  return scope
    .trim()
    .replace(/^easyeda:/, 'easyeda.')
    .replace('project-admin', 'project_admin');
}

/** Structured error responses for token validation failures. */
function tokenError(
  req: Request,
  res: Response,
  config: EnvConfig,
  message: string,
  code = 'invalid_token',
): void {
  setProtectedResourceChallenge(req, res, config, code);
  res.status(401).json({ error: message, code });
}

function parseScopeList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function extractTokenScopes(payload: Record<string, unknown>): Set<string> {
  const scopes = new Set<string>();
  const addScope = (scope: unknown): void => {
    if (typeof scope === 'string') {
      for (const item of parseScopeList(scope)) scopes.add(item);
    }
  };

  addScope(payload.scope);
  addScope(payload.scp);

  for (const claimName of ['scp', 'permissions', 'roles']) {
    const claim = payload[claimName];
    if (Array.isArray(claim)) {
      for (const item of claim) addScope(item);
    }
  }

  return scopes;
}

function validateOAuthToken(config: EnvConfig) {
  if (!config.OAUTH_ENABLED || config.HTTP_AUTH_DISABLED) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  const requiredScopes = parseScopeList(config.OAUTH_REQUIRED_SCOPES);
  const normalizedRequiredScopes = requiredScopes.map(normalizeOAuthScope);

  // The config validator already ensures OAUTH_JWKS_URI is present when OAuth is enabled.
  // We cache the JWKSet for the lifetime of the server.
  const JWKSet = createRemoteJWKSet(new URL(config.OAUTH_JWKS_URI));

  return (req: Request, res: Response, next: NextFunction): void => {
    // ── 1. Extract Bearer token ───────────────────────────────────────────
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      tokenError(req, res, config, 'Missing or invalid Authorization header', 'missing_auth');
      return;
    }

    const token = auth.slice(7);
    if (!token) {
      tokenError(req, res, config, 'Empty Bearer token', 'empty_token');
      return;
    }

    // ── 2. Verify JWT ─────────────────────────────────────────────────────
    jwtVerify(token, JWKSet, {
      issuer: config.OAUTH_ISSUER || undefined,
      audience: config.OAUTH_AUDIENCE || undefined,
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
    })
      .then(({ payload, protectedHeader }) => {
        // Validate token type (typ) — it lives in the protected header per JWT spec
        const typ = protectedHeader.typ;
        if (typ !== undefined && !SUPPORTED_TOKEN_TYPES.has(typ)) {
          tokenError(req, res, config, `Unsupported token type: ${typ}`, 'unsupported_token_type');
          return;
        }

        if (requiredScopes.length > 0) {
          const tokenScopes = extractTokenScopes(payload as Record<string, unknown>);
          const normalizedTokenScopes = new Set([...tokenScopes].map(normalizeOAuthScope));
          const missingScopes = requiredScopes.filter(
            (_scope, idx) => !normalizedTokenScopes.has(normalizedRequiredScopes[idx] ?? ''),
          );
          if (missingScopes.length > 0) {
            res.status(403).json({
              error: 'Token is missing required OAuth scope',
              code: 'insufficient_scope',
              requiredScopes,
              missingScopes,
            });
            return;
          }
        }

        res.locals.claims = payload;
        next();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: msg }, 'OAuth token validation failed');

        // Map jose errors to user-friendly messages
        // jose error examples:
        //   '"exp" claim timestamp check failed' → token_expired
        //   '"iss" claim mismatch' → invalid_issuer
        //   '"aud" claim mismatch' → invalid_audience
        //   'signature verification failed' → invalid_signature
        if (/["']exp["']/.test(msg) || /expired|timestamp/i.test(msg)) {
          tokenError(req, res, config, 'Token has expired', 'token_expired');
        } else if (/["']iss["']/.test(msg) || /issuer/i.test(msg)) {
          tokenError(req, res, config, 'Invalid token issuer', 'invalid_issuer');
        } else if (/["']aud["']/.test(msg) || /audience/i.test(msg)) {
          tokenError(req, res, config, 'Invalid token audience', 'invalid_audience');
        } else if (/signature|key|JWT|JWS|malformed|parse/i.test(msg)) {
          tokenError(req, res, config, 'Invalid token signature', 'invalid_signature');
        } else {
          tokenError(req, res, config, 'Token validation failed', 'token_validation_failed');
        }
      });
  };
}

/** Check whether the given host is a loopback address. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function hostWithoutPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end >= 0 ? hostHeader.slice(1, end) : hostHeader;
  }
  return hostHeader.split(':')[0] ?? hostHeader;
}

function isAllowedLoopbackOrigin(origin: string): boolean {
  if (origin === 'null') return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname);
  } catch {
    return false;
  }
}

function validateHostHeader(config: EnvConfig, host: string | undefined): boolean {
  if (!host) return true;
  const hostname = hostWithoutPort(host).toLowerCase();
  const configuredHost = config.HTTP_HOST.toLowerCase();

  if (isLoopback(config.HTTP_HOST)) {
    return isLoopback(hostname);
  }

  const expectedHost = `${config.HTTP_HOST}:${config.HTTP_PORT}`;
  return (
    host === expectedHost ||
    host === config.HTTP_HOST ||
    hostname === configuredHost ||
    isLoopback(hostname)
  );
}

/**
 * Parse a comma-separated origin allowlist string into a Set.
 * Empty string returns an empty set. '*' returns a set containing '*' only.
 */
export function parseOriginAllowlist(raw: string): Set<string> {
  if (!raw) return new Set();
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(origins);
}

/**
 * Create middleware for origin validation and CORS handling.
 *
 * - DNS rebinding protection: validates the Host header matches the configured
 *   HTTP_HOST when running on a non-loopback address.
 * - Origin validation: rejects requests whose `Origin` is not in the allowlist.
 * - CORS preflight: responds with appropriate headers for OPTIONS requests.
 * - No-origin requests (non-browser clients) are always allowed.
 */
export function createOriginValidator(config: EnvConfig) {
  const allowedOrigins = parseOriginAllowlist(config.ALLOWED_ORIGINS);
  const hasExplicitAllowlist = allowedOrigins.size > 0;
  const allowAll = allowedOrigins.has('*');
  const loopbackMode = isLoopback(config.HTTP_HOST);

  return (req: Request, res: Response, next: NextFunction): void => {
    // ── 1. DNS rebinding protection ───────────────────────────────────────
    // On non-loopback, verify the Host header matches our configured bind address.
    // This prevents an attacker from pointing a DNS name at our IP and bypassing
    // browser same-origin policy.
    if (!validateHostHeader(config, req.headers.host)) {
      res.status(400).json({
        error: 'Invalid Host header',
        code: 'host_mismatch',
      });
      return;
    }

    // ── 2. Origin validation ──────────────────────────────────────────────
    const origin = req.headers.origin;

    // Non-browser requests without an Origin header are always allowed.
    if (!origin) {
      next();
      return;
    }

    // Wildcard allows everything.
    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      next();
      return;
    }

    // On loopback, accept known localhost origins and the legacy CORS_ORIGIN.
    if (loopbackMode) {
      const legacyMatch = config.CORS_ORIGIN && origin === config.CORS_ORIGIN;
      if (isAllowedLoopbackOrigin(origin) || legacyMatch) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        next();
        return;
      }
    }

    // Check the explicit allowlist.
    if (hasExplicitAllowlist && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      next();
      return;
    }

    // ── 3. Reject unknown origins ─────────────────────────────────────────
    res.status(403).json({
      error: 'Origin not allowed',
      code: 'origin_not_allowed',
    });
  };
}

export function validateMcpProtocolVersion(config: EnvConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestPath = req.path || req.url || '';
    if (!requestPath.startsWith('/mcp')) {
      next();
      return;
    }

    const header = req.headers['mcp-protocol-version'];
    const requestedVersion = Array.isArray(header) ? header[0] : header;
    if (requestedVersion === undefined || requestedVersion === config.MCP_PROTOCOL_VERSION) {
      next();
      return;
    }

    res.status(400).json({
      error: 'Unsupported MCP protocol version',
      code: 'unsupported_protocol_version',
      supportedVersion: config.MCP_PROTOCOL_VERSION,
      requestedVersion,
    });
  };
}

/** CORS preflight handler for OPTIONS requests. */
export function handleCorsPreflight(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    // Vary: Origin tells caches that the response varies by the Origin header.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, MCP-Protocol-Version',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }
  next();
}

function addSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
}

export function createHttpTransport(config: EnvConfig): HttpTransportInstance {
  const logger = getLogger();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const app = createMcpExpressApp({ host: config.HTTP_HOST });

  app.use(addSecurityHeaders);

  app.use(createRateLimiter(60_000, config.HTTP_RATE_LIMIT_MAX));

  // Origin validation and CORS preflight must run before OAuth so browser
  // preflight can complete without a bearer token while still enforcing origin.
  app.use(createOriginValidator(config));
  app.use(handleCorsPreflight);
  app.use(validateMcpProtocolVersion(config));

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json(createProtectedResourceMetadata(req, config));
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    res.json(createProtectedResourceMetadata(req, config));
  });

  app.use(validateOAuthToken(config));

  app.post('/mcp', (req, res) => {
    transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', (req, res) => {
    transport.handleRequest(req, res);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: SERVER_VERSION });
  });

  app.get('/readyz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  let server: ReturnType<typeof app.listen> | undefined;

  const start = async () => {
    return new Promise<void>((resolve) => {
      server = app.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
        logger.info({ host: config.HTTP_HOST, port: config.HTTP_PORT }, 'HTTP transport listening');
        resolve();
      });
    });
  };

  const close = async () => {
    logger.info('HTTP transport closing');
    await transport.close();
    const s = server;
    if (s) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  };

  return { app, transport, start, close };
}

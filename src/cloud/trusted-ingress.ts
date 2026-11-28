import type { IncomingMessage } from 'node:http';
import { isIP, isIPv4 } from 'node:net';
import type { Express } from 'express';

/** Optional deployment-private immediate peer, never a CIDR or hop count. */
export function parseTrustedProxyIp(value: string | undefined): string | undefined {
  const ip = value?.trim();
  if (!ip) return undefined;
  if (!isIPv4(ip) || ip === '0.0.0.0' || ip === '255.255.255.255') {
    throw new Error('Hosted Cloud trusted proxy must be one exact IPv4 address.');
  }
  return ip;
}

function normalizeIp(value: string): string | undefined {
  if (!isIP(value) || value.includes('%')) return undefined;
  if (isIPv4(value)) return value;
  // URL serialization canonicalizes equivalent IPv6 spellings. Normalize mapped
  // IPv4 before either limiter so it cannot acquire a second identity.
  const ip = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
  if (!mapped) return ip;
  const high = Number.parseInt(mapped[1] ?? '0', 16);
  const low = Number.parseInt(mapped[2] ?? '0', 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function matchesPeer(peer: string | undefined, trusted: string): boolean {
  return peer !== undefined && normalizeIp(peer) === trusted;
}

type IngressResult = { ok: true; ip: string } | { ok: false; status: 400 | 403 };

/** One canonical address supplied by the explicitly trusted immediate proxy. */
export function resolveTrustedIngress(request: IncomingMessage, trusted: string): IngressResult {
  if (!matchesPeer(request.socket.remoteAddress, trusted)) return { ok: false, status: 403 };
  const forwarded = request.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? normalizeIp(forwarded) : undefined;
  return ip ? { ok: true, ip } : { ok: false, status: 400 };
}

function isDirectHealthProbe(request: IncomingMessage): boolean {
  const peer = normalizeIp(request.socket.remoteAddress ?? '');
  return (
    request.method === 'GET' &&
    (request.url === '/healthz' || request.url === '/readyz') &&
    (peer === '127.0.0.1' || peer === '::1') &&
    request.headers['x-forwarded-for'] === undefined
  );
}

/** Run before Express and Better Auth rate limiters; never enable broad proxy trust. */
export function mountTrustedIngress(
  app: Express,
  auth?: { trustedProxyIp?: string; origin: string },
): void {
  const trusted = auth?.trustedProxyIp;
  if (!trusted) return;
  const canonical = new URL(auth.origin);
  app.set('trust proxy', (ip: string, hop: number) => hop === 0 && matchesPeer(ip, trusted));
  app.use((req, res, next) => {
    if (isDirectHealthProbe(req)) {
      next();
      return;
    }
    const client = resolveTrustedIngress(req, trusted);
    if (!client.ok) {
      res.status(client.status).json({ error: 'Invalid hosted ingress' });
      return;
    }
    req.headers['x-forwarded-for'] = client.ip;
    req.headers['x-forwarded-host'] = canonical.host;
    req.headers['x-forwarded-proto'] = canonical.protocol.slice(0, -1);
    next();
  });
}

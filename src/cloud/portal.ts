import type { Express, Request, Response } from 'express';
import type { HostedAuth } from './hosted-auth.js';
import { CLOUD_CSS, CLOUD_JS } from './portal-assets.js';
import type { RemoteGateway } from '../remote/gateway.js';

const PORTAL_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
].join('; ');

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const names: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return names[char] ?? char;
  });
}

function page(title: string, body: string, state: 'sign-in' | 'consent' | 'account'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>${escaped(title)} · EasyEDA MCP Pro Cloud</title><link rel="stylesheet" href="/cloud/app.css"></head>
<body><div class="wrap">
<header class="nav"><a class="brand" href="/cloud"><span class="mark" aria-hidden="true">E</span><span>EasyEDA MCP Pro</span></a><span class="tag">CLOUD · EARLY ACCESS</span></header>
<main id="cloud-root" data-page="${state}">${body}<p class="muted" id="notice" role="status" aria-live="polite"></p></main>
<footer>Cloud is optional. Your EasyEDA projects remain on your device. <a href="https://github.com/oaslananka/easyeda-mcp-pro">Open-source Local MCP</a> works without sign-in.</footer></div>
<script defer src="/cloud/app.js"></script></body></html>`;
}

const signIn = (): string =>
  page(
    'Sign in',
    `<p class="eyebrow">Your workspace · Your choice</p>
<h1 class="hero">Connect your design workflow, on your terms.</h1>
<p class="subtitle">Sign in to link an EasyEDA extension and authorize an AI client. Nothing changes in Local mode until you explicitly enable Cloud in EasyEDA.</p>
<section class="panel" aria-labelledby="signin-title"><h2 id="signin-title">Sign in to Cloud</h2>
<p class="muted">Use an existing account. No new password to manage.</p>
<div class="actions"><button class="btn" type="button" data-provider="github">Continue with GitHub</button>
<button class="btn secondary" type="button" data-provider="google">Continue with Google</button></div>
<div class="segment"><p class="muted">After sign-in, you can choose which extension to pair and revoke access at any time. Your AI client will ask separately for MCP permissions.</p></div></section>`,
    'sign-in',
  );

const account = (): string =>
  page(
    'Your connections',
    `<p class="eyebrow">Cloud control center</p><h1 class="hero">Your devices. Your permissions.</h1>
<p class="subtitle">Signed in as <strong id="account-name">your account</strong>. Link an extension only when you choose Cloud in EasyEDA.</p>
<div class="columns"><section class="panel wide" aria-labelledby="extensions-title">
<h2 id="extensions-title">Linked EasyEDA extensions</h2><p class="muted">Your active projects are shown by each connected extension. Removing access disconnects that session.</p>
<div id="extensions" aria-live="polite"><div class="empty">Loading your extensions…</div></div>
<div class="actions"><button class="btn secondary" id="refresh-extensions" type="button">Refresh connections</button></div></section>
<section class="panel wide" aria-labelledby="pair-title"><h2 id="pair-title">Link a new extension</h2>
<p class="muted">1. Open EasyEDA's MCP Bridge menu. 2. Choose Connect Cloud... (Experimental). 3. Enter this one-time code.</p>
<div class="actions"><button class="btn" id="generate-pairing" type="button">Generate pairing code</button></div>
<p id="pairing-code" class="code" aria-live="polite" aria-label="One-time pairing code">—</p>
<p class="muted" id="pairing-hint">The code will be valid for 10 minutes. Leave Local selected if you do not want Cloud.</p></section></div>
<div class="panel wide account-client-panel"><h2>Authorized MCP clients</h2>
<p class="muted">Clients you approved using the MCP OAuth flow are separate from your GitHub/Google sign-in. You can revoke each grant.</p>
<div id="clients" aria-live="polite"><div class="empty">Checking authorizations…</div></div></div>
<div class="actions"><button id="sign-out" class="btn secondary" type="button">Sign out of Cloud</button></div>`,
    'account',
  );

function consent(clientName: string, redirectHost: string, scopeList: string[]): string {
  const permissions = scopeList.map((scope) => `<li>${escaped(scope)}</li>`).join('');
  return page(
    'Approve client',
    `<p class="eyebrow">MCP client authorization</p><h1 class="hero">Choose what this AI client can access.</h1>
<p class="subtitle">Your Cloud account sign-in does not authorize a client automatically. Review its request before continuing.</p>
<section class="panel" aria-labelledby="consent-title"><h2 id="consent-title">${escaped(clientName)}</h2>
<p class="muted">After approval, the client returns to: <strong>${escaped(redirectHost)}</strong></p>
<p class="muted">Requested permissions:</p><ul class="scopes">${permissions}</ul>
<p class="notice">Read access is routed through your paired EasyEDA extension. Write or export still requires approval in your EasyEDA extension. Never approve a client you do not recognize.</p>
<div class="actions"><button class="btn" type="button" data-consent="allow">Allow these permissions</button>
<button class="btn danger" type="button" data-consent="deny">Deny access</button></div></section>`,
    'consent',
  );
}

function sessionHeaders(req: Request): Headers {
  const headers = new Headers();
  const cookie = req.headers.cookie;
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

function sendHtml(res: Response, html: string): void {
  res.setHeader('Content-Security-Policy', PORTAL_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(html);
}

function rejectUnauthorized(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ code: 'NOT_SIGNED_IN', message: 'Sign in to your Cloud account.' });
}

function safeRedirectHost(uri: string | null): string {
  if (!uri) return 'the AI client';
  try {
    const url = new URL(uri);
    return url.host || url.protocol.replace(':', '') + ' application';
  } catch {
    return 'the AI client';
  }
}

async function signedQuery(req: Request, auth: HostedAuth): Promise<URLSearchParams | undefined> {
  const query = new URL(req.originalUrl, auth.origin).search.slice(1);
  if (!query || !(await auth.verifySignedQuery(query))) return undefined;
  return new URLSearchParams(query);
}

function sessionRequired(auth: HostedAuth) {
  return async (req: Request, res: Response): Promise<string | undefined> => {
    const user = await auth.getSessionUser(sessionHeaders(req));
    if (!user) {
      rejectUnauthorized(res);
      return undefined;
    }
    return user.id;
  };
}

function originRequired(req: Request, res: Response, expected: string): boolean {
  if (req.get('origin') === expected) return true;
  res
    .status(403)
    .json({ code: 'ORIGIN_MISMATCH', message: 'This action must originate from Cloud.' });
  return false;
}

/** Cookie-authenticated browser portal; never reuses session cookies as MCP bearer credentials. */
export function mountHostedPortal(app: Express, auth: HostedAuth, gateway: RemoteGateway): void {
  const requireSession = sessionRequired(auth);
  app.get('/cloud/app.css', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('css').send(CLOUD_CSS);
  });
  app.get('/cloud/app.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').send(CLOUD_JS);
  });
  app.get('/sign-in', async (req, res) => {
    const hasQuery = new URL(req.originalUrl, auth.origin).search.length > 0;
    if (hasQuery && !(await signedQuery(req, auth))) {
      res.status(400).type('text/plain').send('This authorization request is invalid or expired.');
      return;
    }
    sendHtml(res, signIn());
  });
  app.get('/consent', async (req, res) => {
    const query = await signedQuery(req, auth);
    const clientId = query?.get('client_id');
    if (!query || !clientId) {
      res.status(400).type('text/plain').send('This authorization request is invalid or expired.');
      return;
    }
    const user = await requireSession(req, res);
    if (!user) return;
    const client = await auth.getClient(clientId, sessionHeaders(req));
    if (!client) {
      res.status(404).type('text/plain').send('This client is unavailable.');
      return;
    }
    const scopes = (query.get('scope') ?? '').split(/\s+/).filter(Boolean);
    sendHtml(res, consent(client.name, safeRedirectHost(query.get('redirect_uri')), scopes));
  });

  app.get('/cloud', async (req, res) => {
    const user = await auth.getSessionUser(sessionHeaders(req));
    if (!user) {
      res.redirect(303, '/sign-in');
      return;
    }
    sendHtml(res, account());
  });

  app.get('/cloud/api/me', async (req, res) => {
    const user = await auth.getSessionUser(sessionHeaders(req));
    if (!user) return rejectUnauthorized(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user });
  });
  app.get('/cloud/api/extensions', async (req, res) => {
    const userId = await requireSession(req, res);
    if (!userId) return;
    res.setHeader('Cache-Control', 'no-store');
    const identity = { userId, scopes: ['easyeda.read'] as const };
    res.json({
      sessions: gateway.listPairedExtensions(identity),
      selection: gateway.getSelectedProject(identity) ?? null,
    });
  });
  app.put('/cloud/api/selection', async (req, res) => {
    if (!originRequired(req, res, auth.origin)) return;
    const userId = await requireSession(req, res);
    if (!userId) return;
    const sessionId: unknown = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !/^sess_[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
      res.status(400).json({ code: 'INVALID_SESSION', message: 'Choose a linked extension.' });
      return;
    }
    const identity = { userId, scopes: ['easyeda.read'] as const };
    if (!gateway.selectPairedProject(identity, sessionId)) {
      res.status(404).json({
        code: 'PROJECT_NOT_AVAILABLE',
        message: 'This extension or active project is not available. Refresh and retry.',
      });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ selection: gateway.getSelectedProject(identity) });
  });
  app.post('/cloud/api/pairing-code', async (req, res) => {
    if (!originRequired(req, res, auth.origin)) return;
    const userId = await requireSession(req, res);
    if (!userId) return;
    const code = gateway.createPairingCode({ identity: { userId, scopes: ['easyeda.read'] } });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code, expiresInSeconds: 600 });
  });
  app.delete('/cloud/api/extensions/:sessionId', async (req, res) => {
    if (!originRequired(req, res, auth.origin)) return;
    const userId = await requireSession(req, res);
    if (!userId) return;
    const sessionId = req.params.sessionId;
    if (
      typeof sessionId !== 'string' ||
      !/^sess_[a-zA-Z0-9_-]{1,100}$/.test(sessionId) ||
      !gateway.revokePairedExtension({ userId, scopes: ['easyeda.read'] }, sessionId)
    ) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'This extension was not found.' });
      return;
    }
    res.status(204).end();
  });
}

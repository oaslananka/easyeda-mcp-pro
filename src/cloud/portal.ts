import { createHash } from 'node:crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import type { HostedAuth } from './hosted-auth.js';
import type { HostedUsageStore } from './usage.js';
import { CLOUD_CSS, CLOUD_JS } from './portal-assets.js';
import type { RemoteGateway } from '../remote/gateway.js';

// Each browser gets the current assets even when its previous Cloud version
// is cached. Derive the URL from content, not the package version.
const cssVersion = createHash('sha256').update(CLOUD_CSS).digest('hex').slice(0, 12);
const jsVersion = createHash('sha256').update(CLOUD_JS).digest('hex').slice(0, 12);

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

const HTML_ENTITIES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES.get(char) ?? char);
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function page(title: string, body: string, state: 'sign-in' | 'consent' | 'account'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>${escaped(title)} · EasyEDA MCP Pro Cloud</title><link rel="stylesheet" href="/assets/easyeda-cloud.css?v=${cssVersion}"></head>
<body><div class="wrap">
<header class="nav"><a class="brand" href="/" aria-label="EasyEDA MCP Pro Cloud"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5" stroke="currentColor" stroke-width="1.8" fill="rgba(14, 165, 233, 0.15)"/><path d="M7 8h6M7 12h4M7 16h7M17 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="8" r="1.5" fill="currentColor"/><circle cx="17" cy="16" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/><circle cx="11" cy="12" r="1.5" fill="currentColor"/></svg></span><span class="brand-name">EasyEDA <span>MCP Pro</span></span></a><div class="nav-right"><span class="tag"><span class="tag-dot" aria-hidden="true"></span>Cloud preview</span><a class="nav-link" href="https://github.com/oaslananka/easyeda-mcp-pro">GitHub <span class="nav-arrow" aria-hidden="true">↗</span></a></div></header>
<main id="cloud-root" data-page="${state}">${body}<p class="muted" id="notice" role="status" aria-live="polite"></p></main>
<footer><span>EasyEDA MCP Pro Cloud · Preview</span><span>Your designs stay on your device. <a href="https://github.com/oaslananka/easyeda-mcp-pro">Use Local MCP without an account ↗</a></span></footer></div>
<script defer src="/assets/easyeda-cloud.js?v=${jsVersion}"></script></body></html>`;
}

const signIn = (): string =>
  page(
    'Connect EasyEDA',
    `<div class="landing-grid">
<section class="landing-intro" aria-labelledby="landing-title">
<p class="eyebrow">EASYEDA MCP PRO / CLOUD</p>
<h1 id="landing-title" class="hero">Connect EasyEDA Pro to your MCP client.</h1>
<p class="subtitle">Pair your EasyEDA Pro extension, pick the design you're working on, and choose which MCP clients can access it.</p>
<div class="journey" aria-label="How it works">
<div class="journey-step"><span class="step-num">01</span><span><strong>Sign in</strong><small>Use your GitHub or Google account</small></span></div>
<div class="journey-step"><span class="step-num">02</span><span><strong>Pair EasyEDA</strong><small>Enter a one-time code in MCP Bridge</small></span></div>
<div class="journey-step"><span class="step-num">03</span><span><strong>Choose access</strong><small>Select a design and approve your MCP client</small></span></div>
</div></section>
<section class="auth-card" aria-labelledby="signin-title">
<div class="auth-card-top"><div class="auth-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></div><span class="step-indicator">STEP 01 / 03</span></div>
<h2 id="signin-title">Get started</h2>
<p class="auth-description">Sign in to open your Cloud workspace.</p>
<div class="auth-buttons">
<button class="btn provider-button" type="button" data-provider="github"><span class="provider-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.11.8-.25.8-.56v-2.08c-3.24.7-3.92-1.38-3.92-1.38-.53-1.35-1.29-1.71-1.29-1.71-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.41-1.26.75-1.55-2.59-.29-5.32-1.3-5.32-5.8 0-1.29.46-2.35 1.2-3.18-.12-.3-.52-1.51.12-3.14 0 0 .98-.31 3.18 1.21a11.1 11.1 0 0 1 5.8 0C16.1 4.1 17.08 4.4 17.08 4.4c.64 1.63.24 2.84.12 3.14.75.83 1.19 1.89 1.19 3.18 0 4.51-2.73 5.51-5.33 5.8.42.36.8 1.06.8 2.13v3.7c0 .31.22.68.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg></span><span>Continue with GitHub</span><span class="button-arrow" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 13 3M5 3h8v8"/></svg></span></button>
<button class="btn provider-button secondary" type="button" data-provider="google"><span class="provider-mark google-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.65v3h3.86c2.26-2.09 3.685-5.17 3.685-9.09z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/></svg></span><span>Continue with Google</span><span class="button-arrow" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 13 3M5 3h8v8"/></svg></span></button>
</div>
<div class="auth-card-foot"><span class="privacy-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg></span><span>No new password. Your files stay on your computer. You approve each MCP client's permissions separately.</span></div>
</section></div>
<div class="trust-strip" aria-label="Cloud safeguards">
<div><span class="trust-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span><span><strong>Local first</strong><small>Design files remain on your device</small></span></div>
<div><span class="trust-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span><span><strong>Explicit pairing</strong><small>Only devices you connect</small></span></div>
<div><span class="trust-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span><span><strong>In your control</strong><small>Revoke access whenever you need</small></span></div>
</div>`,
    'sign-in',
  );

const account = (): string =>
  page(
    'Your devices',
    `<div class="workspace-head"><div>
<p class="eyebrow">CLOUD WORKSPACE</p>
<h1 class="workspace-title">Your devices</h1>
<p class="workspace-desc">Connect EasyEDA to the AI assistant you already use. Your designs stay on your device.</p>
</div><div class="account-identity"><span class="identity-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span><span><small>Signed in as</small><strong id="account-name">Your account</strong></span></div></div>
<section class="panel guided-panel" aria-labelledby="guided-title" id="start">
<div class="section-heading"><div><p class="section-kicker" id="guided-kicker">FIRST CONNECTION</p><h2 id="guided-title">Start using EasyEDA MCP Pro</h2></div><span class="step-indicator" id="guided-phase">GUIDED SETUP</span></div>
<p class="section-description">Follow one setup path. You do not need a WSS address, API token, or MCP configuration file unless your AI app requires one.</p>
<ol class="guided-progress" aria-label="Connection progress">
<li id="progress-client" data-state="done"><span class="guided-number">1</span><span>Choose AI app</span></li>
<li id="progress-device" data-state="current"><span class="guided-number">2</span><span>Connect EasyEDA</span></li>
<li id="progress-access" data-state="waiting"><span class="guided-number">3</span><span>Approve access</span></li>
<li id="progress-ask" data-state="waiting"><span class="guided-number">4</span><span>Ask a question</span></li>
</ol>
<div class="guided-grid">
<div class="guided-choice">
<h3>Which AI assistant do you use?</h3>
<div class="client-chooser" role="group" aria-label="Choose your AI assistant">
<button type="button" id="client-chatgpt" class="client-choice" aria-pressed="true">ChatGPT</button>
<button type="button" id="client-claude" class="client-choice" aria-pressed="false">Claude</button>
<button type="button" id="client-cursor" class="client-choice" aria-pressed="false">Cursor</button>
<button type="button" id="client-codex" class="client-choice" aria-pressed="false">Codex</button>
<button type="button" id="client-other" class="client-choice" aria-pressed="false">Other MCP app</button>
</div>
<div class="guided-instructions">
<strong id="client-instructions-title">Connect ChatGPT</strong>
<p id="client-instructions" class="muted">In ChatGPT Plugins, add a custom MCP server using this address, then approve Read access.</p>
<code class="guided-config" id="client-config">https://easyeda-mcp-pro.oaslananka.dev/mcp</code>
<div class="guided-actions">
<button type="button" id="copy-client-config" class="btn small">Copy server URL</button>
<a id="open-client" class="btn secondary small" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">Open ChatGPT Plugins ↗</a>
</div>
</div>
</div>
<div class="guided-status">
<div class="guided-status-line"><span>EasyEDA & selected design</span><strong id="guided-device-status">Checking connection…</strong><a href="#pair-title" id="guided-connect-link">Set up EasyEDA ↓</a></div>
<div class="guided-status-line"><span>MCP client permission</span><strong id="guided-access-status">Checking authorization…</strong><a href="#clients-title">Manage permissions ↓</a></div>
<div class="guided-status-line guided-last"><span>First question</span><p class="muted">“Inspect the focused schematic and explain its power connections. Do not change anything.”</p><button class="btn subtle small" id="copy-first-question" type="button" disabled>Copy first question</button></div>
</div>
</div>
<p id="guided-hint" class="guided-hint" role="status" aria-live="polite">Choose your AI app, then connect EasyEDA below.</p>
</section>
<div class="workspace-grid" id="workspace-grid">
<section class="panel device-panel" aria-labelledby="extensions-title">
<div class="section-heading"><div><p class="section-kicker">CONNECTED WORKSPACE</p><h2 id="extensions-title">EasyEDA devices <span class="count" id="device-count" aria-live="polite">—</span></h2></div>
<button class="btn subtle small" id="refresh-extensions" type="button">↻ Refresh</button></div>
<p class="section-description">Only devices that you pair appear here. Choose the open design you want to use.</p>
<div id="extensions" class="device-list" aria-live="polite"><div class="empty">Checking your devices…</div></div>
</section>
<section class="panel pairing-panel" aria-labelledby="pair-title">
<div class="section-heading"><div><p class="section-kicker">ADD A DEVICE</p><h2 id="pair-title">Connect EasyEDA</h2></div><span class="step-indicator">SETUP</span></div>
<div class="setup-steps"><p><span>1</span><span class="step-copy">Download <a href="https://github.com/oaslananka/easyeda-mcp-pro/releases/latest/download/easyeda-bridge-extension.eext">MCP Pro Bridge (.eext)</a> and import it in EasyEDA's Extension Manager. Enable <strong>Allow interactive with external</strong>, then save your work and reload the EasyEDA tab.</span></p>
<p><span>2</span><span class="step-copy">Open a PCB or schematic and choose <strong>MCP Bridge → Connect EasyEDA MCP Pro Cloud</strong>.</span></p>
<p><span>3</span><span class="step-copy">Enter the code shown below. No WSS address is required.</span></p></div>
<button class="btn pair-button" id="generate-pairing" type="button">Generate pairing code <span aria-hidden="true">↗</span></button>
<div class="pairing-actions"><p id="pairing-code" class="code" aria-live="polite" aria-label="One-time pairing code">—</p>
<button class="btn subtle small" id="copy-pairing" type="button" aria-describedby="pairing-hint" disabled hidden>Copy code</button></div>
<p class="muted" id="pairing-hint">The code expires after 10 minutes. Pairing does not grant an MCP client access.</p>
</section></div>
<section class="panel usage-panel" aria-labelledby="usage-title">
<div class="section-heading"><div><p class="section-kicker">YOUR ACTIVITY</p><h2 id="usage-title">MCP tool calls</h2></div>
<button class="btn subtle small" id="refresh-usage" type="button">↻ Refresh</button></div>
<p class="section-description">Calls completed through your paired EasyEDA device, including errors. Refreshes every 30 seconds while this page is active. Requests rejected before dispatch are not counted.</p>
<div class="usage-grid">
<div class="usage-stat"><strong id="usage-total" aria-live="polite">—</strong><span>Total calls</span></div>
<div class="usage-stat"><strong id="usage-success" aria-live="polite">—</strong><span>Successful</span></div>
<div class="usage-stat"><strong id="usage-failed" aria-live="polite">—</strong><span>Tool errors</span></div>
</div><p class="muted" id="usage-hint" role="status" aria-live="polite">Checking your call history…</p>
</section>
<section class="panel clients-panel" aria-labelledby="clients-title">
<div class="section-heading"><div><p class="section-kicker">PERMISSIONS</p><h2 id="clients-title">Authorized MCP clients</h2></div>
<button class="btn subtle small" id="refresh-clients" type="button">↻ Refresh</button></div>
<p class="section-description">Review each client's permissions. Each MCP client has its own Read, Write, Export and Admin permissions. Manage access here. For verified clients and selected projects, EasyEDA asks once to allow routine edits or local exports for up to 30 minutes; high-risk actions still need individual approval. Revoke client access here to stop its future calls.</p>
<div id="clients" aria-live="polite"><div class="empty">Checking authorizations…</div></div></section>
<div class="account-actions"><button id="sign-out" class="btn subtle small" type="button">Sign out</button></div>`,
    'account',
  );

const PERMISSION_DETAILS = new Map<string, readonly [title: string, detail: string]>([
  ['easyeda.read', ['Read your selected design', 'No editing is permitted by this scope.']],
  [
    'easyeda.write',
    [
      'Request design changes',
      'Routine edits need one EasyEDA project-session approval for up to 30 minutes; high-risk actions require separate approval.',
    ],
  ],
  [
    'easyeda.export',
    [
      'Export design files',
      'Local artifact exports can share a separate 30-minute EasyEDA project-session approval; external actions remain individually guarded.',
    ],
  ],
  [
    'easyeda.project_admin',
    [
      'Request high-risk project actions',
      'Destructive operations require stronger approval; unsupported actions remain blocked.',
    ],
  ],
  ['openid', ['Verify your identity', 'Let this client identify your signed-in account.']],
  ['profile', ['Basic profile information', 'Share basic information about your account.']],
  ['email', ['Email address', 'Share your account email address with this client.']],
  ['offline_access', ['Stay connected', 'Allow the client to renew access until you revoke it.']],
]);

function consent(clientName: string, redirectHost: string, scopeList: string[]): string {
  const defaultScopes = new Set(['openid', 'profile', 'email', 'easyeda.read']);
  const scopeOption = (scope: string): string => {
    const [title, detail] = PERMISSION_DETAILS.get(scope) ?? [
      'Other requested permission',
      'Review this permission code before approving.',
    ];
    const selected = defaultScopes.has(scope) ? ' checked' : '';
    return `<li><label class="scope-option"><input type="checkbox" name="cloud-scope" value="${escaped(scope)}"${selected}><span><strong>${escaped(title)}</strong><small>${escaped(detail)}</small><code>${escaped(scope)}</code></span></label></li>`;
  };
  const basicPermissions = new Set(['openid', 'profile', 'email', 'easyeda.read']);
  const permissions = scopeList
    .filter((scope) => basicPermissions.has(scope))
    .map(scopeOption)
    .join('');
  const additionalPermissions = scopeList
    .filter((scope) => !basicPermissions.has(scope))
    .map(scopeOption)
    .join('');
  return page(
    'Approve client',
    `<p class="eyebrow">MCP client authorization</p><h1 class="hero">Choose this client's permissions.</h1>
<p class="subtitle">Your Cloud sign-in does not authorize an MCP client automatically. Select only the access you want to grant.</p>
<section class="panel" aria-labelledby="consent-title"><h2 id="consent-title">${escaped(clientName)}</h2>
<p class="muted">After approval, the client returns to: <strong>${escaped(redirectHost)}</strong></p>
<p class="muted">Start with Read access. Add more permissions only if your AI client needs them.</p>
<ul class="scopes">${permissions}</ul>
${additionalPermissions ? '<details class="consent-advanced"><summary>More permissions (optional)</summary><ul class="scopes">' + additionalPermissions + '</ul></details>' : ''}
<p class="notice">Write, Export and Admin stay off unless you select them. EasyEDA still requires approval before a change or export. Only authorize clients you recognize.</p>
<div class="actions"><button class="btn" type="button" data-consent="allow">Allow selected permissions</button>
<button class="btn secondary" type="button" data-consent="deny">Deny access</button></div></section>`,
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
export function mountHostedPortal(
  app: Express,
  auth: HostedAuth,
  gateway: RemoteGateway,
  usage?: HostedUsageStore,
): void {
  const requireSession = sessionRequired(auth);
  // Static browser assets stay accessible before the optional owner-only /cloud* preview gate.
  // Keep the legacy routes for compatibility with already-open Cloud pages.
  app.get(['/assets/easyeda-cloud.css', '/cloud/app.css'], (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('css').send(CLOUD_CSS);
  });
  app.get(['/assets/easyeda-cloud.js', '/cloud/app.js'], (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').send(CLOUD_JS);
  });
  // Browser root is a human entry point; MCP endpoints still require bearer authorization.
  app.get(
    '/',
    asyncRoute(async (req, res) => {
      const user = await auth.getSessionUser(sessionHeaders(req));
      sendHtml(res, user ? account() : signIn());
    }),
  );
  app.get(
    '/sign-in',
    asyncRoute(async (req, res) => {
      const hasQuery = new URL(req.originalUrl, auth.origin).search.length > 0;
      if (hasQuery && !(await signedQuery(req, auth))) {
        res
          .status(400)
          .type('text/plain')
          .send('This authorization request is invalid or expired.');
        return;
      }
      sendHtml(res, signIn());
    }),
  );
  app.get(
    '/consent',
    asyncRoute(async (req, res) => {
      const query = await signedQuery(req, auth);
      const clientId = query?.get('client_id');
      if (!query || !clientId) {
        res
          .status(400)
          .type('text/plain')
          .send('This authorization request is invalid or expired.');
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
    }),
  );

  app.get(
    '/cloud',
    asyncRoute(async (req, res) => {
      const user = await auth.getSessionUser(sessionHeaders(req));
      if (!user) {
        res.redirect(303, '/sign-in');
        return;
      }
      sendHtml(res, account());
    }),
  );

  app.get(
    '/cloud/api/me',
    asyncRoute(async (req, res) => {
      const user = await auth.getSessionUser(sessionHeaders(req));
      if (!user) {
        rejectUnauthorized(res);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ user });
    }),
  );
  app.get(
    '/cloud/api/usage',
    asyncRoute(async (req, res) => {
      const userId = await requireSession(req, res);
      if (!userId) return;
      res.setHeader('Cache-Control', 'no-store');
      if (!usage) {
        res.status(503).json({ code: 'USAGE_UNAVAILABLE', message: 'Usage is unavailable.' });
        return;
      }
      res.json(usage.totals(userId));
    }),
  );
  app.get(
    '/cloud/api/clients',
    asyncRoute(async (req, res) => {
      const userId = await requireSession(req, res);
      if (!userId) return;
      const clients = await auth.listClientConsents(sessionHeaders(req));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ clients });
    }),
  );
  app.get(
    '/cloud/api/extensions',
    asyncRoute(async (req, res) => {
      const userId = await requireSession(req, res);
      if (!userId) return;
      res.setHeader('Cache-Control', 'no-store');
      const identity = { userId, scopes: ['easyeda.read'] as const };
      res.json({
        sessions: gateway.listPairedExtensions(identity),
        selection: gateway.getSelectedProject(identity) ?? null,
      });
    }),
  );
  app.put(
    '/cloud/api/selection',
    asyncRoute(async (req, res) => {
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
          message:
            'Focus a schematic or PCB in EasyEDA, update MCP Bridge to a Cloud-capable build, then refresh and select that project.',
        });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ selection: gateway.getSelectedProject(identity) });
    }),
  );
  app.post(
    '/cloud/api/pairing-code',
    asyncRoute(async (req, res) => {
      if (!originRequired(req, res, auth.origin)) return;
      const userId = await requireSession(req, res);
      if (!userId) return;
      const code = gateway.createPairingCode({ identity: { userId, scopes: ['easyeda.read'] } });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ code, expiresInSeconds: 600 });
    }),
  );
  app.delete(
    '/cloud/api/extensions/:sessionId',
    asyncRoute(async (req, res) => {
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
    }),
  );
}

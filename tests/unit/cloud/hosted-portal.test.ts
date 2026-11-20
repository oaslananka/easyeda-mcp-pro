import * as http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import type { HostedAuth } from '../../../src/cloud/hosted-auth.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import { RemoteAuditLog } from '../../../src/remote/observability.js';
import { HostedUsageStore } from '../../../src/cloud/usage.js';
import { REMOTE_RELAY_PROTOCOL_VERSION } from '../../../src/remote/protocol.js';
import { createHttpTransport } from '../../../src/server/transports/http.js';
import { CLOUD_CSS, CLOUD_JS } from '../../../src/cloud/portal-assets.js';

function fakeProvider(origin: string): HostedAuth {
  return {
    origin,
    options: {},
    handler: async () => new Response(null, { status: 404 }),
    getSessionUser: async (headers: Headers) =>
      headers.get('cookie') === 'session=owner-a'
        ? { id: 'owner-a', name: 'Test Owner', email: 'example@example.com' }
        : headers.get('cookie') === 'session=owner-b'
          ? { id: 'owner-b', name: 'Second Owner', email: 'other@example.com' }
          : null,
    listClientConsents: async () => [],
    verifySignedQuery: async (query: string) =>
      [
        'client_id=valid&scope=easyeda.read&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid',
        'client_id=valid&scope=easyeda.read%20easyeda.write%20easyeda.export%20easyeda.project_admin%20unknown%3Csvg%3E&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid',
        'client_id=valid&scope=__proto__&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid',
      ].includes(query),
    getClient: async (_clientId: string, headers: Headers) =>
      headers.get('cookie') === 'session=owner-a'
        ? { name: '<script>alert(1)</script>', redirectUri: 'https://client.example/callback' }
        : null,
  } as HostedAuth;
}

async function withPortal(
  callback: (base: string, gateway: RemoteGateway, usage: HostedUsageStore) => Promise<void>,
): Promise<void> {
  const unused = createNetServer();
  await new Promise<void>((resolve) => unused.listen(0, '127.0.0.1', resolve));
  const unusedAddress = unused.address();
  if (!unusedAddress || typeof unusedAddress === 'string') throw new Error('No port');
  const port = unusedAddress.port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    TRANSPORT: 'http',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: port,
    OAUTH_ENABLED: true,
    OAUTH_ISSUER: `${origin}/api/auth`,
    OAUTH_AUDIENCE: `${origin}/mcp`,
    OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
  });
  const database = new DatabaseSync(':memory:');
  const usage = new HostedUsageStore(database);
  const gateway = new RemoteGateway({
    audit: new RemoteAuditLog(200, (event) => {
      usage.record(event);
    }),
  });
  const transport = createHttpTransport(config, {
    gateway,
    hostedAuth: fakeProvider(origin),
    hostedUsage: usage,
  });
  const server = http.createServer(transport.app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await callback(origin, gateway, usage);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
}

describe('Hosted owner tool-call usage', () => {
  it('requires the real signed-in owner and excludes other owners and blocked calls', async () => {
    await withPortal(async (base, gateway) => {
      const ownerA = { userId: 'owner-a', mode: 'hosted' as const };
      gateway.audit.record({ ...ownerA, event: 'remote.tool.requested', toolName: 'read' });
      gateway.audit.record({ ...ownerA, event: 'remote.identity.rejected', status: 'rejected' });
      gateway.audit.record({
        ...ownerA,
        event: 'remote.tool.completed',
        toolName: 'easyeda_pcb_components',
        status: 'ok',
        durationMs: 42,
        observedAt: '2026-11-15T18:00:00.000Z',
      });
      gateway.audit.record({
        ...ownerA,
        event: 'remote.tool.failed',
        toolName: 'easyeda_schematic_components',
        status: 'error',
        durationMs: 70,
        observedAt: '2026-11-15T18:00:01.000Z',
      });
      gateway.audit.record({
        userId: 'owner-b',
        mode: 'hosted',
        event: 'remote.tool.completed',
        status: 'ok',
      });
      gateway.audit.record({
        userId: 'owner-a',
        mode: 'self_hosted',
        event: 'remote.tool.completed',
        status: 'ok',
      });

      const check = (cookie?: string) =>
        fetch(`${base}/cloud/api/usage`, {
          headers: cookie ? { cookie } : {},
        });
      const unauthorized = await check();
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('cache-control')).toBe('no-store');

      const a = await check('session=owner-a');
      expect(a.status).toBe(200);
      expect(a.headers.get('cache-control')).toBe('no-store');
      expect(await a.json()).toEqual({
        total: 2,
        succeeded: 1,
        failed: 1,
        lastCallAt: '2026-11-15T18:00:01.000Z',
      });
      const b = await check('session=owner-b');
      expect(await b.json()).toEqual({
        total: 1,
        succeeded: 1,
        failed: 0,
        lastCallAt: expect.any(String),
      });

      const dashboard = await fetch(`${base}/cloud`, { headers: { cookie: 'session=owner-a' } });
      expect(await dashboard.text()).toContain('id="usage-total"');
    });
  });
});

describe('Hosted Cloud browser recovery', () => {
  async function runWorkspace(
    fetcher: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  ) {
    const redirects: string[] = [];
    const elements = new Map<string, any>();
    const intervals = new Map<number, { delay: number; callback: () => void }>();
    const windowListeners = new Map<string, () => void>();
    const documentListeners = new Map<string, () => void>();
    let nextTimerId = 0;
    const documentState = { hidden: false };
    function fakeElement() {
      return {
        textContent: '',
        className: '',
        dataset: {} as Record<string, string>,
        children: [] as any[],
        classList: { add() {}, remove() {} },
        attributes: {} as Record<string, string>,
        setAttribute(this: { attributes: Record<string, string> }, name: string, value: string) {
          this.attributes[name] = value;
        },
        replaceChildren(this: { children: any[] }, ...nodes: any[]) {
          this.children = nodes;
        },
        appendChild(this: { children: any[] }, node: any) {
          this.children.push(node);
        },
        listeners: new Map<string, () => Promise<void> | void>(),
        addEventListener(
          this: { listeners: Map<string, () => Promise<void> | void> },
          event: string,
          callback: () => Promise<void> | void,
        ) {
          this.listeners.set(event, callback);
        },
        async dispatch(
          this: { listeners: Map<string, () => Promise<void> | void> },
          event: string,
        ) {
          await this.listeners.get(event)?.();
        },
      };
    }
    const root = fakeElement();
    root.dataset.page = 'account';
    elements.set('cloud-root', root);
    elements.set('notice', fakeElement());
    elements.set('clients', fakeElement());
    elements.set('extensions', fakeElement());
    elements.set('account-name', fakeElement());
    elements.set('pairing-hint', fakeElement());
    runInNewContext(CLOUD_JS, {
      document: {
        get hidden() {
          return documentState.hidden;
        },
        getElementById: (id: string) => {
          if (!elements.has(id)) elements.set(id, fakeElement());
          return elements.get(id);
        },
        createElement: () => fakeElement(),
        addEventListener: (name: string, callback: () => void) => {
          documentListeners.set(name, callback);
        },
        removeEventListener: (name: string) => {
          documentListeners.delete(name);
        },
      },
      window: {
        location: {
          search: '',
          origin: 'https://easyeda-mcp-pro.oaslananka.dev',
          assign: (url: string) => redirects.push(url),
        },
        btoa: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
        addEventListener: (name: string, callback: () => void) => {
          windowListeners.set(name, callback);
        },
        removeEventListener: (name: string) => {
          windowListeners.delete(name);
        },
      },
      setInterval: (callback: () => void, delay: number) => {
        const timer = ++nextTimerId;
        intervals.set(timer, { callback, delay });
        return timer;
      },
      clearInterval: (timer: number) => {
        intervals.delete(timer);
      },
      fetch: fetcher,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      redirects,
      notice: elements.get('notice') as { textContent: string },
      elements,
      async tickUsage() {
        const tasks = [...intervals.values()].filter((timer) => timer.delay === 30000);
        for (const timer of tasks) timer.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      setHidden(hidden: boolean) {
        documentState.hidden = hidden;
      },
      async visibilityChange() {
        documentListeners.get('visibilitychange')?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      async focus() {
        windowListeners.get('focus')?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      leave() {
        windowListeners.get('pagehide')?.();
      },
      activeUsageTimers() {
        return [...intervals.values()].filter((t) => t.delay === 30000).length;
      },
    };
  }

  it('guides new users from AI choice through device selection and a read-only first question', async () => {
    let sessions: any[] = [];
    let selection: any = null;
    let clients: any[] = [];
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'QA owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions, selection }) };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      throw Error('Unexpected request ' + url);
    });
    expect(result.elements.get('guided-device-status').textContent).toBe('Not connected');
    expect(result.elements.get('guided-title').textContent).toBe('Start using EasyEDA MCP Pro');
    expect(result.elements.get('guided-kicker').textContent).toBe('FIRST CONNECTION');
    expect(result.elements.get('guided-connect-link').textContent).toBe('Connect EasyEDA ↓');
    expect(result.elements.get('guided-access-status').textContent).toBe(
      'No MCP client authorized yet',
    );
    expect(result.elements.get('progress-device').dataset.state).toBe('current');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);

    await result.elements.get('client-cursor').dispatch('click');
    const cursorLink = result.elements.get('open-client').href as string;
    expect(cursorLink).toContain('cursor://anysphere.cursor-deeplink/mcp/install?');
    const cursorConfig = new URLSearchParams(cursorLink.split('?')[1]).get('config') || '';
    expect(JSON.parse(Buffer.from(cursorConfig, 'base64').toString())).toEqual({
      url: 'https://easyeda-mcp-pro.oaslananka.dev/mcp',
    });
    expect(result.elements.get('client-cursor').attributes['aria-pressed']).toBe('true');
    await result.elements.get('client-codex').dispatch('click');
    expect(result.elements.get('client-config').textContent).toBe(
      'codex mcp add easyeda-mcp-pro --url https://easyeda-mcp-pro.oaslananka.dev/mcp',
    );

    sessions = [
      {
        sessionId: 'qa-session',
        connected: true,
        extensionVersion: '1.16.1',
        mode: 'hosted',
        activeProject: { projectId: 'qa', documentId: 'P1', documentType: 'schematic' },
      },
    ];
    // A connected device with no explicit native selection must still ask
    // for a design; do not imply that the MCP connection is ready.
    await result.elements.get('refresh-extensions').dispatch('click');
    expect(result.elements.get('guided-title').textContent).toBe('Choose your open design');
    expect(result.elements.get('guided-kicker').textContent).toBe('SELECT A DESIGN');
    expect(result.elements.get('guided-connect-link').textContent).toBe('Choose the open design ↓');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);

    selection = { sessionId: 'qa-session', projectId: 'qa', documentId: 'P1' };
    await result.elements.get('refresh-extensions').dispatch('click');
    expect(result.elements.get('guided-title').textContent).toBe('Connect your AI assistant');
    expect(result.elements.get('guided-kicker').textContent).toBe('AUTHORIZE ACCESS');
    expect(result.elements.get('guided-connect-link').textContent).toBe('View selected design ↓');
    expect(result.elements.get('guided-device-status').textContent).toBe(
      'Connected · design selected',
    );
    expect(result.elements.get('progress-device').dataset.state).toBe('done');
    expect(result.elements.get('progress-access').dataset.state).toBe('current');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);

    clients = [{ id: 'qa-client', name: 'MCP Inspector', scopes: ['easyeda.read'] }];
    await result.elements.get('refresh-clients').dispatch('click');
    expect(result.elements.get('progress-access').dataset.state).toBe('current');
    expect(result.elements.get('progress-ask').dataset.state).toBe('waiting');
    expect(result.elements.get('guided-access-status').textContent).toContain('MCP Inspector');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);
    await result.elements.get('client-other').dispatch('click');
    expect(result.elements.get('guided-title').textContent).toBe('Your EasyEDA workspace');
    expect(result.elements.get('guided-kicker').textContent).toBe('DESIGN SELECTED');
    expect(result.elements.get('guided-connect-link').textContent).toBe('View selected design ↓');
    expect(result.elements.get('progress-access').dataset.state).toBe('done');
    expect(result.elements.get('progress-ask').dataset.state).toBe('current');
    expect(result.elements.get('copy-first-question').disabled).toBe(false);
    clients = [];
    await result.elements.get('refresh-clients').dispatch('click');
    expect(result.elements.get('guided-title').textContent).toBe('Connect your AI assistant');
    expect(result.elements.get('guided-kicker').textContent).toBe('AUTHORIZE ACCESS');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);

    // Returning owners who are temporarily offline need reconnect guidance,
    // not an incorrect "first connection" or "selected" confirmation.
    sessions = [{ ...sessions[0], connected: false }];
    selection = null;
    await result.elements.get('refresh-extensions').dispatch('click');
    expect(result.elements.get('guided-title').textContent).toBe('Reconnect EasyEDA');
    expect(result.elements.get('guided-kicker').textContent).toBe('RECONNECT');
    expect(result.elements.get('guided-connect-link').textContent).toBe('Reconnect EasyEDA ↓');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);
  });

  it('does not tell a selected AI client it is ready when only another client has Read access', async () => {
    let consents = [{ id: 'jam', name: 'MCPJam', scopes: ['easyeda.read'] }];
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Owner' } }) };
      if (url === '/cloud/api/extensions')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                sessionId: 'sess_qa',
                connected: true,
                mode: 'hosted',
                extensionVersion: '1.16.1',
                activeProject: { projectId: 'qa', documentId: 'P1', documentType: 'schematic' },
              },
            ],
            selection: { sessionId: 'sess_qa', projectId: 'qa', documentId: 'P1' },
          }),
        };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: consents }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      throw Error('Unexpected request ' + url);
    });
    // Default ChatGPT must not inherit authorization from an unrelated MCPJam client.
    expect(result.elements.get('guided-hint').textContent).toContain('ChatGPT');
    expect(result.elements.get('guided-hint').textContent).toContain('not listed');
    expect(result.elements.get('guided-access-status').textContent).toContain('MCPJam');
    expect(result.elements.get('progress-ask').dataset.state).toBe('waiting');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);

    // Choosing Other is an explicit escape hatch for custom-named clients.
    await result.elements.get('client-other').dispatch('click');
    expect(result.elements.get('copy-first-question').disabled).toBe(false);
    expect(result.elements.get('progress-ask').dataset.state).toBe('current');
    expect(result.elements.get('guided-hint').textContent).toContain(
      'Read access is listed for MCPJam',
    );
    expect(result.elements.get('guided-hint').textContent).not.toContain('named MCP client');

    // Switching to Cursor resets readiness until it has its own named consent.
    await result.elements.get('client-cursor').dispatch('click');
    expect(result.elements.get('guided-hint').textContent).toContain('Cursor');
    expect(result.elements.get('copy-first-question').disabled).toBe(true);
    consents = [
      { id: 'jam', name: 'MCPJam', scopes: ['easyeda.read'] },
      { id: 'cursor', name: 'Cursor', scopes: ['easyeda.read'] },
    ];
    await result.elements.get('refresh-clients').dispatch('click');
    expect(result.elements.get('copy-first-question').disabled).toBe(false);
    expect(result.elements.get('progress-ask').dataset.state).toBe('current');
    expect(result.elements.get('guided-hint').textContent).toContain('Cursor');
  });

  it('renders persistent owner call totals and refreshes them without reloading', async () => {
    let usage = { total: 4, succeeded: 3, failed: 1, lastCallAt: '2026-11-15T18:00:00Z' };
    let requests = 0;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me') {
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      }
      if (url === '/cloud/api/extensions') {
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      }
      if (url === '/cloud/api/clients') {
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      }
      if (url === '/cloud/api/usage') {
        requests += 1;
        return { ok: true, status: 200, json: async () => usage };
      }
      throw new Error('Unexpected test request');
    });
    expect(requests).toBe(1);
    expect(result.elements.get('usage-total').textContent).toBe('4');
    expect(result.elements.get('usage-success').textContent).toBe('3');
    expect(result.elements.get('usage-failed').textContent).toBe('1');

    usage = { total: 5, succeeded: 4, failed: 1, lastCallAt: '2026-11-15T18:05:00Z' };
    await result.elements.get('refresh-usage').dispatch('click');
    expect(requests).toBe(2);
    expect(result.elements.get('usage-total').textContent).toBe('5');
    expect(result.elements.get('usage-hint').textContent).toContain('Last completed call');
    expect(result.redirects).toEqual([]);
  });

  it('updates the owner counter in the foreground without polling hidden or departed pages', async () => {
    let count = 0;
    let total = 2;
    let slowNextUsage: Promise<void> | undefined;
    let resumeUsage: (() => void) | undefined;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me') {
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      }
      if (url === '/cloud/api/extensions') {
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      }
      if (url === '/cloud/api/clients') {
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      }
      if (url === '/cloud/api/usage') {
        count += 1;
        if (slowNextUsage) {
          const pause = slowNextUsage;
          slowNextUsage = undefined;
          await pause;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ total, succeeded: total, failed: 0, lastCallAt: null }),
        };
      }
      throw new Error('Unexpected test request');
    });
    expect(result.activeUsageTimers()).toBe(1);
    expect(count).toBe(1);
    total = 3;
    await result.tickUsage();
    expect(count).toBe(2);
    expect(result.elements.get('usage-total').textContent).toBe('3');

    result.setHidden(true);
    await result.tickUsage();
    expect(count).toBe(2);
    result.setHidden(false);
    total = 4;
    await result.tickUsage();
    expect(count).toBe(3);
    expect(result.elements.get('usage-total').textContent).toBe('4');

    slowNextUsage = new Promise<void>((resolve) => {
      resumeUsage = resolve;
    });
    total = 5;
    await result.tickUsage();
    expect(count).toBe(4);
    // A scheduled request in progress must not be duplicated by manual refresh.
    await result.elements.get('refresh-usage').dispatch('click');
    await result.tickUsage();
    expect(count).toBe(4);
    resumeUsage?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.elements.get('usage-total').textContent).toBe('5');

    result.leave();
    expect(result.activeUsageTimers()).toBe(0);
    total = 6;
    await result.tickUsage();
    expect(count).toBe(4);
  });

  it('refreshes live device state and clears a stale paired indicator while the tab is visible', async () => {
    let online = true;
    let sessionId = 'sess_disposable';
    let deviceRequests = 0;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions') {
        deviceRequests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                sessionId,
                connected: online,
                mode: 'hosted',
                extensionVersion: '1.15.6',
                activeProject: {
                  projectId: 'disposable-project',
                  documentId: 'pcb-1',
                  projectName: 'Disposable PCB',
                  documentType: 'pcb',
                },
              },
            ],
            selection: {
              sessionId: 'sess_disposable',
              projectId: 'disposable-project',
              documentId: 'pcb-1',
            },
          }),
        };
      }
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total: 0,
            succeeded: 0,
            failed: 0,
            lastCallAt: null,
          }),
        };
      throw new Error('Unexpected test request: ' + url);
    });
    const getStatus = () => result.elements.get('extensions').children[0].children[0].children[2];
    const pairing = result.elements.get('pairing-code');
    const hint = result.elements.get('pairing-hint');
    expect(deviceRequests).toBe(1);
    expect(getStatus().textContent).toBe('Connected');
    // Simulate a completed prior pairing whose success message remains on screen.
    pairing.textContent = 'Connected';
    hint.textContent = 'Your EasyEDA device is connected.';
    online = false;
    await result.tickUsage();
    expect(deviceRequests).toBe(2);
    expect(getStatus().textContent).toBe('Disconnected');
    expect(getStatus().className).toContain('off');
    expect(pairing.textContent).toBe('Disconnected');
    expect(hint.textContent).toContain('can reconnect automatically');
    expect(
      result.elements
        .get('extensions')
        .children[0].children.some((child) => child.textContent === 'Selected PCB'),
    ).toBe(false);

    result.setHidden(true);
    online = true;
    // A verified device resume uses a fresh relay session, not the old selection.
    sessionId = 'sess_disposable_reconnected';
    await result.tickUsage();
    expect(deviceRequests).toBe(2);
    expect(getStatus().textContent).toBe('Disconnected');
    result.setHidden(false);
    await result.tickUsage();
    expect(deviceRequests).toBe(3);
    expect(getStatus().textContent).toBe('Connected');
    expect(pairing.textContent).toBe('Connected');
    expect(hint.textContent).toContain('no new pairing code is needed');
    const card = result.elements.get('extensions').children[0];
    expect(card.children.some((child) => child.textContent === 'Use this PCB')).toBe(true);
    expect(card.children.some((child) => child.textContent === 'Selected PCB')).toBe(false);
  });

  it('shows an expired device as offline with an actionable reconnect hint and no stale selection', async () => {
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Owner' } }) };
      if (url === '/cloud/api/extensions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                sessionId: 'sess_expired',
                connected: false,
                expiresAt: '2020-01-01T00:00:00.000Z',
                mode: 'hosted',
                extensionVersion: '1.16.0',
                activeProject: {
                  projectId: 'private-project',
                  documentId: 'private-document',
                  projectName: 'Disposable PCB',
                  documentType: 'pcb',
                },
              },
            ],
            selection: null,
          }),
        };
      }
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total: 0,
            succeeded: 0,
            failed: 0,
            lastCallAt: null,
          }),
        };
      throw Error('Unexpected request: ' + url);
    });
    expect(result.elements.get('device-count').textContent).toBe('0 connected');
    // A single offline device remains directly accessible for easy revocation;
    // only two or more offline devices are grouped in Previous connections.
    const card = result.elements.get('extensions').children[0];
    expect(card.children[0].children[2].textContent).toBe('Session expired');
    expect(card.children[0].children[3].textContent).toContain('Select the document again');
    expect(
      card.children.some((item: { textContent: string }) => item.textContent === 'Selected PCB'),
    ).toBe(false);
    expect(card.children[1].textContent).toBe('Remove access');
  });

  it('prioritizes connected devices and keeps old pairings removable without losing expansion on refresh', async () => {
    let sessions = [
      {
        sessionId: 'live',
        connected: true,
        mode: 'hosted',
        extensionVersion: '1.15.7',
        activeProject: {
          projectId: 'pcb',
          documentId: 'doc',
          projectName: 'Current PCB',
          documentType: 'pcb',
        },
      },
      {
        sessionId: 'old-a',
        connected: false,
        mode: 'hosted',
        extensionVersion: '1.15.6',
        activeProject: { projectName: 'Previous PCB' },
      },
      {
        sessionId: 'old-b',
        connected: false,
        mode: 'hosted',
        extensionVersion: '1.15.6',
        activeProject: { projectName: 'Previous PCB' },
      },
    ];
    const removed: string[] = [];
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions, selection: null }) };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      if (url.startsWith('/cloud/api/extensions/')) {
        const sessionId = decodeURIComponent(url.slice('/cloud/api/extensions/'.length));
        removed.push(sessionId);
        sessions = sessions.filter((s) => s.sessionId !== sessionId);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw Error('Unexpected request: ' + url);
    });
    const list = result.elements.get('extensions');
    expect(result.elements.get('device-count').textContent).toBe('1 connected');
    expect(list.children).toHaveLength(2);
    expect(list.children[0].children[0].children[0].textContent).toBe('Current PCB');
    const history = list.children[1];
    expect(history.className).toBe('device-history');
    expect(history.children[0].textContent).toBe('Previous connections (2)');
    expect(history.open).toBe(false);
    expect(history.children[2].children[1].textContent).toBe('Remove access');
    history.open = true;
    await history.dispatch('toggle');
    await result.elements.get('refresh-extensions').dispatch('click');
    expect(list.children[1].open).toBe(true);
    const removeOld = list.children[1].children[2].children[1];
    await removeOld.dispatch('click');
    expect(removed).toEqual([]);
    expect(removeOld.textContent).toBe('Confirm removal');
    await removeOld.dispatch('click');
    expect(removed).toEqual(['old-a']);
    expect(list.children[1].children[0].textContent).toBe('Previous connections (1)');
    expect(list.children[1].open).toBe(true);
    expect(result.elements.get('device-count').textContent).toBe('1 connected');
    expect(result.redirects).toEqual([]);
  });

  it('requires a deliberate second step to revoke a live device, and permits cancellation', async () => {
    const removed: string[] = [];
    let sessions = [
      {
        sessionId: 'live',
        connected: true,
        mode: 'hosted',
        extensionVersion: '1.15.7',
        activeProject: {
          projectId: 'pcb',
          documentId: 'doc',
          projectName: 'Disposable PCB',
          documentType: 'pcb',
        },
      },
    ];
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions, selection: null }) };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      if (url === '/cloud/api/extensions/live') {
        removed.push('live');
        sessions = [];
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw Error('Unexpected request: ' + url);
    });
    const list = result.elements.get('extensions');
    const activeDevice = list.children[0];
    const remove = activeDevice.children[2];
    expect(remove.textContent).toBe('Remove access');
    await remove.dispatch('click');
    expect(removed).toEqual([]);
    expect(remove.textContent).toBe('Confirm removal');
    const confirmation = activeDevice.children[3];
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.children[0].textContent).toContain('disconnect');
    await confirmation.children[1].dispatch('click');
    expect(remove.textContent).toBe('Remove access');
    expect(confirmation.hidden).toBe(true);
    expect(removed).toEqual([]);
    await remove.dispatch('click');
    await remove.dispatch('click');
    expect(removed).toEqual(['live']);
    expect(list.children[0].textContent).toContain('No devices connected');
    expect(result.notice.textContent).toBe('Extension access removed.');
  });

  it('shows reconnect guidance before collapsed old sessions when every device is offline', async () => {
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: ['old-a', 'old-b'].map((sessionId) => ({
              sessionId,
              connected: false,
              mode: 'hosted',
              extensionVersion: '1.15.6',
            })),
            selection: null,
          }),
        };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      throw Error('Unexpected request: ' + url);
    });
    const list = result.elements.get('extensions');
    expect(result.elements.get('device-count').textContent).toBe('0 connected');
    expect(result.elements.get('workspace-grid').dataset.empty).toBe('true');
    expect(result.elements.get('guided-device-status').textContent).toContain(
      'Saved pairing offline',
    );
    expect(result.elements.get('guided-hint').textContent).toContain('saved pairing');
    expect(result.elements.get('guided-hint').textContent).not.toContain('install the bridge');
    expect(result.elements.get('guided-connect-link').textContent).toContain('Reconnect EasyEDA');
    expect(result.elements.get('guided-connect-link').href).toBe('#extensions-title');
    expect(list.children[0].textContent).toContain('Reopen EasyEDA');
    expect(list.children[1].children[0].textContent).toBe('Previous connections (2)');
    expect(list.children[1].children[2].children[1].textContent).toBe('Remove access');
  });

  it('shows a recovery path for a blocked Cloud/Access fetch instead of redirecting to sign-in', async () => {
    const result = await runWorkspace(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(result.redirects).toEqual([]);
    expect(result.notice.textContent).toContain('Cannot reach EasyEDA Cloud');
    expect(result.notice.textContent).toContain('separate access sign-in');
  });

  it('still redirects an actually unauthenticated owner to sign-in', async () => {
    const result = await runWorkspace(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Authentication required' }),
    }));
    expect(result.redirects).toEqual(['/sign-in']);
  });

  it('keeps Refresh functional after a failed initial device request and clears the error on recovery', async () => {
    let deviceRequests = 0;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === '/cloud/api/extensions') {
        deviceRequests += 1;
        if (deviceRequests === 1) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      }
      throw new Error('Unexpected test request');
    });
    expect(deviceRequests).toBe(1);
    expect(result.notice.textContent).toContain('Cannot reach EasyEDA Cloud');
    await result.elements.get('refresh-extensions').dispatch('click');
    expect(deviceRequests).toBe(2);
    expect(result.notice.textContent).toBe('Device connections updated.');
    expect(result.redirects).toEqual([]);
  });

  it('shows which connected OAuth clients are read-only and how to request full scopes', async () => {
    const clients = [
      { id: 'read-client', name: 'Read-only agent', scopes: ['openid', 'easyeda.read'] },
      {
        id: 'full-client',
        name: 'Full-scope agent',
        scopes: ['easyeda.read', 'easyeda.write', 'easyeda.export'],
      },
    ];
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      if (url === '/cloud/api/clients')
        return { ok: true, status: 200, json: async () => ({ clients }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      throw new Error('Unexpected test request');
    });
    const cards = result.elements.get('clients').children;
    expect(cards).toHaveLength(2);
    const readInfo = cards[0].children[0].children;
    expect(readInfo[0].textContent).toBe('Read-only agent');
    expect(readInfo[1].textContent).toBe('Read');
    expect(readInfo[1].className).toContain('limited');
    expect(readInfo[2].textContent).toContain('easyeda.write and easyeda.export');
    expect(readInfo[2].textContent).toContain('reconnect from your MCP client');
    const fullInfo = cards[1].children[0].children;
    expect(fullInfo[1].textContent).toBe('Read · Write · Export');
    expect(fullInfo[1].className).not.toContain('limited');
    expect(fullInfo[2].textContent).toContain('once per project session for routine edits');
    const readAccess = cards[0].children[1].children;
    expect(readAccess[0].textContent).toBe('Manage access');
    expect(readAccess[1].children.map((x: { textContent: string }) => x.textContent)).toEqual([
      'Read ✓',
      'Write —',
      'Export —',
      'Admin —',
    ]);
    expect(readAccess[2].textContent).toContain('reconnect your MCP client');
    expect(readAccess[3].textContent).toBe('Revoke access');
  });

  it('requires an explicit second click before revoking client access', async () => {
    let revocations = 0;
    let authorized = true;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total: 0,
            succeeded: 0,
            failed: 0,
            lastCallAt: null,
          }),
        };
      if (url === '/cloud/api/clients') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            clients: authorized
              ? [{ id: 'read-client', name: 'Read-only agent', scopes: ['easyeda.read'] }]
              : [],
          }),
        };
      }
      if (url === '/api/auth/oauth2/delete-consent') {
        revocations += 1;
        authorized = false;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw Error('Unexpected request: ' + url);
    });
    const button = result.elements.get('clients').children[0].children[1].children[3];
    await button.dispatch('click');
    expect(revocations).toBe(0);
    expect(button.textContent).toBe('Confirm revoke');
    await button.dispatch('click');
    expect(revocations).toBe(1);
    expect(result.elements.get('clients').children[0].textContent).toBe(
      'No MCP clients have your authorization yet.',
    );
    expect(result.notice.textContent).toContain('MCP client access revoked.');
  });

  it('updates OAuth client permissions when returning from consent without background polling', async () => {
    let authorized = false;
    let requests = 0;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'QA owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      if (url === '/cloud/api/clients') {
        requests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            clients: authorized
              ? [{ id: 'oauth-qa', name: 'MCP QA client', scopes: ['easyeda.read'] }]
              : [],
          }),
        };
      }
      if (url === '/cloud/api/usage')
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: 0, succeeded: 0, failed: 0, lastCallAt: null }),
        };
      throw Error('Unexpected request ' + url);
    });
    expect(requests).toBe(1);
    expect(result.elements.get('clients').children[0].textContent).toBe(
      'No MCP clients have your authorization yet.',
    );
    result.setHidden(true);
    authorized = true; // Consent was granted in another browser tab.
    await result.visibilityChange();
    await result.tickUsage();
    expect(requests).toBe(1);

    result.setHidden(false);
    await result.visibilityChange();
    expect(requests).toBe(2);
    expect(result.elements.get('clients').children[0].children[0].children[0].textContent).toBe(
      'MCP QA client',
    );
    await result.focus();
    expect(requests).toBe(3);
    authorized = false; // Consent was revoked in another browser tab.
    await result.tickUsage();
    expect(requests).toBe(4);
    expect(result.elements.get('clients').children[0].textContent).toBe(
      'No MCP clients have your authorization yet.',
    );
    result.leave();
    await result.focus();
    await result.visibilityChange();
    expect(requests).toBe(4);
    expect(result.activeUsageTimers()).toBe(0);
  });

  it('lets a signed-in owner retry MCP client permissions without reloading the pairing page', async () => {
    let clientRequests = 0;
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me')
        return { ok: true, status: 200, json: async () => ({ user: { name: 'Fixture Owner' } }) };
      if (url === '/cloud/api/extensions')
        return { ok: true, status: 200, json: async () => ({ sessions: [], selection: null }) };
      if (url === '/cloud/api/clients') {
        clientRequests += 1;
        if (clientRequests === 1) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      }
      throw new Error('Unexpected test request');
    });
    expect(clientRequests).toBe(1);
    await result.elements.get('refresh-clients').dispatch('click');
    expect(clientRequests).toBe(2);
    expect(result.notice.textContent).toBe('MCP client permissions updated.');
    expect(result.redirects).toEqual([]);
  });

  it('does not erase a valid owner session when only the device-list fetch fails', async () => {
    const result = await runWorkspace(async (url) => {
      if (url === '/cloud/api/me') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { name: 'Fixture Owner' } }),
        };
      }
      if (url === '/cloud/api/clients') {
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      }
      throw new TypeError('Failed to fetch');
    });
    expect(result.redirects).toEqual([]);
    expect(result.notice.textContent).toContain('Cannot reach EasyEDA Cloud');
  });
});

describe('Hosted Cloud browser portal', () => {
  it('renders discoverable GitHub and Google sign-in with strict executable asset CSP', async () => {
    await withPortal(async (base) => {
      const landing = await fetch(base + '/');
      const landingHtml = await landing.text();
      expect(landing.status).toBe(200);
      expect(landing.headers.get('content-type')).toContain('text/html');
      expect(landing.headers.get('cache-control')).toContain('no-store');
      expect(landingHtml).toContain('Connect EasyEDA Pro to your MCP client.');
      expect(landingHtml).toContain('Continue with GitHub');
      expect(landingHtml).toContain('Continue with Google');
      const signedLanding = await fetch(base + '/', {
        headers: { cookie: 'session=owner-a' },
      });
      expect(signedLanding.status).toBe(200);
      const signedHtml = await signedLanding.text();
      expect(signedHtml).toContain('Your devices');
      expect(signedHtml).toContain('id="refresh-clients"');
      for (const client of ['chatgpt', 'claude', 'cursor', 'codex', 'other']) {
        expect(signedHtml).toContain('id="client-' + client + '"');
      }
      expect(signedHtml).toContain('aria-label="Connection progress"');
      expect(signedHtml).toContain('id="copy-first-question"');
      expect(signedHtml).toContain('id="pair-title"');
      // Setup text must have one flexible text column: bare text/strong children
      // of a flex row shrink into separate narrow columns on a desktop card.
      expect(signedHtml.match(/class="step-copy"/g)).toHaveLength(3);
      expect(CLOUD_CSS).toContain('grid-template-columns:26px minmax(0,1fr)');
      expect(CLOUD_CSS).toContain('.setup-steps .step-copy{min-width:0');
      expect(signedHtml).toContain(
        'https://github.com/oaslananka/easyeda-mcp-pro/releases/latest/download/easyeda-bridge-extension.eext',
      );

      const login = await fetch(`${base}/sign-in`);
      const html = await login.text();
      expect(login.status).toBe(200);
      expect(html).toContain('Continue with GitHub');
      expect(html).toContain('Continue with Google');
      const cssHash = createHash('sha256').update(CLOUD_CSS).digest('hex').slice(0, 12);
      const jsHash = createHash('sha256').update(CLOUD_JS).digest('hex').slice(0, 12);
      expect(html).toContain(`href="/assets/easyeda-cloud.css?v=${cssHash}"`);
      expect(html).toContain(`src="/assets/easyeda-cloud.js?v=${jsHash}"`);
      expect(login.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(login.headers.get('cache-control')).toContain('no-store');
      // Public entry-point resources cannot require the owner-only /cloud* preview gate.
      const publicCss = await fetch(base + '/assets/easyeda-cloud.css');
      expect(publicCss.status).toBe(200);
      expect(publicCss.headers.get('content-type')).toContain('text/css');
      expect(await publicCss.text()).toBe(CLOUD_CSS);
      const publicJs = await fetch(base + '/assets/easyeda-cloud.js');
      expect(publicJs.status).toBe(200);
      expect(publicJs.headers.get('content-type')).toContain('javascript');
      expect(await publicJs.text()).toContain('oauth_query');
      expect(await (await fetch(`${base}/cloud/app.js`)).text()).toContain('oauth_query');
      expect((await fetch(`${base}/cloud`, { redirect: 'manual' })).status).toBe(303);
      const noAuth = await fetch(`${base}/cloud/api/me`);
      expect(noAuth.status).toBe(401);
      const mcpWithoutBearer = await fetch(base + '/mcp');
      expect(mcpWithoutBearer.status).toBe(401);
      await expect(mcpWithoutBearer.json()).resolves.toMatchObject({ code: 'missing_auth' });
    });
  });

  it('blocks unsigned, modified or anonymous consent and never interprets client HTML', async () => {
    await withPortal(async (base) => {
      const tampered = await fetch(`${base}/consent?client_id=valid&scope=easyeda.write&sig=valid`);
      expect(tampered.status).toBe(400);
      const query =
        'client_id=valid&scope=easyeda.read&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid';
      const anonymous = await fetch(`${base}/consent?${query}`);
      expect(anonymous.status).toBe(401);
      const signed = await fetch(`${base}/consent?${query}`, {
        headers: { cookie: 'session=owner-a' },
      });
      const html = await signed.text();
      expect(signed.status).toBe(200);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('easyeda.read');
      expect(html).toContain('Read your selected design');
      expect(html).toContain('No editing is permitted by this scope.');
      expect(html).toContain('name="cloud-scope" value="easyeda.read" checked');
      expect(html).toContain('client.example');
    });
  });

  it('explains write, export and high-risk grants without hiding their exact scope codes', async () => {
    await withPortal(async (base) => {
      const query =
        'client_id=valid&scope=easyeda.read%20easyeda.write%20easyeda.export%20easyeda.project_admin%20unknown%3Csvg%3E&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid';
      const response = await fetch(base + '/consent?' + query, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('More permissions (optional)');
      expect(html).toContain('class="consent-advanced"');
      expect(html).toContain('Start with Read access');
      expect(html).toContain('Request design changes');
      expect(html).toContain(
        'Routine edits need one EasyEDA project-session approval for up to 30 minutes',
      );
      expect(html).toContain('Export design files');
      expect(html).toContain(
        'Local artifact exports can share a separate 30-minute EasyEDA project-session approval',
      );
      expect(html).toContain('Request high-risk project actions');
      expect(html).toContain(
        'Destructive operations require stronger approval; unsupported actions remain blocked.',
      );
      for (const scope of [
        'easyeda.read',
        'easyeda.write',
        'easyeda.export',
        'easyeda.project_admin',
      ])
        expect(html).toContain('<code>' + scope + '</code>');
      expect(html).toContain('Other requested permission');
      expect(html).toContain('<code>unknown&lt;svg&gt;</code>');
      expect(html).toContain('name="cloud-scope" value="easyeda.read" checked');
      for (const scope of ['easyeda.write', 'easyeda.export', 'easyeda.project_admin']) {
        expect(html).toContain('name="cloud-scope" value="' + scope + '">');
        expect(html).not.toContain('name="cloud-scope" value="' + scope + '" checked');
      }
      expect(html).toContain('name="cloud-scope" value="unknown&lt;svg&gt;"');
      expect(html).toContain('Allow selected permissions');
      expect(html).not.toContain('<code>unknown<svg></code>');
      expect(html).toContain('data-consent="deny"');
    });
  });

  it('treats JavaScript prototype property names as unknown OAuth scopes', async () => {
    await withPortal(async (base) => {
      const query =
        'client_id=valid&scope=__proto__&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid';
      const response = await fetch(base + '/consent?' + query, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Other requested permission');
      expect(html).toContain('<code>__proto__</code>');
      expect(html).not.toContain('Request design changes');
    });
  });

  it('lets only the signed-in owner list, pair and revoke their extensions, with CSRF checks', async () => {
    await withPortal(async (base, gateway) => {
      const unpaired = gateway.registerExtension({
        connectionId: 'extension-1',
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: {
          projectId: 'board-a',
          documentId: 'pcb-a',
          projectName: 'Example board',
          documentType: 'pcb',
        },
        dispatch: async (message) => ({
          version: message.version,
          type: 'tool_response',
          requestId: message.requestId,
          ok: true,
          result: null,
        }),
      });
      const send = async (path: string, method: string, cookie: string, site = base) =>
        fetch(`${base}${path}`, {
          method,
          headers: { cookie, origin: site, 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        });
      const unauth = await send('/cloud/api/pairing-code', 'POST', '');
      expect(unauth.status).toBe(401);
      const foreignOrigin = await send(
        '/cloud/api/pairing-code',
        'POST',
        'session=owner-a',
        'https://attacker.example',
      );
      expect(foreignOrigin.status).toBe(403);

      const dashboard = await fetch(base + '/cloud', {
        headers: { cookie: 'session=owner-a' },
      });
      const dashboardHtml = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(dashboardHtml).toContain('id="copy-pairing"');
      expect(dashboardHtml).toMatch(/id="copy-pairing"[^>]*disabled hidden/);
      expect(dashboardHtml).toContain('id="pairing-hint"');
      expect(dashboardHtml).toContain('Allow interactive with external');
      expect(dashboardHtml).toContain('save your work and reload the EasyEDA tab');

      const codeRes = await send('/cloud/api/pairing-code', 'POST', 'session=owner-a');
      expect(codeRes.status).toBe(200);
      const code = (await codeRes.json()) as { code: string; expiresInSeconds: number };
      expect(code.code).toMatch(/^EDA-[A-Z0-9]{8}$/);
      expect(code.expiresInSeconds).toBeLessThanOrEqual(600);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-b', scopes: ['easyeda.read'] },
          code: code.code,
          sessionId: unpaired.sessionId,
        }),
      ).toBe(false);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-a', scopes: ['easyeda.read'] },
          code: code.code,
          sessionId: unpaired.sessionId,
        }),
      ).toBe(true);

      const owner = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(owner.status).toBe(200);
      const sessions = (await owner.json()) as { sessions: Array<{ sessionId: string }> };
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]?.sessionId).toBe(unpaired.sessionId);
      const putSelection = async (cookie: string, site = base) =>
        fetch(`${base}/cloud/api/selection`, {
          method: 'PUT',
          headers: { cookie, origin: site, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: unpaired.sessionId }),
        });
      expect((await putSelection('session=owner-a', 'https://attacker.example')).status).toBe(403);
      expect((await putSelection('session=owner-b')).status).toBe(404);
      const selected = await putSelection('session=owner-a');
      expect(selected.status).toBe(200);
      await expect(selected.json()).resolves.toMatchObject({
        selection: { sessionId: unpaired.sessionId, projectId: 'board-a' },
      });
      const ownerAfterSelection = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-a' },
      });
      await expect(ownerAfterSelection.json()).resolves.toMatchObject({
        selection: { projectId: 'board-a' },
      });

      const outsider = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-b' },
      });
      expect((await outsider.json()).sessions).toEqual([]);
      expect(
        (await send(`/cloud/api/extensions/${unpaired.sessionId}`, 'DELETE', 'session=owner-b'))
          .status,
      ).toBe(404);
      expect(
        (await send(`/cloud/api/extensions/${unpaired.sessionId}`, 'DELETE', 'session=owner-a'))
          .status,
      ).toBe(204);
      expect(gateway.listPairedExtensions({ userId: 'owner-a', scopes: ['easyeda.read'] })).toEqual(
        [],
      );
      expect(
        gateway.getSelectedProject({ userId: 'owner-a', scopes: ['easyeda.read'] }),
      ).toBeUndefined();

      // Removing access must invalidate the consumed code, but a fresh code must recover pairing.
      const replacement = gateway.registerExtension({
        connectionId: 'extension-2',
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: {
          projectId: 'board-b',
          documentId: 'pcb-b',
          projectName: 'Replacement board',
          documentType: 'pcb',
        },
        dispatch: async (message) => ({
          version: message.version,
          type: 'tool_response',
          requestId: message.requestId,
          ok: true,
          result: null,
        }),
      });
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-a', scopes: ['easyeda.read'] },
          code: code.code,
          sessionId: replacement.sessionId,
        }),
      ).toBe(false);

      const newCodeResponse = await send('/cloud/api/pairing-code', 'POST', 'session=owner-a');
      expect(newCodeResponse.status).toBe(200);
      const newCode = (await newCodeResponse.json()) as { code: string };
      expect(newCode.code).not.toBe(code.code);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-b', scopes: ['easyeda.read'] },
          code: newCode.code,
          sessionId: replacement.sessionId,
        }),
      ).toBe(false);
      expect(
        gateway.completePairing({
          identity: { userId: 'owner-a', scopes: ['easyeda.read'] },
          code: newCode.code,
          sessionId: replacement.sessionId,
        }),
      ).toBe(true);
      const reconnected = await fetch(`${base}/cloud/api/extensions`, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(reconnected.status).toBe(200);
      const recovered = (await reconnected.json()) as {
        sessions: Array<{ sessionId: string }>;
      };
      expect(recovered.sessions.map((item) => item.sessionId)).toEqual([replacement.sessionId]);
    });
  });

  it('blocks MCP dispatch even with a single paired extension until the owner selects a project', async () => {
    await withPortal(async (base, gateway) => {
      const sent: string[] = [];
      const extension = gateway.registerExtension({
        connectionId: 'single-paired-extension',
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: {
          projectId: 'pcb-one',
          documentId: 'pcb-doc-one',
          projectName: 'Disposable PCB',
          documentType: 'pcb',
        },
        dispatch: async (request) => {
          sent.push(request.toolName);
          return {
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'tool_response',
            messageId: 'mock_response',
            sessionId: request.sessionId,
            requestMessageId: request.messageId,
            timestamp: new Date().toISOString(),
            ok: true,
            result: { checked: true },
            durationMs: 1,
          };
        },
      });
      const identity = { userId: 'owner-a', scopes: ['easyeda.read'] as const };
      const code = gateway.createPairingCode({ identity });
      expect(gateway.completePairing({ identity, sessionId: extension.sessionId, code })).toBe(
        true,
      );
      await expect(
        gateway.routeToolRequest({
          identity,
          sessionId: extension.sessionId,
          riskLevel: 'read',
          toolName: 'schematic.listComponents',
        }),
      ).resolves.toMatchObject({ ok: false, status: 409, code: 'PROJECT_INACTIVE' });
      expect(sent).toHaveLength(0);

      const response = await fetch(`${base}/cloud/api/selection`, {
        method: 'PUT',
        headers: { cookie: 'session=owner-a', origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: extension.sessionId }),
      });
      expect(response.status).toBe(200);
      await expect(
        gateway.routeToolRequest({
          identity,
          sessionId: extension.sessionId,
          riskLevel: 'read',
          toolName: 'schematic.listComponents',
        }),
      ).resolves.toMatchObject({ ok: true, sessionId: extension.sessionId });
      expect(sent).toEqual(['schematic.listComponents']);
    });
  });

  it('rejects expired login links, missing consent clients, and untrusted portal commands', async () => {
    await withPortal(async (base) => {
      const signed =
        'client_id=valid&scope=easyeda.read&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&sig=valid';
      const badLogin = await fetch(`${base}/sign-in?client_id=forged`);
      expect(badLogin.status).toBe(400);
      const signedLogin = await fetch(`${base}/sign-in?${signed}`);
      expect(signedLogin.status).toBe(200);

      const unknownClient = await fetch(`${base}/consent?${signed}`, {
        headers: { cookie: 'session=owner-b' },
      });
      expect(unknownClient.status).toBe(404);

      for (const path of ['/cloud/api/clients', '/cloud/api/extensions']) {
        const anonymous = await fetch(`${base}${path}`);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('cache-control')).toBe('no-store');
      }
      const ownerClients = await fetch(`${base}/cloud/api/clients`, {
        headers: { cookie: 'session=owner-a' },
      });
      expect(ownerClients.status).toBe(200);
      await expect(ownerClients.json()).resolves.toEqual({ clients: [] });

      const invalidSelection = await fetch(`${base}/cloud/api/selection`, {
        method: 'PUT',
        headers: { cookie: 'session=owner-a', origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'not-a-session' }),
      });
      expect(invalidSelection.status).toBe(400);
      const unpairedSelection = await fetch(`${base}/cloud/api/selection`, {
        method: 'PUT',
        headers: { cookie: 'session=owner-a', origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess_unknown' }),
      });
      expect(unpairedSelection.status).toBe(404);

      const unknownRevoke = await fetch(`${base}/cloud/api/extensions/sess_unknown`, {
        method: 'DELETE',
        headers: { cookie: 'session=owner-a', origin: base },
      });
      expect(unknownRevoke.status).toBe(404);
      const missingOrigin = await fetch(`${base}/cloud/api/extensions/sess_unknown`, {
        method: 'DELETE',
        headers: { cookie: 'session=owner-a' },
      });
      expect(missingOrigin.status).toBe(403);
    });
  });

  it('does not expose the portal in the original no-account Local HTTP mode', async () => {
    const transport = createHttpTransport(EnvSchema.parse({ TRANSPORT: 'http' }));
    const server = http.createServer(transport.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No test port');
      const response = await fetch(`http://127.0.0.1:${addr.port}/sign-in`);
      expect(response.status).toBe(404);
      const data = await fetch(`http://127.0.0.1:${addr.port}/cloud/api/me`);
      expect(data.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

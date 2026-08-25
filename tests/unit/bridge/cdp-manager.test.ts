import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpBridgeManager } from '../../../src/bridge/cdp-manager.js';
import { EnvSchema } from '../../../src/config/env.js';

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface Harness {
  server: Server;
  websocketServer: WebSocketServer;
  clients: Set<WebSocket>;
  requests: CdpRequest[];
  baseUrl: string;
  close(): Promise<void>;
  ignoreNextEvaluation(): void;
  rejectUpgrade: boolean;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createHarness(
  options: {
    targets?: unknown[];
    evaluateError?: string;
    evaluateValue?: (expression: string) => unknown;
  } = {},
): Promise<Harness> {
  const websocketServer = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const requests: CdpRequest[] = [];
  let ignoreEvaluation = false;
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    const targets = options.targets ?? [
      {
        id: 'easyeda-page',
        type: 'page',
        title: 'EasyEDA Pro',
        url: 'https://pro.easyeda.com/editor/project',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/easyeda-page`,
      },
    ];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(targets));
  });

  const harness: Harness = {
    server,
    websocketServer,
    clients,
    requests,
    baseUrl: '',
    rejectUpgrade: false,
    ignoreNextEvaluation: () => {
      ignoreEvaluation = true;
    },
    close: async () => {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
      await closeServer(server);
    },
  };

  server.on('upgrade', (request, socket, head) => {
    if (harness.rejectUpgrade) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit('connection', client, request);
    });
  });

  websocketServer.on('connection', (client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as CdpRequest;
      requests.push(request);
      if (request.method === 'Runtime.enable') {
        client.send(JSON.stringify({ id: request.id, result: {} }));
        return;
      }
      if (request.method === 'Runtime.evaluate') {
        if (ignoreEvaluation) {
          ignoreEvaluation = false;
          return;
        }
        if (options.evaluateError) {
          client.send(
            JSON.stringify({ id: request.id, error: { message: options.evaluateError } }),
          );
          return;
        }
        const expression = String(request.params?.expression ?? '');
        const defaultValue = { appVersion: '2.2.39', title: 'EasyEDA Pro' };
        const value = options.evaluateValue?.(expression) ?? defaultValue;
        client.send(
          JSON.stringify({
            id: request.id,
            result: { result: { value } },
          }),
        );
      }
    });
  });

  port = await listen(server);
  harness.baseUrl = `http://127.0.0.1:${port}`;
  return harness;
}

function createManager(overrides: Record<string, unknown> = {}): CdpBridgeManager {
  return new CdpBridgeManager(
    EnvSchema.parse({
      NODE_ENV: 'test',
      BRIDGE_WAIT_FOR_EDA_MS: 0,
      BRIDGE_TIMEOUT_MS: 1_000,
      ...overrides,
    }),
  );
}

const activeManagers = new Set<CdpBridgeManager>();
const activeHarnesses = new Set<Harness>();

async function connectedManager(harness: Harness): Promise<CdpBridgeManager> {
  process.env.EASYEDA_CDP_URL = harness.baseUrl;
  const manager = createManager();
  activeManagers.add(manager);
  await manager.connect();
  return manager;
}

afterEach(async () => {
  delete process.env.EASYEDA_CDP_URL;
  delete process.env.EASYEDA_CDP_TARGET_ID;
  delete process.env.EASYEDA_CDP_ALLOW_WRITES;
  delete process.env.EASYEDA_CDP_ALLOW_UNMAPPED_WRITES;
  for (const manager of activeManagers) manager.disconnect('test cleanup');
  activeManagers.clear();
  for (const harness of activeHarnesses) await harness.close();
  activeHarnesses.clear();
  vi.restoreAllMocks();
});

describe('CdpBridgeManager transport lifecycle', () => {
  it('enters the error state when no EasyEDA target is available', async () => {
    const harness = await createHarness({ targets: [] });
    activeHarnesses.add(harness);
    process.env.EASYEDA_CDP_URL = harness.baseUrl;
    const manager = createManager();
    activeManagers.add(manager);
    const stateChanges: string[] = [];
    manager.on('stateChanged', (next) => stateChanges.push(String(next)));

    await expect(manager.connect()).rejects.toThrow('could not find an EasyEDA editor page target');

    expect(manager.state).toBe('error');
    expect(stateChanges).toEqual(['connecting', 'error']);
    expect(manager.hello).toBeNull();
  });

  it('cleans up and enters the error state when the CDP WebSocket upgrade is rejected', async () => {
    const harness = await createHarness();
    harness.rejectUpgrade = true;
    activeHarnesses.add(harness);
    process.env.EASYEDA_CDP_URL = harness.baseUrl;
    const manager = createManager();
    activeManagers.add(manager);

    await expect(manager.connect()).rejects.toThrow();

    expect(manager.state).toBe('error');
    expect(manager.connected).toBe(false);
    expect(manager.hello).toBeNull();
  });

  it('normalizes a non-Error connection rejection before failing closed', async () => {
    const manager = createManager();
    activeManagers.add(manager);
    const fetchJson = vi.fn().mockRejectedValue('non-error connection failure');
    Object.defineProperty(manager, 'fetchJson', { value: fetchJson });

    await expect(manager.connect()).rejects.toThrow('non-error connection failure');

    expect(fetchJson).toHaveBeenCalledOnce();
    expect(manager.state).toBe('error');
    expect(manager.connected).toBe(false);
  });

  it('closes an established socket when runtime negotiation fails', async () => {
    const harness = await createHarness({ evaluateError: 'runtime status unavailable' });
    activeHarnesses.add(harness);
    process.env.EASYEDA_CDP_URL = harness.baseUrl;
    const manager = createManager();
    activeManagers.add(manager);

    await expect(manager.connect()).rejects.toThrow('runtime status unavailable');

    expect(manager.state).toBe('error');
    expect(manager.connected).toBe(false);
    await vi.waitFor(() => expect(harness.clients.size).toBe(0));
  });

  it('connects through CDP and publishes a runtime hello', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);

    expect(manager.connected).toBe(true);
    expect(manager.state).toBe('connected');
    expect(manager.activePort).toBe(Number(new URL(harness.baseUrl).port));
    expect(manager.hello).toMatchObject({
      type: 'hello',
      easyedaVersion: '2.2.39',
      devMode: true,
    });
    expect(manager.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(manager.lastHeartbeatMs).toBeGreaterThan(0);
    expect(harness.requests.map((request) => request.method)).toEqual([
      'Runtime.enable',
      'Runtime.evaluate',
    ]);
  });

  it('uses the default CDP port when the configured base URL omits one', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = createManager();
    activeManagers.add(manager);
    const debuggerUrl = `${harness.baseUrl.replace('http://', 'ws://')}/devtools/page/easyeda-page`;
    const fetchJson = vi.fn().mockResolvedValue([
      {
        id: 'easyeda-page',
        type: 'page',
        title: 'EasyEDA Pro',
        url: 'https://pro.easyeda.com/editor/project',
        webSocketDebuggerUrl: debuggerUrl,
      },
    ]);
    Object.defineProperty(manager, 'getCdpBaseUrl', { value: () => 'http://127.0.0.1' });
    Object.defineProperty(manager, 'fetchJson', { value: fetchJson });

    await manager.connect();

    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1/json/list');
    expect(manager.activePort).toBe(9222);
    expect(manager.connected).toBe(true);
  });

  it('routes scoped component reads through the mapped CDP expression', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);

    await expect(
      manager.call('schematic.listComponents', { allPages: false }),
    ).resolves.toMatchObject({
      appVersion: '2.2.39',
    });

    const evaluation = harness.requests.findLast(
      (request) =>
        request.method === 'Runtime.evaluate' &&
        String(request.params?.expression ?? '').includes('SCH_PrimitiveComponent.getAll'),
    );
    expect(String(evaluation?.params?.expression ?? '')).toContain('getAll(undefined, false)');
  });

  it('does not interpret scope-like fields on methods outside schematic scope policy', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);

    await expect(
      manager.call('api.call', {
        method: 'DMT_Schematic.getCurrentSchematicPageInfo',
        args: [],
        scope: 'vendor-specific-value',
      }),
    ).resolves.toMatchObject({ appVersion: '2.2.39' });
  });

  it('reconstructs structured page errors returned by the CDP sheet expression', async () => {
    const harness = await createHarness({
      evaluateValue: (expression) =>
        expression.includes('page_scope_resolution')
          ? {
              __easyedaBridgeError: {
                code: 'PAGE_NOT_FOUND',
                message: 'Requested schematic page was not found.',
                suggestion: 'Refresh the page list and retry.',
                data: {
                  operation: 'schematic.getSheetInfo',
                  requestedScope: 'page',
                  pageUuid: 'missing',
                },
              },
            }
          : undefined,
    });
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);

    await expect(
      manager.call('schematic.getSheetInfo', { pageUuid: 'missing' }),
    ).rejects.toMatchObject({
      code: 'PAGE_NOT_FOUND',
      suggestion: 'Refresh the page list and retry.',
      data: expect.objectContaining({
        operation: 'schematic.getSheetInfo',
        requestedScope: 'page',
        pageUuid: 'missing',
      }),
    });
  });

  it('treats only record-shaped CDP sheet error envelopes as structured failures', async () => {
    const malformedHarness = await createHarness({
      evaluateValue: (expression) =>
        expression.includes('page_scope_resolution')
          ? { __easyedaBridgeError: ['not', 'a', 'record'] }
          : undefined,
    });
    activeHarnesses.add(malformedHarness);
    const malformedManager = await connectedManager(malformedHarness);

    await expect(
      malformedManager.call('schematic.getSheetInfo', { pageUuid: 'page-2' }),
    ).resolves.toEqual({ __easyedaBridgeError: ['not', 'a', 'record'] });

    const minimalHarness = await createHarness({
      evaluateValue: (expression) =>
        expression.includes('page_scope_resolution')
          ? { __easyedaBridgeError: { code: 'PAGE_SCOPE_UNAVAILABLE' } }
          : undefined,
    });
    activeHarnesses.add(minimalHarness);
    const minimalManager = await connectedManager(minimalHarness);

    await expect(
      minimalManager.call('schematic.getSheetInfo', { pageUuid: 'page-2' }),
    ).rejects.toMatchObject({
      code: 'PAGE_SCOPE_UNAVAILABLE',
      message: expect.stringContaining('CDP bridge sheet read failed.'),
    });
  });

  it('rejects contradictory schematic selectors before Runtime.evaluate', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    const evaluationsBefore = harness.requests.filter(
      (request) => request.method === 'Runtime.evaluate',
    ).length;

    await expect(
      manager.call('schematic.getSheetInfo', { scope: 'focused', pageUuid: 'page-2' }),
    ).rejects.toMatchObject({ code: 'PAGE_SCOPE_CONFLICT' });
    await expect(manager.call('schematic.getSheetInfo', { scope: 'page' })).rejects.toMatchObject({
      code: 'PAGE_UUID_REQUIRED',
    });
    await expect(manager.call('schematic.getSheetInfo', { pageUuid: '   ' })).rejects.toMatchObject(
      { code: 'PAGE_UUID_REQUIRED' },
    );
    expect(
      harness.requests.filter((request) => request.method === 'Runtime.evaluate'),
    ).toHaveLength(evaluationsBefore);
  });

  it('describes invalid object scope values without default object stringification', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);

    await expect(
      manager.call('schematic.getSheetInfo', { scope: { unexpected: true } }),
    ).rejects.toMatchObject({
      code: 'PAGE_SCOPE_CONFLICT',
      data: expect.objectContaining({ requestedScope: 'object' }),
    });
  });

  it('rejects unsupported schematic scopes before issuing Runtime.evaluate', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    const evaluationsBefore = harness.requests.filter(
      (request) => request.method === 'Runtime.evaluate',
    ).length;

    for (const method of [
      'schematic.listNets',
      'system.inspectWires',
      'design.erc',
      'schematic.listComponents',
    ]) {
      await expect(
        manager.call(method, { scope: 'page', pageUuid: 'page-2' }),
      ).rejects.toMatchObject({
        code: 'PAGE_SCOPE_UNSUPPORTED',
        data: expect.objectContaining({
          requestedScope: 'page',
          pageUuid: 'page-2',
          operation: method,
        }),
      });
    }

    expect(
      harness.requests.filter((request) => request.method === 'Runtime.evaluate'),
    ).toHaveLength(evaluationsBefore);
  });

  it('times out an unanswered CDP command and removes it from pending work', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    harness.ignoreNextEvaluation();

    await expect(
      manager.call('api.execute', { expression: '42' }, { timeoutMs: 20 }),
    ).rejects.toThrow('CDP command "Runtime.evaluate" timed out after 20ms');

    expect((manager as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('rejects pending work immediately and clears runtime state when the socket closes', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    harness.ignoreNextEvaluation();
    const disconnected = vi.fn();
    manager.on('disconnected', disconnected);

    const pendingCall = manager.call('api.execute', { expression: '42' }, { timeoutMs: 5_000 });
    await vi.waitFor(() => {
      expect((manager as unknown as { pending: Map<number, unknown> }).pending.size).toBe(1);
    });
    for (const client of harness.clients) client.close(1001, 'renderer shutdown');

    await expect(pendingCall).rejects.toThrow('CDP bridge disconnected: renderer shutdown');
    await vi.waitFor(() => expect(manager.state).toBe('connecting'));
    expect(manager.connected).toBe(false);
    expect(manager.hello).toBeNull();
    expect((manager as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    expect(disconnected).toHaveBeenCalledWith('renderer shutdown');
  });

  it('uses a stable fallback reason when the renderer closes without one', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    const disconnected = vi.fn();
    manager.on('disconnected', disconnected);

    for (const client of harness.clients) client.close(1001);

    await vi.waitFor(() => expect(manager.state).toBe('connecting'));
    expect(disconnected).toHaveBeenCalledWith('cdp_close_1001');
  });

  it('enforces mapped and unmapped write authorization before runtime evaluation', async () => {
    const harness = await createHarness();
    activeHarnesses.add(harness);
    const manager = await connectedManager(harness);
    const requestCount = harness.requests.length;

    await expect(
      manager.call('schematic.placeComponent', {
        deviceItem: { uuid: 'device-1' },
        x: 100,
        y: 200,
      }),
    ).rejects.toThrow('requires EASYEDA_CDP_ALLOW_WRITES=true');
    await expect(manager.call('project.save', {})).rejects.toThrow(
      'has not mapped mutating EasyEDA method "project.save" yet',
    );

    expect(harness.requests).toHaveLength(requestCount);
  });
});

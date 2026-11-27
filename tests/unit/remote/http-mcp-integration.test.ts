import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, type McpServerInstance } from '../../../src/server/factory.js';
import {
  createHttpTransport,
  type HttpTransportInstance,
} from '../../../src/server/transports/http.js';
import { EnvSchema } from '../../../src/config/env.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ApprovalRequestMessage,
  type ToolRequestMessage,
  type ToolResponseMessage,
  type RemoteScope,
} from '../../../src/remote/protocol.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to reserve a loopback test port.');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface RemoteHttpHarness {
  identity: {
    userId: string;
    scopes: readonly RemoteScope[];
  };
  gateway: RemoteGateway;
  baseUrl: string;
  remoteSessionId: string;
  dispatched: ToolRequestMessage[];
  approvalRequests: ApprovalRequestMessage[];
  readonly closedSessionServerCount: number;
  instance: McpServerInstance;
  httpTransport: HttpTransportInstance;
  createClient: (
    name: string,
    modern?: boolean,
  ) => {
    client: Client;
    transport: StreamableHTTPClientTransport;
  };
  close: () => Promise<void>;
}

async function createHarness(
  modernEnabled = false,
  extensionRpc = false,
  rpcErrorCode?: string,
): Promise<RemoteHttpHarness> {
  const port = await reservePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'easyeda-remote-http-'));
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TOOL_PROFILE: extensionRpc ? 'experimental' : 'core',
    BRIDGE_EXTENSION_RPC_TOPICS: extensionRpc ? 'mcp.demo.echo,mcp.demo.inspect' : '',
    TRANSPORT: 'http',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: port,
    HTTP_AUTH_DISABLED: true,
    MCP_V2_EXPERIMENTAL: modernEnabled,
    MCP_BRIDGE_BACKEND: 'remote_relay',
    BRIDGE_TIMEOUT_MS: 1000,
    JLCSEARCH_ENABLED: false,
    DATA_DIR: dataDir,
    SQLITE_PATH: join(dataDir, 'test.sqlite'),
    ARTIFACT_DIR: join(dataDir, 'artifacts'),
    CACHE_DIR: join(dataDir, 'cache'),
  });

  const identity = {
    userId: 'http-user',
    scopes: extensionRpc
      ? (['easyeda.project_admin'] as const)
      : (['easyeda.read', 'easyeda.write'] as const),
  };
  const dispatched: ToolRequestMessage[] = [];
  const approvalRequests: ApprovalRequestMessage[] = [];
  const gateway = new RemoteGateway();
  const remoteSession = gateway.registerExtension({
    connectionId: 'fake-http-extension',
    mode: 'hosted',
    extensionVersion: '0.32.0',
    activeProject: { projectName: 'HTTP Test', documentType: 'schematic' },
    requestApproval: (request) => {
      approvalRequests.push(request);
    },
    dispatch: async (request): Promise<ToolResponseMessage> => {
      dispatched.push(request);
      if (request.toolName === 'extension.rpcCall' && rpcErrorCode) {
        if (rpcErrorCode === 'test-dispatch-timeout') {
          // Exercise the real gateway deadline, not a synthetic error envelope.
          return await new Promise<ToolResponseMessage>(() => {});
        }
        return {
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response',
          messageId: `fake-http-response-${dispatched.length}`,
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date().toISOString(),
          ok: false,
          error: { code: rpcErrorCode, message: 'private-test-error' },
          durationMs: 1,
        };
      }
      const result =
        request.toolName === 'schematic.listComponents'
          ? {
              total: 1,
              items: [
                {
                  primitiveId: 'component-1',
                  reference: 'R1',
                  value: '10k',
                  footprint: '0603',
                },
              ],
            }
          : request.toolName === 'extension.rpcCall'
            ? { ...(request.input as Record<string, unknown>), result: 'echo reply' }
            : { primitiveId: 'text-http-1' };
      return {
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: `fake-http-response-${dispatched.length}`,
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: new Date().toISOString(),
        ok: true,
        result,
        durationMs: 1,
      };
    },
  });
  const pairingCode = gateway.createPairingCode({
    identity,
    sessionId: remoteSession.sessionId,
  });
  expect(
    gateway.completePairing({
      identity,
      code: pairingCode,
      sessionId: remoteSession.sessionId,
    }),
  ).toBe(true);

  const instance = await createServer(config, { remoteGateway: gateway });
  expect(instance.bridge.connected).toBe(false);
  expect(instance.bridge.activePort).toBe(0);

  let closedSessionServerCount = 0;
  const httpTransport = createHttpTransport(config, {
    gateway,
    serverFactory: () => {
      const sessionServer = instance.createSessionServer();
      const close = sessionServer.close.bind(sessionServer);
      let counted = false;
      sessionServer.close = async () => {
        if (!counted) {
          counted = true;
          closedSessionServerCount += 1;
        }
        await close();
      };
      return sessionServer;
    },
  });
  instance.httpTransport = httpTransport;
  await httpTransport.start();

  const clients = new Set<Client>();
  const createClient = (name: string, modern = false) => {
    const client = new Client(
      { name, version: '1.0.0' },
      modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          'x-remote-user-id': identity.userId,
          'x-remote-scopes': identity.scopes.join(' '),
        },
      },
    });
    clients.add(client);
    return { client, transport };
  };

  const close = async () => {
    await Promise.allSettled([...clients].map(async (client) => client.close()));
    await httpTransport.close();
    await instance.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  };

  return {
    identity,
    gateway,
    baseUrl: `http://127.0.0.1:${port}`,
    remoteSessionId: remoteSession.sessionId,
    dispatched,
    approvalRequests,
    get closedSessionServerCount() {
      return closedSessionServerCount;
    },
    instance,
    httpTransport,
    createClient,
    close,
  };
}

describe('Remote Relay MCP HTTP integration', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const task = cleanup.pop();
      if (task) await task();
    }
  });

  it('routes only an approved, allowlisted extension RPC through the actual MCP handler', async () => {
    const harness = await createHarness(false, true);
    cleanup.push(harness.close);
    const { client, transport } = harness.createClient('extension-rpc-http');
    await client.connect(transport);
    const args = {
      topic: 'mcp.demo.echo',
      message: { data: 'private-test-payload' },
      confirmWrite: true,
      timeoutMs: 1000,
      remoteSessionId: harness.remoteSessionId,
    };
    const callApproved = async (topic: string) => {
      const invocation = { ...args, topic };
      const pending = await client.callTool({
        name: 'easyeda_extension_call',
        arguments: invocation,
      });
      expect(pending.structuredContent).toMatchObject({
        details: { remoteCode: 'APPROVAL_REQUIRED' },
      });
      const prompt = harness.approvalRequests.at(-1);
      expect(prompt).toMatchObject({
        toolName: 'easyeda_extension_call',
        riskLevel: 'destructive',
      });
      expect(prompt?.actionSummary).toContain(topic);
      expect(prompt?.actionSummary).not.toContain('private-test-payload');
      const approvalId = (pending.structuredContent as { details: { approvalId: string } }).details
        .approvalId;
      expect(
        harness.gateway.resolveApprovalFromExtension({
          sessionId: harness.remoteSessionId,
          approvalId,
          result: 'approved',
        }),
      ).toBe(true);
      return client.callTool({
        name: 'easyeda_extension_call',
        arguments: { ...invocation, remoteApprovalId: approvalId },
      });
    };
    const refused = await callApproved('mcp.demo.notAllowed');
    expect(refused.structuredContent).toMatchObject({ ok: false });
    expect(harness.dispatched).toHaveLength(0);
    const accepted = await callApproved('mcp.demo.echo');
    expect(accepted.structuredContent).toMatchObject({ ok: true, result: 'echo reply' });
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toMatchObject({
      toolName: 'extension.rpcCall',
      riskLevel: 'destructive',
      requiresApproval: true,
    });
    const second = await callApproved('mcp.demo.inspect');
    expect(second.structuredContent).toMatchObject({ ok: true });
    expect(harness.dispatched).toHaveLength(2);
    expect(harness.approvalRequests.at(-1)?.actionSummary).not.toContain('mcp.demo.echo');
    const direct = await fetch(harness.baseUrl + '/remote/tool-requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-remote-user-id': harness.identity.userId,
        'x-remote-scopes': 'easyeda.project_admin',
      },
      body: JSON.stringify({
        sessionId: harness.remoteSessionId,
        toolName: 'extension.rpcCall',
        riskLevel: 'destructive',
        input: { topic: args.topic, confirmWrite: true, timeoutMs: 1000, message: null },
      }),
    });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ code: 'APPROVAL_NOT_APPROVED' });
    expect(harness.dispatched).toHaveLength(2);
  }, 15_000);

  it.each([
    ['METHOD_NOT_ALLOWED', false, 'REMOTE_TOOL_UNSUPPORTED'],
    ['METHOD_NOT_FOUND', false, 'REMOTE_TOOL_UNSUPPORTED'],
    ['UNSUPPORTED_RUNTIME', false, 'UNSUPPORTED_RUNTIME'],
    ['INVALID_PARAMS', false, 'INVALID_PARAMS'],
    ['CONFIRM_WRITE_REQUIRED', false, 'CONFIRM_WRITE_REQUIRED'],
    ['REMOTE_EXECUTION_NOT_ENABLED', false, 'REMOTE_EXECUTION_NOT_ENABLED'],
    ['EXTENSION_RPC_NO_REPLY', true, 'outcome is unknown'],
    ['EXTENSION_RPC_FAILED', true, 'outcome is unknown'],
    ['PAYLOAD_TOO_LARGE', true, 'outcome is unknown'],
    ['EASYEDA_API_ERROR', true, 'outcome is unknown'],
  ] as const)(
    'reports remote RPC failure %s with the correct dispatch certainty',
    async (code, unknown, detail) => {
      const harness = await createHarness(false, true, code);
      cleanup.push(harness.close);
      const { client, transport } = harness.createClient('extension-rpc-failure-http');
      await client.connect(transport);
      const args = {
        topic: 'mcp.demo.echo',
        confirmWrite: true,
        timeoutMs: 1000,
        remoteSessionId: harness.remoteSessionId,
      };
      const pending = await client.callTool({ name: 'easyeda_extension_call', arguments: args });
      expect(pending.structuredContent).toMatchObject({
        details: { remoteCode: 'APPROVAL_REQUIRED' },
      });
      expect(harness.dispatched).toHaveLength(0);
      const approvalId = (pending.structuredContent as { details: { approvalId: string } }).details
        .approvalId;
      expect(
        harness.gateway.resolveApprovalFromExtension({
          sessionId: harness.remoteSessionId,
          approvalId,
          result: 'approved',
        }),
      ).toBe(true);
      const response = await client.callTool({
        name: 'easyeda_extension_call',
        arguments: { ...args, remoteApprovalId: approvalId },
      });
      expect(response.structuredContent).toMatchObject({
        ok: false,
        outcomeUnknown: unknown,
        error: expect.stringContaining(detail),
      });
      expect(JSON.stringify(response.structuredContent)).not.toContain('private-test-error');
      expect(harness.dispatched).toHaveLength(1);
    },
    15_000,
  );

  it('preserves uncertainty on a terminal remote RPC dispatch deadline', async () => {
    const harness = await createHarness(false, true, 'test-dispatch-timeout');
    cleanup.push(harness.close);
    const { client, transport } = harness.createClient('extension-rpc-deadline-http');
    await client.connect(transport);
    const args = {
      topic: 'mcp.demo.echo',
      confirmWrite: true,
      timeoutMs: 100,
      remoteSessionId: harness.remoteSessionId,
    };
    const pending = await client.callTool({ name: 'easyeda_extension_call', arguments: args });
    expect(pending.structuredContent).toMatchObject({
      details: { remoteCode: 'APPROVAL_REQUIRED' },
    });
    expect(harness.dispatched).toHaveLength(0);
    const approvalId = (pending.structuredContent as { details: { approvalId: string } }).details
      .approvalId;
    expect(
      harness.gateway.resolveApprovalFromExtension({
        sessionId: harness.remoteSessionId,
        approvalId,
        result: 'approved',
      }),
    ).toBe(true);
    const response = await client.callTool({
      name: 'easyeda_extension_call',
      arguments: { ...args, remoteApprovalId: approvalId },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      message: expect.stringMatching(/outcome is unknown.*inspect.*before retrying/i),
      details: { remoteCode: 'REMOTE_EXTENSION_TIMEOUT', status: 504, outcomeUnknown: true },
    });
    expect(response.content).toContainEqual({
      type: 'text',
      text: expect.stringMatching(/outcome is unknown.*inspect.*before retrying/i),
    });
    expect(harness.dispatched).toHaveLength(1);
    const retry = await client.callTool({
      name: 'easyeda_extension_call',
      arguments: { ...args, remoteApprovalId: approvalId },
    });
    expect(retry.isError).toBe(true);
    expect(retry.structuredContent).toMatchObject({
      details: { remoteCode: 'SESSION_DISCONNECTED' },
    });
    expect(retry.structuredContent?.details).not.toHaveProperty('outcomeUnknown');
    expect(harness.dispatched).toHaveLength(1);
  }, 15_000);

  it('distinguishes an in-flight RPC socket close from a pre-dispatch refusal', async () => {
    const harness = await createHarness(false, true);
    cleanup.push(harness.close);
    const pairingCode = harness.gateway.createPairingCode({ identity: harness.identity });
    const socket = new WebSocket(harness.baseUrl.replace('http:', 'ws:') + '/remote/relay');
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    cleanup.push(async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.terminate();
      });
    });
    await waitFor(() => socket.readyState === WebSocket.OPEN);
    socket.send(
      JSON.stringify({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'register_session',
        messageId: 'rpc-socket-registration',
        timestamp: new Date().toISOString(),
        mode: 'hosted',
        extensionVersion: '1.23.1',
        capabilities: [],
        activeProject: {
          projectName: 'Disposable remote socket fixture',
          documentType: 'schematic',
        },
        pairingCode,
      }),
    );
    await waitFor(() => messages.some((m) => m.type === 'session_registered'));
    const registered = messages.find((m) => m.type === 'session_registered')!;
    expect(registered.paired).toBe(true);
    const sessionId = registered.sessionId as string;
    const { client, transport } = harness.createClient('extension-rpc-socket-close-http');
    await client.connect(transport);
    const args = {
      topic: 'mcp.demo.echo',
      confirmWrite: true,
      timeoutMs: 1000,
      remoteSessionId: sessionId,
    };
    const pending = await client.callTool({ name: 'easyeda_extension_call', arguments: args });
    expect(pending.structuredContent).toMatchObject({
      details: { remoteCode: 'APPROVAL_REQUIRED' },
    });
    await waitFor(() => messages.some((m) => m.type === 'approval_request'));
    const approval = messages.find((m) => m.type === 'approval_request')!;
    const approvalId = approval.approvalId as string;
    expect(
      harness.gateway.resolveApprovalFromExtension({ sessionId, approvalId, result: 'approved' }),
    ).toBe(true);
    const inflight = client.callTool({
      name: 'easyeda_extension_call',
      arguments: { ...args, remoteApprovalId: approvalId },
    });
    await waitFor(() => messages.some((m) => m.type === 'tool_request'));
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
    const response = await inflight;
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      message: expect.stringMatching(/outcome is unknown.*inspect.*before retrying/i),
      details: { remoteCode: 'SESSION_DISCONNECTED', status: 424, outcomeUnknown: true },
    });
    expect(response.content).toContainEqual({
      type: 'text',
      text: expect.stringMatching(/outcome is unknown.*inspect.*before retrying/i),
    });
    const retry = await client.callTool({
      name: 'easyeda_extension_call',
      arguments: { ...args, remoteApprovalId: approvalId },
    });
    expect(retry.isError).toBe(true);
    expect(retry.structuredContent).toMatchObject({
      details: { remoteCode: 'SESSION_DISCONNECTED' },
    });
    expect(retry.structuredContent?.details).not.toHaveProperty('outcomeUnknown');
    expect(messages.filter((m) => m.type === 'tool_request')).toHaveLength(1);
  }, 15_000);

  it.each([false, true])(
    'reports real owner bridge readiness after remote disconnect (modern=%s)',
    async (modern) => {
      const harness = await createHarness(modern);
      cleanup.push(harness.close);
      const { client, transport } = harness.createClient('health-check-real-bridge', modern);
      await client.connect(transport);

      const connected = await client.callTool({
        name: 'easyeda_health_check',
        arguments: {},
      });
      expect(connected.isError).not.toBe(true);
      expect(connected.structuredContent).toMatchObject({
        status: 'ok',
        bridge_connected: true,
      });

      expect(harness.gateway.revokePairedExtension(harness.identity, harness.remoteSessionId)).toBe(
        true,
      );
      const disconnected = await client.callTool({
        name: 'easyeda_health_check',
        arguments: {},
      });
      expect(disconnected.isError).not.toBe(true);
      expect(disconnected.structuredContent).toMatchObject({
        status: 'degraded',
        bridge_connected: false,
      });
      expect(harness.dispatched).toHaveLength(0);
    },
    15_000,
  );

  it('reports a degraded editor when Hosted Cloud has a paired device but no selected project', async () => {
    const harness = await createHarness(true);
    cleanup.push(harness.close);
    harness.gateway.requireExplicitProjectSelection();
    const { client, transport } = harness.createClient('remote-http-unselected', true);
    await client.connect(transport);

    const result = await client.callTool({ name: 'easyeda_health_check', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      status: 'degraded',
      bridge_connected: false,
      status_error: expect.stringContaining('select the focused project'),
    });
    expect(harness.dispatched).toHaveLength(0);
  }, 15_000);

  it('preserves Remote Relay identity, isolation, and approval gating for modern HTTP requests', async () => {
    const harness = await createHarness(true);
    cleanup.push(harness.close);
    const { client, transport } = harness.createClient('remote-http-modern', true);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(harness.httpTransport.activeSessionCount).toBe(0);

    const readResult = await client.callTool({
      name: 'easyeda_schematic_components',
      arguments: {
        projectId: 'project-modern',
        remoteSessionId: harness.remoteSessionId,
      },
    });
    expect(readResult.isError).not.toBe(true);
    expect(harness.dispatched.at(-1)).toMatchObject({
      sessionId: harness.remoteSessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      input: { projectId: 'project-modern' },
    });

    const writeResult = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: {
        x: 10,
        y: 20,
        content: 'Modern approval required',
        confirmWrite: true,
        remoteSessionId: harness.remoteSessionId,
      },
    });
    expect(writeResult.isError).toBe(true);
    expect(writeResult.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      details: {
        remoteCode: 'APPROVAL_REQUIRED',
        approvalId: expect.stringMatching(/^appr_/),
      },
    });
    const approvalId = (writeResult.structuredContent as { details: { approvalId: string } })
      .details.approvalId;
    // The visible MCP error text must carry the retry ID, not only the
    // structured result: real connector clients may strip structuredContent.
    expect((writeResult.content as { type: string; text?: string }[])[0]?.text).toContain(
      `remoteApprovalId="${approvalId}"`,
    );
    expect(harness.approvalRequests).toHaveLength(1);
    expect(harness.httpTransport.activeSessionCount).toBe(0);
  }, 15_000);

  it('routes read calls and approval-gated write calls through a paired fake extension without a local bridge listener', async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);
    const { client, transport } = harness.createClient('remote-http-test');
    await client.connect(transport);

    expect(harness.httpTransport.activeSessionCount).toBe(1);

    const listed = await client.listTools();
    const readTool = listed.tools.find(
      (candidate) => candidate.name === 'easyeda_schematic_components',
    );
    const writeTool = listed.tools.find(
      (candidate) => candidate.name === 'easyeda_schematic_add_text',
    );
    expect(readTool?.inputSchema.properties).toMatchObject({
      remoteSessionId: expect.any(Object),
      remoteApprovalId: expect.any(Object),
    });
    expect(writeTool?.inputSchema.properties).toMatchObject({
      remoteSessionId: expect.any(Object),
      remoteApprovalId: expect.any(Object),
    });

    const readResult = await client.callTool({
      name: 'easyeda_schematic_components',
      arguments: {
        projectId: 'project-http',
        remoteSessionId: harness.remoteSessionId,
      },
    });

    expect(readResult.isError).not.toBe(true);
    expect(readResult.structuredContent).toMatchObject({
      project_id: 'project-http',
      total: 1,
      components: [
        {
          primitiveId: 'component-1',
          reference: 'R1',
          value: '10k',
          footprint: '0603',
        },
      ],
    });
    expect(harness.dispatched).toHaveLength(2);
    expect(harness.dispatched[0]).toMatchObject({
      sessionId: harness.remoteSessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      input: { projectId: 'project-http', limit: 100, offset: 0 },
    });

    const writeArguments = {
      x: 100,
      y: 200,
      content: 'Approved remote note',
      confirmWrite: true,
      remoteSessionId: harness.remoteSessionId,
    };
    const approvalRequired = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: writeArguments,
    });
    expect(approvalRequired.isError).toBe(true);
    expect(approvalRequired.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      details: {
        remoteCode: 'APPROVAL_REQUIRED',
        approvalId: expect.stringMatching(/^appr_/),
        approvalExpiresAt: expect.any(String),
      },
    });
    const approvalId = (
      approvalRequired.structuredContent as {
        details?: { approvalId?: string };
      }
    ).details?.approvalId;
    expect(approvalId).toBeDefined();
    expect(harness.approvalRequests).toHaveLength(1);
    expect(harness.approvalRequests[0]).toMatchObject({
      approvalId,
      sessionId: harness.remoteSessionId,
      toolName: 'easyeda_schematic_add_text',
      riskLevel: 'write',
    });
    expect(harness.dispatched).toHaveLength(2);

    expect(
      harness.gateway.resolveApprovalFromExtension({
        sessionId: harness.remoteSessionId,
        approvalId: approvalId!,
        result: 'approved',
      }),
    ).toBe(true);

    const writeResult = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: { ...writeArguments, remoteApprovalId: approvalId },
    });
    expect(writeResult.isError).not.toBe(true);
    expect(writeResult.structuredContent).toMatchObject({
      success: true,
      text: { primitiveId: 'text-http-1' },
    });
    expect(harness.dispatched).toHaveLength(3);
    expect(harness.dispatched[2]).toMatchObject({
      sessionId: harness.remoteSessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write',
      input: { x: 100, y: 200, content: 'Approved remote note' },
    });

    const replay = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: { ...writeArguments, remoteApprovalId: approvalId },
    });
    expect(replay.isError).toBe(true);
    expect(replay.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      details: { remoteCode: 'APPROVAL_NOT_APPROVED', approvalId },
    });
    expect(harness.dispatched).toHaveLength(3);

    const rejectedArguments = { ...writeArguments, content: 'Rejected remote note' };
    const rejectionRequired = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: rejectedArguments,
    });
    const rejectedApprovalId = (
      rejectionRequired.structuredContent as { details?: { approvalId?: string } }
    ).details?.approvalId;
    expect(rejectedApprovalId).toBeDefined();
    expect(harness.approvalRequests).toHaveLength(2);
    expect(
      harness.gateway.resolveApprovalFromExtension({
        sessionId: harness.remoteSessionId,
        approvalId: rejectedApprovalId!,
        result: 'rejected',
      }),
    ).toBe(true);
    const rejected = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: { ...rejectedArguments, remoteApprovalId: rejectedApprovalId },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      details: {
        remoteCode: 'APPROVAL_NOT_APPROVED',
        approvalId: rejectedApprovalId,
      },
    });
    expect(rejected.content[0]?.text).toContain('rejected by the user');
    expect(harness.dispatched).toHaveLength(3);

    const timeoutArguments = { ...writeArguments, content: 'Timed out remote note' };
    const timeoutRequired = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: timeoutArguments,
    });
    const timeoutApprovalId = (
      timeoutRequired.structuredContent as { details?: { approvalId?: string } }
    ).details?.approvalId;
    expect(timeoutApprovalId).toBeDefined();
    expect(harness.approvalRequests).toHaveLength(3);
    expect(
      harness.gateway.resolveApprovalFromExtension({
        sessionId: harness.remoteSessionId,
        approvalId: timeoutApprovalId!,
        result: 'timeout',
      }),
    ).toBe(true);
    const timedOut = await client.callTool({
      name: 'easyeda_schematic_add_text',
      arguments: { ...timeoutArguments, remoteApprovalId: timeoutApprovalId },
    });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      errorCode: 'ERR_REMOTE_RELAY',
      details: {
        remoteCode: 'APPROVAL_NOT_APPROVED',
        approvalId: timeoutApprovalId,
      },
    });
    expect(timedOut.content[0]?.text).toContain('expired');
    expect(harness.dispatched).toHaveLength(3);
  }, 15_000);

  it('keeps two independent MCP clients connected to the same paired extension session', async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);
    const first = harness.createClient('remote-http-client-a');
    const second = harness.createClient('remote-http-client-b');

    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]);

    expect(first.transport.sessionId).toBeDefined();
    expect(second.transport.sessionId).toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    expect(harness.httpTransport.activeSessionCount).toBe(2);
    expect(harness.closedSessionServerCount).toBe(0);

    const [firstResult, secondResult] = await Promise.all([
      first.client.callTool({
        name: 'easyeda_schematic_components',
        arguments: {
          projectId: 'project-client-a',
          remoteSessionId: harness.remoteSessionId,
        },
      }),
      second.client.callTool({
        name: 'easyeda_schematic_components',
        arguments: {
          projectId: 'project-client-b',
          remoteSessionId: harness.remoteSessionId,
        },
      }),
    ]);

    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).not.toBe(true);
    expect(harness.dispatched).toHaveLength(4);
    expect(harness.dispatched.map((request) => request.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'project-client-a' }),
        expect.objectContaining({ projectId: 'project-client-b' }),
      ]),
    );
    expect(
      harness.dispatched.every((request) => request.sessionId === harness.remoteSessionId),
    ).toBe(true);

    await first.transport.terminateSession();
    await first.client.close();
    await waitFor(
      () =>
        harness.httpTransport.activeSessionCount === 1 && harness.closedSessionServerCount === 1,
    );

    const survivingResult = await second.client.callTool({
      name: 'easyeda_schematic_components',
      arguments: {
        projectId: 'project-client-b-after-a-closed',
        remoteSessionId: harness.remoteSessionId,
      },
    });

    expect(survivingResult.isError).not.toBe(true);
    expect(harness.closedSessionServerCount).toBe(1);
    expect(harness.dispatched).toHaveLength(6);
    expect(harness.dispatched[4]).toMatchObject({
      sessionId: harness.remoteSessionId,
      input: { projectId: 'project-client-b-after-a-closed' },
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
} from '../../../src/remote/protocol.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';

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
    scopes: readonly ['easyeda.read', 'easyeda.write'];
  };
  gateway: RemoteGateway;
  remoteSessionId: string;
  dispatched: ToolRequestMessage[];
  approvalRequests: ApprovalRequestMessage[];
  readonly closedSessionServerCount: number;
  instance: McpServerInstance;
  httpTransport: HttpTransportInstance;
  createClient: (name: string) => {
    client: Client;
    transport: StreamableHTTPClientTransport;
  };
  close: () => Promise<void>;
}

async function createHarness(): Promise<RemoteHttpHarness> {
  const port = await reservePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'easyeda-remote-http-'));
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TOOL_PROFILE: 'core',
    TRANSPORT: 'http',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: port,
    HTTP_AUTH_DISABLED: true,
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
    scopes: ['easyeda.read', 'easyeda.write'] as const,
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
  const createClient = (name: string) => {
    const client = new Client({ name, version: '1.0.0' });
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

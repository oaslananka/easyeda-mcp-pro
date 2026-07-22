import { describe, expect, it } from 'vitest';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
  type ToolResponseMessage,
} from '../../../src/remote/protocol.js';

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('RemoteGateway session dispatch concurrency', () => {
  it('serializes concurrent tool calls that target the same extension session', async () => {
    const gateway = new RemoteGateway();
    const identity = { userId: 'shared-user', scopes: ['easyeda.read'] as const };
    const releases: Array<() => void> = [];
    const started: string[] = [];
    let activeDispatches = 0;
    let maxActiveDispatches = 0;

    const session = gateway.registerExtension({
      connectionId: 'conn-serialized',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Shared Project', documentType: 'schematic' },
      dispatch: async (request: ToolRequestMessage): Promise<ToolResponseMessage> => {
        activeDispatches += 1;
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
        started.push(request.toolName);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeDispatches -= 1;
        return {
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response',
          messageId: `response-${request.messageId}`,
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date().toISOString(),
          ok: true,
          result: { toolName: request.toolName },
          durationMs: 1,
        };
      },
    });

    const pairingCode = gateway.createPairingCode({ identity, sessionId: session.sessionId });
    expect(
      gateway.completePairing({ identity, code: pairingCode, sessionId: session.sessionId }),
    ).toBe(true);

    const first = gateway.routeToolRequest({
      identity,
      sessionId: session.sessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      input: { client: 'a' },
      deadlineMs: 1000,
    });
    await waitFor(() => releases.length === 1);

    const second = gateway.routeToolRequest({
      identity,
      sessionId: session.sessionId,
      toolName: 'schematic.listWires',
      riskLevel: 'read',
      input: { client: 'b' },
      deadlineMs: 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases).toHaveLength(1);
    expect(activeDispatches).toBe(1);
    expect(maxActiveDispatches).toBe(1);

    releases[0]!();
    await waitFor(() => releases.length === 2);
    expect(activeDispatches).toBe(1);
    expect(maxActiveDispatches).toBe(1);

    releases[1]!();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ ok: true, toolName: 'schematic.listComponents' });
    expect(secondResult).toMatchObject({ ok: true, toolName: 'schematic.listWires' });
    expect(started).toEqual(['schematic.listComponents', 'schematic.listWires']);
    expect(activeDispatches).toBe(0);
    expect(maxActiveDispatches).toBe(1);
  });

  it('quarantines a timed-out session before a queued request can dispatch', async () => {
    const gateway = new RemoteGateway();
    const identity = { userId: 'timeout-user', scopes: ['easyeda.read'] as const };
    const started: string[] = [];
    let closeConnectionCount = 0;
    let releaseLateResponse: (() => void) | undefined;

    const session = gateway.registerExtension({
      connectionId: 'conn-timeout-quarantine',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Timeout Project', documentType: 'schematic' },
      closeConnection: () => {
        closeConnectionCount += 1;
      },
      dispatch: async (request: ToolRequestMessage): Promise<ToolResponseMessage> => {
        started.push(request.toolName);
        return await new Promise<ToolResponseMessage>((resolve) => {
          releaseLateResponse = () =>
            resolve({
              protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
              type: 'tool_response',
              messageId: `late-response-${request.messageId}`,
              sessionId: request.sessionId,
              requestMessageId: request.messageId,
              timestamp: new Date().toISOString(),
              ok: true,
              result: { toolName: request.toolName },
              durationMs: 100,
            });
        });
      },
    });

    const pairingCode = gateway.createPairingCode({ identity, sessionId: session.sessionId });
    expect(
      gateway.completePairing({ identity, code: pairingCode, sessionId: session.sessionId }),
    ).toBe(true);

    const first = gateway.routeToolRequest({
      identity,
      sessionId: session.sessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      input: { client: 'first' },
      deadlineMs: 25,
    });
    await waitFor(() => started.length === 1);

    const queued = gateway.routeToolRequest({
      identity,
      sessionId: session.sessionId,
      toolName: 'schematic.listWires',
      riskLevel: 'read',
      input: { client: 'queued' },
      deadlineMs: 1000,
    });

    await expect(first).resolves.toMatchObject({
      ok: false,
      status: 504,
      code: 'REMOTE_EXTENSION_TIMEOUT',
    });
    await expect(queued).resolves.toMatchObject({
      ok: false,
      status: 424,
      code: 'SESSION_DISCONNECTED',
    });
    expect(started).toEqual(['schematic.listComponents']);
    expect(closeConnectionCount).toBe(1);
    expect(gateway.audit.recent(20)).toContainEqual(
      expect.objectContaining({
        event: 'remote.tool.failed',
        sessionId: session.sessionId,
        errorCode: 'REMOTE_EXTENSION_TIMEOUT',
      }),
    );

    releaseLateResponse?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['schematic.listComponents']);
  });
});

it('allows different extension sessions to execute concurrently without crossing results', async () => {
  const gateway = new RemoteGateway();
  const identity = { userId: 'parallel-user', scopes: ['easyeda.read'] as const };
  const releases = new Map<string, () => void>();
  let activeDispatches = 0;
  let maxActiveDispatches = 0;

  const register = (name: string) =>
    gateway.registerExtension({
      connectionId: `conn-${name}`,
      mode: 'hosted',
      extensionVersion: '0.35.1',
      activeProject: { projectName: name, documentType: 'schematic' },
      dispatch: async (request: ToolRequestMessage): Promise<ToolResponseMessage> => {
        activeDispatches += 1;
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
        await new Promise<void>((resolve) => releases.set(name, resolve));
        activeDispatches -= 1;
        return {
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response',
          messageId: `response-${request.messageId}`,
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date().toISOString(),
          ok: true,
          result: { projectName: name, sessionId: request.sessionId },
          durationMs: 1,
        };
      },
    });

  const sessionA = register('Project A');
  const sessionB = register('Project B');
  for (const session of [sessionA, sessionB]) {
    const code = gateway.createPairingCode({ identity, sessionId: session.sessionId });
    expect(gateway.completePairing({ identity, code, sessionId: session.sessionId })).toBe(true);
  }

  const requestA = gateway.routeToolRequest({
    identity,
    sessionId: sessionA.sessionId,
    toolName: 'schematic.listComponents',
    riskLevel: 'read',
    input: { expected: 'Project A' },
  });
  const requestB = gateway.routeToolRequest({
    identity,
    sessionId: sessionB.sessionId,
    toolName: 'schematic.listComponents',
    riskLevel: 'read',
    input: { expected: 'Project B' },
  });
  await waitFor(() => releases.size === 2);

  expect(activeDispatches).toBe(2);
  expect(maxActiveDispatches).toBe(2);
  releases.get('Project B')?.();
  releases.get('Project A')?.();

  await expect(requestA).resolves.toMatchObject({
    ok: true,
    sessionId: sessionA.sessionId,
    result: { projectName: 'Project A', sessionId: sessionA.sessionId },
  });
  await expect(requestB).resolves.toMatchObject({
    ok: true,
    sessionId: sessionB.sessionId,
    result: { projectName: 'Project B', sessionId: sessionB.sessionId },
  });
  expect(activeDispatches).toBe(0);
});

it('never routes an explicit session across paired user boundaries', async () => {
  const gateway = new RemoteGateway();
  const owner = { userId: 'session-owner', scopes: ['easyeda.read'] as const };
  const attacker = { userId: 'different-user', scopes: ['easyeda.read'] as const };
  let dispatchCount = 0;
  const session = gateway.registerExtension({
    connectionId: 'conn-owner-only',
    mode: 'hosted',
    extensionVersion: '0.35.1',
    activeProject: { projectName: 'Owner Project', documentType: 'schematic' },
    dispatch: async (request: ToolRequestMessage): Promise<ToolResponseMessage> => {
      dispatchCount += 1;
      return {
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: `response-${request.messageId}`,
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: new Date().toISOString(),
        ok: true,
        result: {},
        durationMs: 1,
      };
    },
  });
  const code = gateway.createPairingCode({ identity: owner, sessionId: session.sessionId });
  expect(gateway.completePairing({ identity: owner, code, sessionId: session.sessionId })).toBe(
    true,
  );

  await expect(
    gateway.routeToolRequest({
      identity: attacker,
      sessionId: session.sessionId,
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
    }),
  ).resolves.toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });
  expect(dispatchCount).toBe(0);
});

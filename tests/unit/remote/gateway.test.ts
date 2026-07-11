import { describe, expect, it } from 'vitest';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
} from '../../../src/remote/protocol.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import type { RemoteIdentity } from '../../../src/remote/scope.js';

function makeGateway(start = new Date('2026-07-04T00:00:00.000Z')) {
  let now = start;
  let counter = 0;
  const gateway = new RemoteGateway({
    now: () => now,
    makeId: () => `id-${++counter}`,
  });
  return {
    gateway,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

const readIdentity: RemoteIdentity = {
  userId: 'user-a',
  scopes: ['easyeda.read'],
};

const writeIdentity: RemoteIdentity = {
  userId: 'user-a',
  scopes: ['easyeda.write'],
};

function registerFakeExtension(gateway: RemoteGateway, dispatches: ToolRequestMessage[] = []) {
  return gateway.registerExtension({
    connectionId: 'conn-a',
    mode: 'hosted',
    extensionVersion: '0.19.0',
    activeProject: { projectName: 'Demo', documentType: 'schematic' },
    dispatch: async (request) => {
      dispatches.push(request);
      return {
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: `response-${request.messageId}`,
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
        ok: true,
        result: { routed: true, toolName: request.toolName },
        durationMs: 4,
      };
    },
  });
}

describe('RemoteGateway', () => {
  it('pairs a fake extension and routes a read request', async () => {
    const { gateway } = makeGateway();
    const dispatches: ToolRequestMessage[] = [];
    const session = registerFakeExtension(gateway, dispatches);
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });

    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    const result = await gateway.routeToolRequest({
      identity: readIdentity,
      toolName: 'easyeda_board_read',
      riskLevel: 'read',
      input: { projectId: 'demo' },
    });

    expect(result).toMatchObject({ ok: true, sessionId: session.sessionId });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      type: 'tool_request',
      sessionId: session.sessionId,
      toolName: 'easyeda_board_read',
      riskLevel: 'read',
      requiresApproval: false,
    });
  });

  it('fails closed for unpaired, disconnected, and expired sessions', async () => {
    const harness = makeGateway();
    const session = registerFakeExtension(harness.gateway);

    await expect(
      harness.gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_board_read',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });

    const code = harness.gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      harness.gateway.completePairing({
        identity: readIdentity,
        code,
        sessionId: session.sessionId,
      }),
    ).toBe(true);
    harness.gateway.disconnect(session.sessionId);

    await expect(
      harness.gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_board_read',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_DISCONNECTED' });

    const shortSession = harness.gateway.registerExtension({
      connectionId: 'conn-expired',
      mode: 'hosted',
      extensionVersion: '0.19.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      ttlMs: 5,
      dispatch: async (request) => ({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: 'response-expired',
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
        ok: true,
        result: {},
        durationMs: 1,
      }),
    });
    const shortCode = harness.gateway.createPairingCode({
      identity: readIdentity,
      sessionId: shortSession.sessionId,
    });
    expect(
      harness.gateway.completePairing({
        identity: readIdentity,
        code: shortCode,
        sessionId: shortSession.sessionId,
      }),
    ).toBe(true);
    harness.advance(6);

    await expect(
      harness.gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: shortSession.sessionId,
        toolName: 'easyeda_board_read',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
  });

  it('enforces scopes and approval for risky requests', async () => {
    const { gateway } = makeGateway();
    const session = registerFakeExtension(gateway);
    const code = gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: writeIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    await expect(
      gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_pcb_place_component',
        riskLevel: 'write',
        input: { refdes: 'U1' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SCOPE_MISSING' });

    await expect(
      gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_pcb_place_component',
        riskLevel: 'write',
        input: { refdes: 'U1' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });

    gateway.approvals.request({
      approvalId: 'approval-1',
      userId: writeIdentity.userId,
      sessionId: session.sessionId,
      toolName: 'easyeda_pcb_place_component',
      riskLevel: 'write',
      inputHash: '1deae6382c4ec4ed5fd1f24dc3f975ee73fb83a5b0621d7b52cc9a1d0e9f655b',
      actionSummary: 'Place component',
      activeProject: session.activeProject,
      expiresAt: new Date('2026-07-04T00:05:00.000Z'),
    });
    gateway.approvals.resolve('approval-1', 'approved', new Date('2026-07-04T00:00:00.000Z'));

    await expect(
      gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_pcb_place_component',
        riskLevel: 'write',
        input: { refdes: 'U1' },
        approvalId: 'approval-1',
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('distinguishes unsupported extension methods from generic extension failures', async () => {
    const { gateway } = makeGateway();
    const session = gateway.registerExtension({
      connectionId: 'conn-unsupported',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      dispatch: async (request) => ({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: 'response-unsupported',
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: new Date('2026-07-04T00:00:00.000Z').toISOString(),
        ok: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Method is not in the extension allowlist.',
        },
        durationMs: 1,
      }),
    });
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    await expect(
      gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.unsupportedMethod',
        riskLevel: 'read',
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      code: 'REMOTE_TOOL_UNSUPPORTED',
      message: expect.stringContaining('METHOD_NOT_ALLOWED'),
    });
  });

  it('enforces the request deadline for every dispatcher', async () => {
    const { gateway } = makeGateway();
    const session = gateway.registerExtension({
      connectionId: 'conn-timeout',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      dispatch: async () => await new Promise(() => undefined),
    });
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    await expect(
      gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.getDocument',
        riskLevel: 'read',
        deadlineMs: 5,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 504,
      code: 'REMOTE_EXTENSION_TIMEOUT',
      message: expect.stringContaining('5ms'),
    });
  });

  it('keeps non-timeout dispatcher failures in the extension error category', async () => {
    const { gateway } = makeGateway();
    const session = gateway.registerExtension({
      connectionId: 'conn-error',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      dispatch: () => {
        throw new Error('Remote relay socket closed unexpectedly.');
      },
    });
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    await expect(
      gateway.routeToolRequest({
        identity: readIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.getDocument',
        riskLevel: 'read',
        deadlineMs: 100,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      code: 'REMOTE_EXTENSION_ERROR',
      message: 'Remote relay socket closed unexpectedly.',
    });
  });
});

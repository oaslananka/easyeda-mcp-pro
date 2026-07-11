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
    requestApproval: () => undefined,
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

  it('authorizes a whole MCP invocation and rejects its private grant after revocation', async () => {
    const { gateway } = makeGateway();
    const approvalRequests: Array<{ approvalId: string }> = [];
    const dispatches: ToolRequestMessage[] = [];
    const session = gateway.registerExtension({
      connectionId: 'conn-invocation-grant',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      requestApproval: (request) => {
        approvalRequests.push(request);
      },
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
          result: { method: request.toolName },
          durationMs: 1,
        };
      },
    });
    const code = gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    gateway.completePairing({ identity: writeIdentity, code, sessionId: session.sessionId });

    const invocation = {
      identity: writeIdentity,
      sessionId: session.sessionId,
      toolName: 'easyeda_schematic_batch',
      riskLevel: 'write' as const,
      input: { operations: [{ kind: 'text' }, { kind: 'rectangle' }] },
    };
    const pending = await gateway.authorizeToolInvocation(invocation);
    expect(pending).toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
      approvalId: expect.stringMatching(/^appr_/),
    });
    if (pending.ok || !pending.approvalId) throw new Error('Expected an approval id.');
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'easyeda_schematic_batch',
      riskLevel: 'write',
    });

    expect(
      gateway.resolveApprovalFromExtension({
        sessionId: session.sessionId,
        approvalId: pending.approvalId,
        result: 'approved',
      }),
    ).toBe(true);
    const authorized = await gateway.authorizeToolInvocation({
      ...invocation,
      approvalId: pending.approvalId,
    });
    expect(authorized).toMatchObject({
      ok: true,
      sessionId: session.sessionId,
      grantId: expect.stringMatching(/^grant_/),
    });
    if (!authorized.ok) throw new Error('Expected an invocation grant.');

    await expect(
      gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.addText',
        riskLevel: 'write',
        input: { content: 'one' },
        grantId: authorized.grantId,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.addRectangle',
        riskLevel: 'write',
        input: { width: 10, height: 5 },
        grantId: authorized.grantId,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(dispatches).toHaveLength(2);

    expect(gateway.revokeInvocationGrant(authorized.grantId)).toBe(true);
    await expect(
      gateway.routeToolRequest({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic.addText',
        riskLevel: 'write',
        input: { content: 'late' },
        grantId: authorized.grantId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
    expect(dispatches).toHaveLength(2);
  });

  it('fails closed when a risky connection has no approval UI', async () => {
    const { gateway } = makeGateway();
    const session = gateway.registerExtension({
      connectionId: 'conn-no-approval-ui',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      dispatch: async () => {
        throw new Error('dispatch must not run');
      },
    });
    const code = gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    gateway.completePairing({ identity: writeIdentity, code, sessionId: session.sessionId });

    await expect(
      gateway.authorizeToolInvocation({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'easyeda_schematic_add_text',
        riskLevel: 'write',
        input: { content: 'blocked' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 424,
      code: 'APPROVAL_UI_UNAVAILABLE',
    });
  });

  it('requests approval once, binds the decision to the session, and consumes it once', async () => {
    const { gateway } = makeGateway();
    const approvalRequests: Array<{ approvalId: string }> = [];
    const dispatches: ToolRequestMessage[] = [];
    const session = gateway.registerExtension({
      connectionId: 'conn-approval',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      requestApproval: (request) => {
        approvalRequests.push(request);
      },
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
          result: { primitiveId: 'text-1' },
          durationMs: 1,
        };
      },
    });
    const code = gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: writeIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    const request = {
      identity: writeIdentity,
      sessionId: session.sessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write' as const,
      input: { x: 10, y: 20, content: 'Remote note' },
    };
    const first = await gateway.routeToolRequest(request);
    expect(first).toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
      approvalId: expect.stringMatching(/^appr_/),
      approvalExpiresAt: expect.any(String),
    });
    if (first.ok || !first.approvalId) throw new Error('Expected an approval id.');

    const duplicate = await gateway.routeToolRequest(request);
    expect(duplicate).toMatchObject({ approvalId: first.approvalId });
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      approvalId: first.approvalId,
      sessionId: session.sessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write',
    });

    expect(
      gateway.resolveApprovalFromExtension({
        sessionId: 'different-session',
        approvalId: first.approvalId,
        result: 'approved',
      }),
    ).toBe(false);
    expect(
      gateway.resolveApprovalFromExtension({
        sessionId: session.sessionId,
        approvalId: first.approvalId,
        result: 'approved',
      }),
    ).toBe(true);

    await expect(
      gateway.routeToolRequest({ ...request, approvalId: first.approvalId }),
    ).resolves.toMatchObject({ ok: true, result: { primitiveId: 'text-1' } });
    expect(dispatches).toHaveLength(1);

    await expect(
      gateway.routeToolRequest({ ...request, approvalId: first.approvalId }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
    expect(dispatches).toHaveLength(1);
  });

  it('reports rejected and expired approvals and clears pending records on disconnect', async () => {
    const harness = makeGateway();
    const session = harness.gateway.registerExtension({
      connectionId: 'conn-approval-state',
      mode: 'hosted',
      extensionVersion: '0.32.0',
      activeProject: { projectName: 'Demo', documentType: 'schematic' },
      requestApproval: () => undefined,
      dispatch: async () => {
        throw new Error('Dispatch must not run without approval.');
      },
    });
    const code = harness.gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    harness.gateway.completePairing({
      identity: writeIdentity,
      code,
      sessionId: session.sessionId,
    });

    const base = {
      identity: writeIdentity,
      sessionId: session.sessionId,
      toolName: 'schematic.addText',
      riskLevel: 'write' as const,
    };
    const rejected = await harness.gateway.routeToolRequest({
      ...base,
      input: { content: 'reject-me' },
    });
    if (rejected.ok || !rejected.approvalId) throw new Error('Expected rejected approval id.');
    harness.gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: rejected.approvalId,
      result: 'rejected',
    });
    await expect(
      harness.gateway.routeToolRequest({
        ...base,
        input: { content: 'reject-me' },
        approvalId: rejected.approvalId,
      }),
    ).resolves.toMatchObject({ message: 'Remote approval was rejected by the user.' });

    const expiring = await harness.gateway.routeToolRequest({
      ...base,
      input: { content: 'expire-me' },
    });
    if (expiring.ok || !expiring.approvalId) throw new Error('Expected expiring approval id.');
    harness.advance(60_001);
    await expect(
      harness.gateway.routeToolRequest({
        ...base,
        input: { content: 'expire-me' },
        approvalId: expiring.approvalId,
      }),
    ).resolves.toMatchObject({ message: 'Remote approval expired.' });

    const pending = await harness.gateway.routeToolRequest({
      ...base,
      input: { content: 'disconnect-me' },
    });
    if (pending.ok || !pending.approvalId) throw new Error('Expected pending approval id.');
    expect(harness.gateway.approvals.get(pending.approvalId)).toBeDefined();
    harness.gateway.disconnect(session.sessionId);
    expect(harness.gateway.approvals.get(pending.approvalId)).toBeUndefined();
  });
});

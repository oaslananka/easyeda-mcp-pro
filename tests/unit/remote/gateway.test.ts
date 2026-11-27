import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
} from '../../../src/remote/protocol.js';
import { RemoteGateway, type RemoteGatewayOptions } from '../../../src/remote/gateway.js';
import type { RemoteIdentity } from '../../../src/remote/scope.js';

function makeGateway(
  start = new Date('2026-07-04T00:00:00.000Z'),
  options?: Partial<RemoteGatewayOptions>,
) {
  let now = start;
  let counter = 0;
  const gateway = new RemoteGateway({
    now: () => now,
    makeId: () => `id-${++counter}`,
    ...options,
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
  it('allows extension RPC only through a matching one-use MCP invocation grant', async () => {
    const { gateway } = makeGateway(undefined, { toolRiskResolver: () => 'read' });
    const dispatches: ToolRequestMessage[] = [];
    const session = registerFakeExtension(gateway, dispatches);
    const identity: RemoteIdentity = { userId: 'user-a', scopes: ['easyeda.project_admin'] };
    const code = gateway.createPairingCode({ identity, sessionId: session.sessionId });
    expect(gateway.completePairing({ identity, code, sessionId: session.sessionId })).toBe(true);
    const input = { topic: 'mcp.demo.echo', timeoutMs: 1000, confirmWrite: true };
    const route = {
      identity,
      sessionId: session.sessionId,
      toolName: 'extension.rpcCall',
      riskLevel: 'read' as const,
      input: { ...input, message: null },
    };
    await expect(
      gateway.routeToolRequest({ ...route, identity: readIdentity }),
    ).resolves.toMatchObject({ ok: false, code: 'SCOPE_MISSING' });
    await expect(gateway.routeToolRequest(route)).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_NOT_APPROVED',
    });
    const invocation = {
      identity,
      sessionId: session.sessionId,
      toolName: 'easyeda_extension_call',
      riskLevel: 'destructive' as const,
      input,
    };
    await expect(
      gateway.authorizeToolInvocation({
        ...invocation,
        input: { ...input, topic: 'mcp.demo\nApprove a different service' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    const approve = async (toolName: string) => {
      const pending = await gateway.authorizeToolInvocation({ ...invocation, toolName });
      if (pending.ok || !pending.approvalId) throw Error('expected approval');
      expect(
        gateway.resolveApprovalFromExtension({
          sessionId: session.sessionId,
          approvalId: pending.approvalId,
          result: 'approved',
        }),
      ).toBe(true);
      const grant = await gateway.authorizeToolInvocation({
        ...invocation,
        toolName,
        approvalId: pending.approvalId,
      });
      if (!grant.ok) throw Error('expected grant');
      return grant.grantId;
    };
    const unrelated = await approve('easyeda_api_call');
    await expect(gateway.routeToolRequest({ ...route, grantId: unrelated })).resolves.toMatchObject(
      { ok: false, code: 'APPROVAL_NOT_APPROVED' },
    );
    const grantId = await approve('easyeda_extension_call');
    await expect(
      gateway.routeToolRequest({
        ...route,
        grantId,
        input: { ...route.input, topic: 'mcp.demo.other' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
    expect(dispatches).toHaveLength(0);
    await expect(gateway.routeToolRequest({ ...route, grantId })).resolves.toMatchObject({
      ok: true,
    });
    expect(dispatches[0]).toMatchObject({ riskLevel: 'destructive', requiresApproval: true });
    await expect(gateway.routeToolRequest({ ...route, grantId })).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_NOT_APPROVED',
    });
    expect(dispatches).toHaveLength(1);
  });

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

  it('rejects client risk-level downgrade for mutating tools', async () => {
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
      toolName: 'schematic.deleteComponent',
      riskLevel: 'read',
      input: { componentId: 'U1' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'SCOPE_MISSING',
    });
    expect(dispatches).toHaveLength(0);

    // Test export tool risk resolution
    const exportResult = await gateway.routeToolRequest({
      identity: readIdentity,
      toolName: 'project.exportBOM',
      riskLevel: 'read',
      input: {},
    });
    expect(exportResult).toMatchObject({
      ok: false,
      status: 403,
      code: 'SCOPE_MISSING',
    });

    // Test custom toolRiskResolver
    const { gateway: customGateway } = makeGateway(undefined, {
      toolRiskResolver: (name) => (name === 'custom_safe' ? 'read' : 'destructive'),
    });
    const customSession = registerFakeExtension(customGateway, dispatches);
    const customCode = customGateway.createPairingCode({
      identity: readIdentity,
      sessionId: customSession.sessionId,
    });
    customGateway.completePairing({
      identity: readIdentity,
      code: customCode,
      sessionId: customSession.sessionId,
    });
    const customResult = await customGateway.routeToolRequest({
      identity: readIdentity,
      toolName: 'custom_mutating',
      riskLevel: 'read',
      input: {},
    });
    expect(customResult).toMatchObject({
      ok: false,
      status: 403,
      code: 'SCOPE_MISSING',
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

  it('bounds untrusted dispatcher deadlines before allocating a timer', async () => {
    const { gateway } = makeGateway();
    const session = registerFakeExtension(gateway);
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(
        gateway.routeToolRequest({
          identity: readIdentity,
          sessionId: session.sessionId,
          toolName: 'schematic.getDocument',
          riskLevel: 'read',
          deadlineMs: Number.MAX_SAFE_INTEGER,
        }),
      ).resolves.toMatchObject({ ok: true });

      const scheduledDeadlines = timerSpy.mock.calls
        .map(([, duration]) => duration)
        .filter((duration): duration is number => typeof duration === 'number');
      expect(scheduledDeadlines.length).toBeGreaterThan(0);
      expect(scheduledDeadlines).not.toContain(Number.MAX_SAFE_INTEGER);
      expect(
        scheduledDeadlines.every((duration) =>
          [120_000, 30_000, 10_000, 1_000, 100, 10, 1].includes(duration),
        ),
      ).toBe(true);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('does not use untrusted deadline values as timer durations', async () => {
    const { gateway } = makeGateway();
    const session = registerFakeExtension(gateway);
    const code = gateway.createPairingCode({
      identity: readIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({ identity: readIdentity, code, sessionId: session.sessionId }),
    ).toBe(true);

    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(
        gateway.routeToolRequest({
          identity: readIdentity,
          sessionId: session.sessionId,
          toolName: 'schematic.getDocument',
          riskLevel: 'read',
          deadlineMs: 37,
        }),
      ).resolves.toMatchObject({ ok: true });

      const relayDurations = timerSpy.mock.calls
        .map(([, duration]) => duration)
        .filter((duration): duration is number => typeof duration === 'number');
      expect(relayDurations.length).toBeGreaterThan(0);
      expect(relayDurations).not.toContain(37);
      expect(
        relayDurations.every((duration) =>
          [120_000, 30_000, 10_000, 1_000, 100, 10, 1].includes(duration),
        ),
      ).toBe(true);
    } finally {
      timerSpy.mockRestore();
    }
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

  it('fails closed before issuing grants when scope, route, or approval binding is invalid', async () => {
    const { gateway } = makeGateway();

    await expect(
      gateway.authorizeToolInvocation({
        identity: readIdentity,
        toolName: 'schematic_batch',
        riskLevel: 'write',
      }),
    ).resolves.toMatchObject({ ok: false, status: 403, code: 'SCOPE_MISSING' });

    await expect(
      gateway.authorizeToolInvocation({
        identity: writeIdentity,
        toolName: 'schematic_batch',
        riskLevel: 'write',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_UNPAIRED' });

    const session = registerFakeExtension(gateway);
    const pairingCode = gateway.createPairingCode({
      identity: writeIdentity,
      sessionId: session.sessionId,
    });
    expect(
      gateway.completePairing({
        identity: writeIdentity,
        code: pairingCode,
        sessionId: session.sessionId,
      }),
    ).toBe(true);

    await expect(
      gateway.authorizeToolInvocation({
        identity: writeIdentity,
        sessionId: session.sessionId,
        toolName: 'schematic_batch',
        riskLevel: 'write',
        input: { operations: [] },
        approvalId: 'missing-approval',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
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

describe('Project-session native consent', () => {
  const identity: RemoteIdentity = {
    userId: 'owner',
    clientId: 'trusted-mcp-client',
    scopes: ['easyeda.write', 'easyeda.export', 'easyeda.project_admin'],
  };
  const firstProject = {
    projectId: 'native-project-1',
    documentId: 'schematic-page-1',
    projectName: 'Disposable',
    documentType: 'schematic' as const,
  };

  function connected() {
    const clock = makeGateway();
    const approvals: Array<{ approvalId: string; actionSummary: string }> = [];
    const session = clock.gateway.registerExtension({
      connectionId: 'session-consent-connection',
      mode: 'hosted',
      extensionVersion: '1.15.6',
      activeProject: firstProject,
      requestApproval: (request) => {
        approvals.push(request);
      },
      dispatch: async (request) => ({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        type: 'tool_response',
        messageId: 'native-response',
        sessionId: request.sessionId,
        requestMessageId: request.messageId,
        timestamp: '2026-07-04T00:00:00.000Z',
        ok: true,
        result: { primitiveId: 'verified-text' },
        durationMs: 1,
      }),
    });
    const code = clock.gateway.createPairingCode({ identity, sessionId: session.sessionId });
    expect(clock.gateway.completePairing({ identity, code, sessionId: session.sessionId })).toBe(
      true,
    );
    return { ...clock, session, approvals };
  }

  it('turns one native-approved routine write into a 30 minute project and client-scoped grant', async () => {
    const { gateway, session, approvals } = connected();
    const input = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      input: { text: 'first' },
      sessionApprovalEligible: true,
    };
    const pending = await gateway.authorizeToolInvocation(input);
    expect(pending).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    if (pending.ok || !pending.approvalId) throw new Error('Missing first native consent');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.actionSummary).toContain('30 minutes');
    expect(
      gateway.resolveApprovalFromExtension({
        sessionId: session.sessionId,
        approvalId: pending.approvalId,
        result: 'approved',
      }),
    ).toBe(true);
    const original = await gateway.authorizeToolInvocation({
      ...input,
      approvalId: pending.approvalId,
    });
    expect(original).toMatchObject({ ok: true });
    const next = await gateway.authorizeToolInvocation({
      ...input,
      toolName: 'easyeda_schematic_add_wire',
      input: { wire: 'second' },
    });
    expect(next).toMatchObject({ ok: true });
    expect(approvals).toHaveLength(1);
    if (original.ok) gateway.revokeInvocationGrant(original.grantId);
    if (next.ok) gateway.revokeInvocationGrant(next.grantId);
    // An explicit stale approval ID must still be rejected despite an active project grant.
    await expect(
      gateway.authorizeToolInvocation({
        ...input,
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
  });

  it('never bypasses a server-elevated destructive risk through a forged session eligibility flag', async () => {
    const { gateway, session } = connected();
    const first = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const pending = await gateway.authorizeToolInvocation(first);
    if (pending.ok || !pending.approvalId) throw new Error('Initial approval missing');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({
        ...first,
        approvalId: pending.approvalId,
      }),
    ).toMatchObject({ ok: true });
    const elevated = {
      ...first,
      toolName: 'easyeda_schematic_delete_primitive',
    };
    // Main branch #1070 independently raises the effective risk to destructive.
    const result = await gateway.authorizeToolInvocation(elevated);
    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(result.ok ? 'ok' : result.approvalId).toBeTruthy();
  });

  it('fails closed for other clients, other risk classes and destructive operations', async () => {
    const { gateway, session } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      toolName: 'easyeda_schematic_add_text',
      riskLevel: 'write' as const,
      sessionApprovalEligible: true,
      input: { note: 'first' },
    };
    const pending = await gateway.authorizeToolInvocation(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected native approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({
        ...request,
        approvalId: pending.approvalId,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        identity: { ...identity, clientId: 'another-mcp-client' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        identity: { ...identity, clientId: undefined },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        sessionApprovalEligible: false,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        riskLevel: 'export',
        toolName: 'easyeda_export_bom',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        riskLevel: 'destructive',
        toolName: 'easyeda_schematic_delete_primitive',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
  });

  it('expires, revokes, and never authorizes another project after its native selection changes', async () => {
    const { gateway, session, advance } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const initial = await gateway.authorizeToolInvocation(request);
    if (initial.ok || !initial.approvalId) throw new Error('Expected native approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: initial.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({
        ...request,
        approvalId: initial.approvalId,
      }),
    ).toMatchObject({ ok: true });
    advance(30 * 60_000 + 1);
    await expect(gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
    });
    gateway.router.updateActiveProject(session.sessionId, {
      ...firstProject,
      projectId: 'native-project-2',
      documentId: 'schematic-page-2',
    });
    await expect(gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
    });
    gateway.disconnect(session.sessionId);
    await expect(gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
      code: 'SESSION_DISCONNECTED',
    });
  });

  it('survives OAuth token refresh for the same client but not an expired token', async () => {
    const { gateway, session, advance } = connected();
    const before = { ...identity, expiresAt: new Date('2026-07-04T00:05:00.000Z') };
    const request = {
      identity: before,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const pending = await gateway.authorizeToolInvocation(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected native approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({ ...request, approvalId: pending.approvalId }),
    ).toMatchObject({ ok: true });
    advance(6 * 60_000);
    await expect(gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
      code: 'IDENTITY_EXPIRED',
    });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        identity: { ...identity, expiresAt: new Date('2026-07-04T01:00:00.000Z') },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('does not carry a still-valid grant to another native project', async () => {
    const { gateway, session, approvals } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const first = await gateway.authorizeToolInvocation(request);
    if (first.ok || !first.approvalId) throw new Error('Expected native approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: first.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({
        ...request,
        approvalId: first.approvalId,
      }),
    ).toMatchObject({ ok: true });

    gateway.router.updateActiveProject(session.sessionId, {
      ...firstProject,
      projectId: 'native-project-2',
      documentId: 'schematic-page-2',
    });
    expect(await gateway.authorizeToolInvocation(request)).toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
    });
    expect(approvals).toHaveLength(2);

    // A different native page inside the same selected project shares the grant.
    gateway.router.updateActiveProject(session.sessionId, {
      ...firstProject,
      documentId: 'schematic-page-3',
    });
    expect(await gateway.authorizeToolInvocation(request)).toMatchObject({ ok: true });
  });

  it('requires a new native approval after revoking a paired session', async () => {
    const { gateway, session } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const first = await gateway.authorizeToolInvocation(request);
    if (first.ok || !first.approvalId) throw new Error('Expected approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: first.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({ ...request, approvalId: first.approvalId }),
    ).toMatchObject({ ok: true });
    expect(gateway.revokePairedExtension(identity, session.sessionId)).toBe(true);
    await expect(gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('does not upgrade a one-action prompt into a 30-minute grant', async () => {
    const { gateway, session } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      input: { text: 'one-action' },
    };
    const pending = await gateway.routeToolRequest(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected native one-action approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    expect(
      await gateway.authorizeToolInvocation({
        ...request,
        sessionApprovalEligible: true,
        approvalId: pending.approvalId,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        sessionApprovalEligible: true,
        input: { text: 'second' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
  });

  it('cannot consume another OAuth client approval on the same owner and native session', async () => {
    const { gateway, session } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
      input: { text: 'first' },
    };
    const pending = await gateway.authorizeToolInvocation(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        identity: { ...identity, clientId: 'different-oauth-client' },
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
    expect(
      await gateway.authorizeToolInvocation({
        ...request,
        approvalId: pending.approvalId,
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects even the original native approval when the document has switched since prompting', async () => {
    const { gateway, session } = connected();
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const pending = await gateway.authorizeToolInvocation(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected approval');
    gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    gateway.router.updateActiveProject(session.sessionId, {
      ...firstProject,
      documentId: 'another-document',
    });
    await expect(
      gateway.authorizeToolInvocation({
        ...request,
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
  });

  it('never remembers a grant without verified native project UUID or client identity', async () => {
    const clock = makeGateway();
    const session = registerFakeExtension(clock.gateway);
    const code = clock.gateway.createPairingCode({ identity, sessionId: session.sessionId });
    clock.gateway.completePairing({ identity, code, sessionId: session.sessionId });
    const request = {
      identity,
      sessionId: session.sessionId,
      riskLevel: 'write' as const,
      toolName: 'easyeda_schematic_add_text',
      sessionApprovalEligible: true,
    };
    const pending = await clock.gateway.authorizeToolInvocation(request);
    if (pending.ok || !pending.approvalId) throw new Error('Expected approval');
    clock.gateway.resolveApprovalFromExtension({
      sessionId: session.sessionId,
      approvalId: pending.approvalId,
      result: 'approved',
    });
    expect(
      await clock.gateway.authorizeToolInvocation({
        ...request,
        approvalId: pending.approvalId,
      }),
    ).toMatchObject({ ok: true });
    await expect(clock.gateway.authorizeToolInvocation(request)).resolves.toMatchObject({
      ok: false,
      code: 'APPROVAL_REQUIRED',
    });
  });
});

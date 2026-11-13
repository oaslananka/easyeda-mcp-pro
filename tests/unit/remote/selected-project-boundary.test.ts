import { describe, expect, it } from 'vitest';
import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  type ToolRequestMessage,
} from '../../../src/remote/protocol.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import type { RemoteIdentity } from '../../../src/remote/scope.js';

const owner: RemoteIdentity = { userId: 'owner-a', scopes: ['easyeda.read'] };
const outsider: RemoteIdentity = { userId: 'owner-b', scopes: ['easyeda.read'] };

describe('explicit hosted extension/project selection', () => {
  it('requires an owner-selected project when multiple extensions are paired and fails closed after a project swap', async () => {
    const gateway = new RemoteGateway();
    const dispatched: string[] = [];
    const register = (connectionId: string, projectId: string) =>
      gateway.registerExtension({
        connectionId,
        mode: 'hosted',
        extensionVersion: '1.15.4',
        activeProject: { projectId, projectName: projectId, documentType: 'pcb' },
        dispatch: async (request: ToolRequestMessage) => {
          dispatched.push(request.sessionId);
          return {
            protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
            type: 'tool_response',
            messageId: 'response-' + dispatched.length,
            sessionId: request.sessionId,
            requestMessageId: request.messageId,
            timestamp: new Date().toISOString(),
            ok: true,
            result: {},
            durationMs: 1,
          };
        },
      });
    const first = register('device-1', 'pcb-a');
    const second = register('device-2', 'pcb-b');
    for (const session of [first, second]) {
      const code = gateway.createPairingCode({ identity: owner, sessionId: session.sessionId });
      expect(gateway.completePairing({ identity: owner, code, sessionId: session.sessionId })).toBe(
        true,
      );
    }

    const call = (sessionId?: string) =>
      gateway.routeToolRequest({
        identity: owner,
        sessionId,
        riskLevel: 'read',
        toolName: 'easyeda_board_read',
      });

    await expect(call()).resolves.toMatchObject({ ok: false, code: 'SESSION_AMBIGUOUS' });
    expect(gateway.selectPairedProject(outsider, first.sessionId)).toBe(false);
    expect(gateway.selectPairedProject(owner, first.sessionId)).toBe(true);
    expect(gateway.getSelectedProject(owner)).toMatchObject({
      sessionId: first.sessionId,
      projectId: 'pcb-a',
    });
    await expect(call()).resolves.toMatchObject({ ok: true, sessionId: first.sessionId });
    await expect(call(second.sessionId)).resolves.toMatchObject({
      ok: false,
      code: 'SESSION_UNPAIRED',
    });
    expect(dispatched).toHaveLength(1);

    gateway.router.updateActiveProject(first.sessionId, {
      projectId: 'pcb-changed',
      projectName: 'Different board',
      documentType: 'pcb',
    });
    await expect(call()).resolves.toMatchObject({ ok: false, code: 'PROJECT_INACTIVE' });
    expect(dispatched).toHaveLength(1);

    expect(gateway.selectPairedProject(owner, second.sessionId)).toBe(true);
    await expect(call()).resolves.toMatchObject({ ok: true, sessionId: second.sessionId });
    expect(gateway.revokePairedExtension(owner, second.sessionId)).toBe(true);
    expect(gateway.getSelectedProject(owner)).toBeUndefined();
  });
});

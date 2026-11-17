import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteAuditLog } from '../../../src/remote/observability.js';
import { RemoteGateway } from '../../../src/remote/gateway.js';
import { REMOTE_RELAY_PROTOCOL_VERSION } from '../../../src/remote/protocol.js';
import { HostedUsageStore, createHostedUsageAuditLog } from '../../../src/cloud/usage.js';

describe('Hosted Cloud relay accounting integration', () => {
  it('counts only completed owner-bound native dispatches, not rejected attempts', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      const usage = new HostedUsageStore(database);
      const gateway = new RemoteGateway({ audit: createHostedUsageAuditLog(usage) });
      gateway.requireExplicitProjectSelection();
      const owner = { userId: 'owner-a', scopes: ['easyeda.read'] as const };
      const session = gateway.registerExtension({
        connectionId: 'fixture-extension',
        mode: 'hosted',
        extensionVersion: '1.15.6',
        activeProject: {
          projectId: 'disposable-project',
          documentId: 'disposable-document',
          projectName: 'Disposable Test',
          documentType: 'pcb',
        },
        dispatch: async (request) => ({
          protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
          type: 'tool_response' as const,
          messageId: 'response-' + request.messageId,
          sessionId: request.sessionId,
          requestMessageId: request.messageId,
          timestamp: new Date().toISOString(),
          ok: request.toolName !== 'fixture_failed_read',
          ...(request.toolName !== 'fixture_failed_read'
            ? { result: { count: 33 } }
            : { error: { code: 'TEST_READ_FAILED', message: 'fixture read failed' } }),
          durationMs: 3,
        }),
      });
      const code = gateway.createPairingCode({ identity: owner, sessionId: session.sessionId });
      expect(gateway.completePairing({ identity: owner, code, sessionId: session.sessionId })).toBe(
        true,
      );
      expect(gateway.selectPairedProject(owner, session.sessionId)).toBe(true);

      const read = {
        identity: owner,
        sessionId: session.sessionId,
        riskLevel: 'read' as const,
      };
      await expect(
        gateway.routeToolRequest({
          ...read,
          toolName: 'easyeda_pcb_components',
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        gateway.routeToolRequest({
          ...read,
          toolName: 'fixture_failed_read',
        }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        gateway.routeToolRequest({
          identity: { userId: 'owner-b', scopes: ['easyeda.read'] },
          sessionId: session.sessionId,
          riskLevel: 'read',
          toolName: 'easyeda_pcb_components',
        }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        gateway.routeToolRequest({
          identity: owner,
          sessionId: session.sessionId,
          riskLevel: 'write',
          toolName: 'easyeda_pcb_place_component',
        }),
      ).resolves.toMatchObject({ ok: false, code: 'SCOPE_MISSING' });
      expect(usage.totals('owner-a')).toMatchObject({
        total: 2,
        succeeded: 1,
        failed: 1,
      });
      expect(usage.totals('owner-b').total).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe('Hosted Cloud terminal log safety', () => {
  it('displays only actual registered tool names, never an arbitrary client tool label', () => {
    const database = new DatabaseSync(':memory:');
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const audit = createHostedUsageAuditLog(
        new HostedUsageStore(database),
        new Set(['easyeda_pcb_components']),
      );
      audit.record({
        event: 'remote.tool.failed',
        mode: 'hosted',
        userId: 'disposable-test-owner',
        toolName: 'ACCESS_TOKEN_FAKE_NEVER_LOG_THIS',
        durationMs: 2,
      });
      audit.record({
        event: 'remote.tool.completed',
        mode: 'hosted',
        userId: 'disposable-test-owner',
        toolName: 'easyeda_pcb_components',
        durationMs: 3,
      });
      const printed = output.mock.calls.map(([value]) => String(value)).join('');
      expect(printed).not.toContain('ACCESS_TOKEN_FAKE_NEVER_LOG_THIS');
      expect(printed).toContain('unknown-tool');
      expect(printed).toContain('easyeda_pcb_components');
      expect(printed).toContain('call #2');
    } finally {
      output.mockRestore();
      database.close();
    }
  });
});

describe('Hosted Cloud durable MCP usage counts', () => {
  it('persists only completed native relay outcomes and isolates owner totals across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyeda-cloud-usage-'));
    const path = join(dir, 'hosted-cloud.sqlite');
    const db = new DatabaseSync(path);
    try {
      const usage = new HostedUsageStore(db);
      const audit = new RemoteAuditLog(200, (event) => {
        usage.record(event);
      });
      audit.record({ event: 'remote.tool.requested', mode: 'hosted', userId: 'owner-a' });
      audit.record({ event: 'remote.identity.rejected', mode: 'hosted', userId: 'owner-a' });
      audit.record({
        event: 'remote.tool.completed',
        mode: 'hosted',
        userId: 'owner-a',
        toolName: 'easyeda_pcb_components',
        status: 'ok',
        observedAt: '2026-11-15T16:30:00.000Z',
      });
      audit.record({
        event: 'remote.tool.failed',
        mode: 'hosted',
        userId: 'owner-a',
        toolName: 'easyeda_schematic_components',
        status: 'error',
        observedAt: '2026-11-15T16:31:00.000Z',
      });
      audit.record({
        event: 'remote.tool.completed',
        mode: 'hosted',
        userId: 'owner-b',
        status: 'ok',
      });
      audit.record({
        event: 'remote.tool.completed',
        mode: 'self_hosted',
        userId: 'owner-a',
        status: 'ok',
      });
      audit.record({ event: 'remote.tool.completed', mode: 'hosted', status: 'ok' });
      expect(usage.totals('owner-a')).toEqual({
        total: 2,
        succeeded: 1,
        failed: 1,
        lastCallAt: '2026-11-15T16:31:00.000Z',
      });
      expect(usage.totals('owner-b')).toMatchObject({
        total: 1,
        succeeded: 1,
        failed: 0,
      });
      expect(usage.totals('unrelated-owner')).toEqual({
        total: 0,
        succeeded: 0,
        failed: 0,
        lastCallAt: null,
      });
      const columns = db.prepare('PRAGMA table_info(hosted_mcp_usage)').all() as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual([
        'user_id',
        'total',
        'succeeded',
        'failed',
        'last_call_at',
      ]);
    } finally {
      db.close();
    }

    try {
      const reopened = new DatabaseSync(path);
      try {
        const usage = new HostedUsageStore(reopened);
        expect(usage.totals('owner-a')).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
        expect(usage.totals('owner-b')).toMatchObject({ total: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import type { DatabaseSync } from 'node:sqlite';
import { RemoteAuditLog, type RemoteAuditEvent } from '../remote/observability.js';

export interface HostedUsageTotals {
  total: number;
  succeeded: number;
  failed: number;
  lastCallAt: string | null;
}

/**
 * Persistent, owner-scoped accounting for calls that actually reached the
 * native relay and produced an outcome. No tool arguments, designs, OAuth
 * tokens, session IDs or individual tool names are stored.
 */
export class HostedUsageStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS hosted_mcp_usage (
        user_id TEXT PRIMARY KEY,
        total INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        last_call_at TEXT NOT NULL
      )
    `);
  }

  record(event: RemoteAuditEvent): HostedUsageTotals | undefined {
    if (
      event.mode !== 'hosted' ||
      !event.userId ||
      (event.event !== 'remote.tool.completed' && event.event !== 'remote.tool.failed')
    ) {
      return undefined;
    }

    const success = event.event === 'remote.tool.completed' ? 1 : 0;
    this.database
      .prepare(
        `
        INSERT INTO hosted_mcp_usage (user_id, total, succeeded, failed, last_call_at)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          total = total + 1,
          succeeded = succeeded + excluded.succeeded,
          failed = failed + excluded.failed,
          last_call_at = excluded.last_call_at
      `,
      )
      .run(event.userId, success, 1 - success, event.observedAt);
    return this.totals(event.userId);
  }

  totals(userId: string): HostedUsageTotals {
    const row = this.database
      .prepare(
        'SELECT total, succeeded, failed, last_call_at AS lastCallAt FROM hosted_mcp_usage WHERE user_id = ?',
      )
      .get(userId) as HostedUsageTotals | undefined;
    return row ?? { total: 0, succeeded: 0, failed: 0, lastCallAt: null };
  }
}

/** One safe terminal line and a durable counter per completed Hosted MCP relay call. */
export function createHostedUsageAuditLog(
  usage: HostedUsageStore,
  registeredTools: ReadonlySet<string> = new Set(),
): RemoteAuditLog {
  return new RemoteAuditLog(200, (event) => {
    if (
      event.mode !== 'hosted' ||
      (event.event !== 'remote.tool.completed' && event.event !== 'remote.tool.failed')
    ) {
      return;
    }
    try {
      const totals = usage.record(event);
      if (!totals) return;
      // Remote toolName originates in the client's request. Only display a
      // name from this server's registered MCP tool list, never arbitrary
      // caller-controlled text, OAuth credentials or design payloads.
      const tool =
        event.toolName &&
        registeredTools.has(event.toolName) &&
        /^[a-zA-Z0-9_.-]{1,100}$/.test(event.toolName)
          ? event.toolName
          : 'unknown-tool';
      const ok = event.event === 'remote.tool.completed';
      const duration = Math.max(0, Math.floor(event.durationMs ?? 0));
      const color = process.stderr.isTTY ? (ok ? '\x1b[32m' : '\x1b[31m') : '';
      const reset = process.stderr.isTTY ? '\x1b[0m' : '';
      process.stderr.write(
        `[Cloud MCP] ${color}${ok ? '✓' : '!'} ${ok ? 'OK' : 'ERROR'}${reset} · ${tool} · ${duration}ms · call #${totals.total}\n`,
      );
    } catch {
      // A telemetry failure must never turn an already executed native
      // mutation into an error that a caller might retry.
      process.stderr.write('[Cloud MCP] Usage tracking unavailable for a completed call.\n');
    }
  });
}

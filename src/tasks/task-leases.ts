import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type TaskLease = {
  taskId: string;
  workerId: string;
  token: string;
  expiresAtMs: number;
};

const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 60000;
const MAX_RESULT_BYTES = 1024 * 1024;

function validIdentity(value: string, label: string, maxLength = 256): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new TypeError('Invalid ' + label);
  }
}

function leaseDuration(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) {
    throw new RangeError('Lease duration must be 1 to 60 seconds');
  }
}

/**
 * SQLite-backed worker fencing. Does not invoke any tools or create a running
 * worker; this class remains unreferenced by the production MCP factory.
 * State changes must match the current, unexpired lease token atomically.
 */
export class DurableTaskLeaseStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
      [
        'CREATE TABLE IF NOT EXISTS mcp_task_lease_v1 (',
        'task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, token TEXT NOT NULL,',
        'acquired_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL)',
      ].join(' '),
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_mcp_lease_expires ON mcp_task_lease_v1(expires_ms)',
    );
  }

  acquire(ownerId: string, taskId: string, workerId: string, ttlMs = 10000): TaskLease | undefined {
    validIdentity(ownerId, 'owner identity');
    validIdentity(taskId, 'task identity');
    validIdentity(workerId, 'worker identity', 128);
    leaseDuration(ttlMs);
    const now = this.clock();
    const token = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db
        .prepare(
          "SELECT 1 AS ok FROM mcp_task_state_v1 WHERE task_id=? AND owner_id=? AND status='working' AND cancel_requested=0 AND expires_ms>?",
        )
        .get(taskId, ownerId, now);
      if (!state) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const existing = this.db
        .prepare('SELECT expires_ms FROM mcp_task_lease_v1 WHERE task_id=?')
        .get(taskId) as { expires_ms: number } | undefined;
      if (existing && existing.expires_ms > now) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const until = now + ttlMs;
      this.db
        .prepare(
          'INSERT INTO mcp_task_lease_v1(task_id,worker_id,token,acquired_ms,expires_ms) VALUES(?,?,?,?,?) ' +
            'ON CONFLICT(task_id) DO UPDATE SET worker_id=excluded.worker_id, ' +
            'token=excluded.token, acquired_ms=excluded.acquired_ms, expires_ms=excluded.expires_ms',
        )
        .run(taskId, workerId, token, now, until);
      this.db.exec('COMMIT');
      return { taskId, workerId, token, expiresAtMs: until };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  renew(ownerId: string, lease: TaskLease, ttlMs = 10000): boolean {
    validIdentity(ownerId, 'owner identity');
    leaseDuration(ttlMs);
    const now = this.clock();
    return (
      this.db
        .prepare(
          'UPDATE mcp_task_lease_v1 SET expires_ms=? WHERE task_id=? AND worker_id=? AND token=? ' +
            'AND expires_ms>? AND EXISTS (SELECT 1 FROM mcp_task_state_v1 s ' +
            "WHERE s.task_id=mcp_task_lease_v1.task_id AND s.owner_id=? AND s.status='working' " +
            'AND s.cancel_requested=0 AND s.expires_ms>?)',
        )
        .run(now + ttlMs, lease.taskId, lease.workerId, lease.token, now, ownerId, now).changes ===
      1
    );
  }

  /** Complete only if the latest, unexpired worker token still owns the task. */
  complete(ownerId: string, lease: TaskLease, result: unknown): boolean {
    validIdentity(ownerId, 'owner identity');
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      !Array.isArray((result as Record<string, unknown>).content)
    ) {
      throw new TypeError('Expected a structured MCP tool result');
    }
    const payload = JSON.stringify(result);
    if (!payload || Buffer.byteLength(payload) > MAX_RESULT_BYTES) {
      throw new RangeError('Task result is too large or not JSON serializable');
    }
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated =
        this.db
          .prepare(
            "UPDATE mcp_task_state_v1 SET status='completed', result_json=?, updated_ms=? " +
              "WHERE task_id=? AND owner_id=? AND status='working' AND cancel_requested=0 AND expires_ms>? " +
              'AND EXISTS (SELECT 1 FROM mcp_task_lease_v1 l WHERE l.task_id=mcp_task_state_v1.task_id ' +
              'AND l.worker_id=? AND l.token=? AND l.expires_ms>?)',
          )
          .run(payload, now, lease.taskId, ownerId, now, lease.workerId, lease.token, now)
          .changes === 1;
      if (updated) {
        this.db
          .prepare('DELETE FROM mcp_task_lease_v1 WHERE task_id=? AND token=?')
          .run(lease.taskId, lease.token);
      }
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  release(lease: TaskLease): boolean {
    return (
      this.db
        .prepare('DELETE FROM mcp_task_lease_v1 WHERE task_id=? AND worker_id=? AND token=?')
        .run(lease.taskId, lease.workerId, lease.token).changes === 1
    );
  }

  /** Conservative process-recovery action. Never automatically re-executes. */
  failExpired(): number {
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // An accepted cancellation wins over abandoned worker recovery.
      this.db
        .prepare(
          "UPDATE mcp_task_state_v1 SET status='cancelled', updated_ms=? " +
            "WHERE status='working' AND cancel_requested=1 AND expires_ms>? " +
            'AND task_id IN (SELECT task_id FROM mcp_task_lease_v1 WHERE expires_ms<=?)',
        )
        .run(now, now, now);
      const count = this.db
        .prepare(
          "UPDATE mcp_task_state_v1 SET status='failed', " +
            "error_message='Task worker lease expired; the task was not resumed.', updated_ms=? " +
            "WHERE status='working' AND cancel_requested=0 AND expires_ms>? AND task_id IN " +
            '(SELECT task_id FROM mcp_task_lease_v1 WHERE expires_ms<=?)',
        )
        .run(now, now, now).changes;
      this.db
        .prepare(
          'DELETE FROM mcp_task_lease_v1 WHERE expires_ms<=? OR task_id NOT IN ' +
            '(SELECT task_id FROM mcp_task_state_v1)',
        )
        .run(now);
      this.db.exec('COMMIT');
      return Number(count);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// This is a durable STATE substrate, not an MCP Tasks wire implementation.
// No handler consumes it or advertises task support yet.
export const READ_ONLY_TASK_OPERATIONS = [
  'easyeda_bom_generate',
  'easyeda_pcb_components',
] as const;

export type SafeTaskOperation = (typeof READ_ONLY_TASK_OPERATIONS)[number];
export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';
export type TaskRecord = {
  id: string;
  operation: SafeTaskOperation;
  arguments: unknown;
  status: TaskStatus;
  result?: unknown;
  error?: string;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  ttlMs: number;
};

type Row = {
  task_id: string;
  operation: SafeTaskOperation;
  arguments_json: string;
  status: TaskStatus;
  result_json: string | null;
  error_message: string | null;
  cancel_requested: number;
  created_ms: number;
  updated_ms: number;
  expires_ms: number;
};

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 65536;
const MAX_TASKS_PER_OWNER = 100;
const MIN_TTL_MS = 60000;
const MAX_TTL_MS = 86400000;

function requireOwner(ownerId: string): void {
  // The future wire adapter MUST derive this from a validated session / OAuth
  // principal. Client-supplied owner strings must never be trusted.
  if (
    typeof ownerId !== 'string' ||
    ownerId.length < 1 ||
    ownerId.length > 256 ||
    ownerId !== ownerId.trim()
  ) {
    throw new TypeError('A validated owner identity is required');
  }
}

function jsonPayload(value: unknown, limit: number): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > limit) {
    throw new RangeError('Task JSON payload is missing or exceeds its size limit');
  }
  return json;
}

function toRecord(row: Row): TaskRecord {
  return {
    id: row.task_id,
    operation: row.operation,
    arguments: JSON.parse(row.arguments_json) as unknown,
    status: row.status,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.error_message === null ? {} : { error: row.error_message }),
    cancelRequested: row.cancel_requested !== 0,
    createdAt: new Date(row.created_ms).toISOString(),
    updatedAt: new Date(row.updated_ms).toISOString(),
    ttlMs: row.expires_ms - row.created_ms,
  };
}

export class DurableTaskStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(dbPath: string, clock: () => number = Date.now) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.clock = clock;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
      [
        'CREATE TABLE IF NOT EXISTS mcp_task_state_v1 (',
        'task_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,',
        'operation TEXT NOT NULL, arguments_json TEXT NOT NULL,',
        "status TEXT NOT NULL CHECK(status IN ('working','completed','failed','cancelled')),",
        'result_json TEXT, error_message TEXT,',
        'cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),',
        'created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,',
        'expires_ms INTEGER NOT NULL)',
      ].join(' '),
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_mcp_task_owner ON mcp_task_state_v1(owner_id, expires_ms)',
    );
  }

  create(
    ownerId: string,
    operation: SafeTaskOperation,
    args: unknown,
    ttlMs = 3600000,
  ): TaskRecord {
    requireOwner(ownerId);
    if (!READ_ONLY_TASK_OPERATIONS.includes(operation)) {
      throw new TypeError('Operation is not in the audited read-only task allowlist');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      throw new RangeError('Task retention must be between 1 minute and 24 hours');
    }
    const payload = jsonPayload(args, MAX_ARGUMENT_BYTES);
    const now = this.clock();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db
        .prepare(
          'SELECT COUNT(*) AS count FROM mcp_task_state_v1 WHERE owner_id=? AND expires_ms>?',
        )
        .get(ownerId, now) as { count: number };
      if (count.count >= MAX_TASKS_PER_OWNER) throw new RangeError('Owner task quota reached');
      this.db
        .prepare(
          [
            'INSERT INTO mcp_task_state_v1',
            '(task_id, owner_id, operation, arguments_json, status, created_ms, updated_ms, expires_ms)',
            "VALUES(?, ?, ?, ?, 'working', ?, ?, ?)",
          ].join(' '),
        )
        .run(id, ownerId, operation, payload, now, now, now + ttlMs);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const created = this.get(ownerId, id);
    if (!created) throw new Error('Persisted task could not be read back');
    return created;
  }

  get(ownerId: string, taskId: string): TaskRecord | undefined {
    requireOwner(ownerId);
    const row = this.db
      .prepare(
        [
          'SELECT task_id, operation, arguments_json, status, result_json, error_message,',
          'cancel_requested, created_ms, updated_ms, expires_ms',
          'FROM mcp_task_state_v1 WHERE owner_id=? AND task_id=? AND expires_ms>?',
        ].join(' '),
      )
      .get(ownerId, taskId, this.clock()) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(ownerId: string, limit = 20): TaskRecord[] {
    requireOwner(ownerId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Task list limit must be from 1 to 100');
    }
    const rows = this.db
      .prepare(
        [
          'SELECT task_id, operation, arguments_json, status, result_json, error_message,',
          'cancel_requested, created_ms, updated_ms, expires_ms',
          'FROM mcp_task_state_v1 WHERE owner_id=? AND expires_ms>?',
          'ORDER BY created_ms DESC, task_id DESC LIMIT ?',
        ].join(' '),
      )
      .all(ownerId, this.clock(), limit) as Row[];
    return rows.map(toRecord);
  }

  finish(ownerId: string, taskId: string, result: unknown): boolean {
    requireOwner(ownerId);
    const payload = jsonPayload(result, MAX_PAYLOAD_BYTES);
    return (
      this.db
        .prepare(
          [
            'UPDATE mcp_task_state_v1 SET status=?, result_json=?, updated_ms=?',
            "WHERE task_id=? AND owner_id=? AND status='working' AND cancel_requested=0 AND expires_ms>?",
          ].join(' '),
        )
        .run('completed', payload, this.clock(), taskId, ownerId, this.clock()).changes === 1
    );
  }

  fail(ownerId: string, taskId: string, reason: 'execution_failed' | 'execution_timeout'): boolean {
    requireOwner(ownerId);
    // Do not persist arbitrary errors: exception messages may contain secrets.
    const message =
      reason === 'execution_timeout'
        ? 'The task exceeded its execution deadline.'
        : 'The read-only task could not be completed.';
    return (
      this.db
        .prepare(
          [
            "UPDATE mcp_task_state_v1 SET status='failed', error_message=?, updated_ms=?",
            "WHERE task_id=? AND owner_id=? AND status='working' AND cancel_requested=0 AND expires_ms>?",
          ].join(' '),
        )
        .run(message, this.clock(), taskId, ownerId, this.clock()).changes === 1
    );
  }

  requestCancel(ownerId: string, taskId: string): boolean {
    requireOwner(ownerId);
    return (
      this.db
        .prepare(
          [
            'UPDATE mcp_task_state_v1 SET cancel_requested=1, updated_ms=?',
            "WHERE task_id=? AND owner_id=? AND status='working' AND expires_ms>?",
          ].join(' '),
        )
        .run(this.clock(), taskId, ownerId, this.clock()).changes === 1
    );
  }

  markCancelled(ownerId: string, taskId: string): boolean {
    requireOwner(ownerId);
    return (
      this.db
        .prepare(
          [
            "UPDATE mcp_task_state_v1 SET status='cancelled', updated_ms=?",
            "WHERE task_id=? AND owner_id=? AND status='working' AND cancel_requested=1 AND expires_ms>?",
          ].join(' '),
        )
        .run(this.clock(), taskId, ownerId, this.clock()).changes === 1
    );
  }

  // Called only by the future single-owner task worker on startup. An
  // interrupted operation cannot be reported as running after process death.
  failInterruptedOnRestart(): number {
    return Number(
      this.db
        .prepare(
          [
            "UPDATE mcp_task_state_v1 SET status='failed',",
            "error_message='Server restarted before the task completed; it was not resumed.',",
            'updated_ms=?',
            "WHERE status='working' AND expires_ms>?",
          ].join(' '),
        )
        .run(this.clock(), this.clock()).changes,
    );
  }

  cleanupExpired(): number {
    return Number(
      this.db.prepare('DELETE FROM mcp_task_state_v1 WHERE expires_ms<=?').run(this.clock())
        .changes,
    );
  }

  close(): void {
    this.db.close();
  }
}

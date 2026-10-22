import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getLogger } from '../utils/logger.js';
import { type EnvConfig } from '../config/env.js';
import { type VerifiedDeviceRecord } from './types.js';

function rowToVerifiedDeviceRecord(row: Record<string, unknown>): VerifiedDeviceRecord {
  return {
    lcscId: row.lcsc_id as string,
    entryJson: row.entry_json as string,
    status: row.status as VerifiedDeviceRecord['status'],
    errorCount: row.error_count as number,
    warningCount: row.warning_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * SQLite-backed persistent storage for the MCP server.
 *
 * Stores verified catalog devices. Retains legacy cache/artifact tables for
 * compatibility with existing databases. Uses WAL mode and foreign keys for safety.
 * Read operations fail safely; persistence methods report failure explicitly
 * so a write error cannot be mistaken for a committed cache entry.
 */
export class Storage {
  private readonly db: DatabaseSync;
  private readonly config: EnvConfig;
  private initialized = false;

  constructor(config: EnvConfig) {
    this.config = config;
    const dir = path.dirname(config.SQLITE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(config.SQLITE_PATH);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  /** Initialise the schema (tables + indexes). Safe to call multiple times. */
  initialize(): void {
    if (this.initialized) return;
    const logger = getLogger();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ttl INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_cache (
        project_hash TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        schematic_snapshot TEXT,
        board_snapshot TEXT,
        bom_snapshot TEXT,
        last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
        easyeda_version TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('gerber','bom','pdf','pick-place','netlist','schematic','board')),
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS verified_devices (
        lcsc_id TEXT PRIMARY KEY,
        entry_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('resolved','partial','unresolved')),
        error_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_hash);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
    `);

    this.initialized = true;
    logger.info({ path: this.config.SQLITE_PATH }, 'storage initialized');
  }

  /** Insert or replace a verified-device cache entry, keyed by LCSC id. Returns true only on commit. */
  upsertVerifiedDevice(record: Omit<VerifiedDeviceRecord, 'createdAt' | 'updatedAt'>): boolean {
    try {
      const existing = this.db
        .prepare('SELECT created_at FROM verified_devices WHERE lcsc_id = ?')
        .get(record.lcscId) as { created_at: string } | undefined;
      this.db
        .prepare(
          `
        INSERT INTO verified_devices (lcsc_id, entry_json, status, error_count, warning_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
        ON CONFLICT(lcsc_id) DO UPDATE SET
          entry_json = excluded.entry_json,
          status = excluded.status,
          error_count = excluded.error_count,
          warning_count = excluded.warning_count,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          record.lcscId,
          record.entryJson,
          record.status,
          record.errorCount,
          record.warningCount,
          existing?.created_at ?? null,
        );
      return true;
    } catch (err) {
      getLogger().error({ err, lcscId: record.lcscId }, 'upsertVerifiedDevice failed');
      return false;
    }
  }

  /** Look up a cached verified-device entry by LCSC id. Returns `null` if not found. */
  getVerifiedDevice(lcscId: string): VerifiedDeviceRecord | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM verified_devices WHERE lcsc_id = ?')
        .get(lcscId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToVerifiedDeviceRecord(row);
    } catch (err) {
      getLogger().error({ err, lcscId }, 'getVerifiedDevice failed');
      return null;
    }
  }

  /** List cached verified devices, optionally filtered by status, newest first. */
  listVerifiedDevices(status?: VerifiedDeviceRecord['status']): VerifiedDeviceRecord[] {
    try {
      let query = 'SELECT * FROM verified_devices';
      const params: string[] = [];
      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }
      query += ' ORDER BY updated_at DESC';
      const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToVerifiedDeviceRecord);
    } catch (err) {
      getLogger().error({ err, status }, 'listVerifiedDevices failed');
      return [];
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

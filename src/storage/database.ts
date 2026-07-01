import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getLogger } from '../utils/logger.js';
import { type EnvConfig } from '../config/env.js';
import { type ProjectCache, type ArtifactRecord } from './types.js';
import { getGlobalMetricsCollector } from '../observability/index.js';

/**
 * SQLite-backed persistent storage for the MCP server.
 *
 * Manages project cache entries, generic key/value cache with TTL,
 * and artifact records. Uses WAL mode and foreign keys for safety.
 * All public methods are safe — errors are logged internally and
 * never thrown to the caller.
 */
export class Storage {
  private db: DatabaseSync;
  private config: EnvConfig;
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

      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_hash);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
    `);

    this.initialized = true;
    logger.info({ path: this.config.SQLITE_PATH }, 'storage initialized');
  }

  /** Retrieve a cached value by key. Returns `null` when missing or expired. */
  cacheGet(key: string): string | null {
    try {
      const row = this.db
        .prepare(
          `SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
        )
        .get(key) as { value: string } | undefined;

      const value = row?.value ?? null;
      getGlobalMetricsCollector().recordCache(value === null ? 'miss' : 'hit');
      return value;
    } catch (err) {
      getLogger().error({ err, key }, 'cacheGet failed');
      return null;
    }
  }

  /**
   * Store a value in the cache.
   * @param ttlSec Time-to-live in seconds. 0 means never expire.
   */
  cacheSet(key: string, value: string, ttlSec = 0): void {
    try {
      const expiresAt = ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
      this.db
        .prepare(`INSERT OR REPLACE INTO cache (key, value, ttl, expires_at) VALUES (?, ?, ?, ?)`)
        .run(key, value, ttlSec, expiresAt);
      getGlobalMetricsCollector().recordCache('write');
    } catch (err) {
      getLogger().error({ err, key }, 'cacheSet failed');
    }
  }

  /** Remove a single cache entry by key. */
  cacheDelete(key: string): void {
    try {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      getGlobalMetricsCollector().recordCache('delete');
    } catch (err) {
      getLogger().error({ err, key }, 'cacheDelete failed');
    }
  }

  /** Remove all cache entries. */
  cacheClear(): void {
    try {
      this.db.prepare('DELETE FROM cache').run();
      getGlobalMetricsCollector().recordCache('delete');
    } catch (err) {
      getLogger().error({ err }, 'cacheClear failed');
    }
  }

  /** Look up a project cache entry by its hash. Returns `null` if not found. */
  getProjectCache(hash: string): ProjectCache | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM project_cache WHERE project_hash = ?')
        .get(hash) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        projectHash: row.project_hash as string,
        projectName: row.project_name as string,
        schematicSnapshot: (row.schematic_snapshot as string) ?? null,
        boardSnapshot: (row.board_snapshot as string) ?? null,
        bomSnapshot: (row.bom_snapshot as string) ?? null,
        lastSyncedAt: row.last_synced_at as string,
        easyedaVersion: (row.easyeda_version as string) ?? null,
      };
    } catch (err) {
      getLogger().error({ err, hash }, 'getProjectCache failed');
      return null;
    }
  }

  /** Insert or replace a project cache entry. */
  upsertProjectCache(cache: ProjectCache): void {
    try {
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO project_cache
          (project_hash, project_name, schematic_snapshot, board_snapshot, bom_snapshot, last_synced_at, easyeda_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          cache.projectHash,
          cache.projectName,
          cache.schematicSnapshot,
          cache.boardSnapshot,
          cache.bomSnapshot,
          cache.lastSyncedAt,
          cache.easyedaVersion,
        );
    } catch (err) {
      getLogger().error({ err, projectHash: cache.projectHash }, 'upsertProjectCache failed');
    }
  }

  /** Store a new artifact record (gerber, bom, pdf, etc.). */
  insertArtifact(artifact: ArtifactRecord): void {
    try {
      this.db
        .prepare(
          `
        INSERT INTO artifacts (id, project_hash, type, file_path, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          artifact.id,
          artifact.projectHash,
          artifact.type,
          artifact.filePath,
          artifact.createdAt,
          artifact.metadata,
        );
    } catch (err) {
      getLogger().error({ err, artifactId: artifact.id }, 'insertArtifact failed');
    }
  }

  /**
   * List artifact records for a project, optionally filtered by type.
   * Results are ordered by creation date descending.
   */
  getArtifacts(projectHash: string, type?: string): ArtifactRecord[] {
    try {
      let query = 'SELECT * FROM artifacts WHERE project_hash = ?';
      const params: Array<string> = [projectHash];
      if (type) {
        query += ' AND type = ?';
        params.push(type);
      }
      query += ' ORDER BY created_at DESC';
      const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        projectHash: r.project_hash as string,
        type: r.type as ArtifactRecord['type'],
        filePath: r.file_path as string,
        createdAt: r.created_at as string,
        metadata: (r.metadata as string) ?? null,
      }));
    } catch (err) {
      getLogger().error({ err, projectHash, type }, 'getArtifacts failed');
      return [];
    }
  }

  /** Reclaim storage by running VACUUM. */
  vacuum(): void {
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      getLogger().error({ err }, 'vacuum failed');
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

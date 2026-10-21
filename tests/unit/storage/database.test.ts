import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { Storage } from '../../../src/storage/database.js';

function createTestConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    SQLITE_PATH: ':memory:',
    DATA_DIR: ':memory:',
    ARTIFACT_DIR: ':memory:',
    CACHE_DIR: ':memory:',
  });
}

describe('Storage', () => {
  let storage: Storage;

  beforeEach(() => {
    const config = createTestConfig();
    storage = new Storage(config);
    storage.initialize();
  });

  afterEach(() => storage.close());

  it('should initialize database and create tables', () => {
    expect(() => storage.initialize()).not.toThrow();
  });

  it('preserves legacy cache, project and artifact rows when reopening a database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'easyeda-storage-'));
    const config = { ...createTestConfig(), SQLITE_PATH: join(directory, 'existing.sqlite') };
    try {
      const original = new Storage(config);
      original.initialize();
      original.close();
      const database = new DatabaseSync(config.SQLITE_PATH);
      try {
        database.exec(`
          INSERT INTO cache (key, value) VALUES ('legacy-cache', 'cached value');
          INSERT INTO project_cache (project_hash, project_name)
            VALUES ('legacy-project', 'Existing project');
          INSERT INTO artifacts (id, project_hash, type, file_path)
            VALUES ('legacy-artifact', 'legacy-project', 'pdf', '/exports/existing.pdf');
        `);
        const reopened = new Storage(config);
        try {
          reopened.initialize();
          reopened.upsertVerifiedDevice({
            lcscId: 'C1',
            entryJson: '{}',
            status: 'resolved',
            errorCount: 0,
            warningCount: 0,
          });
          expect(reopened.getVerifiedDevice('C1')?.status).toBe('resolved');
          expect(database.prepare('SELECT value FROM cache').get()).toMatchObject({
            value: 'cached value',
          });
          expect(database.prepare('SELECT project_name FROM project_cache').get()).toMatchObject({
            project_name: 'Existing project',
          });
          expect(database.prepare('SELECT file_path FROM artifacts').get()).toMatchObject({
            file_path: '/exports/existing.pdf',
          });
        } finally {
          reopened.close();
        }
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('verified devices', () => {
    it('upserts and retrieves a verified device by LCSC id', () => {
      storage.upsertVerifiedDevice({
        lcscId: 'C25804',
        entryJson: '{"id":"device-lcsc-c25804"}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 1,
      });

      const record = storage.getVerifiedDevice('C25804');
      expect(record).toMatchObject({
        lcscId: 'C25804',
        entryJson: '{"id":"device-lcsc-c25804"}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 1,
      });
      expect(record?.createdAt).toBeTruthy();
      expect(record?.updatedAt).toBeTruthy();
    });

    it('returns null for a device that was never cached', () => {
      expect(storage.getVerifiedDevice('C000000')).toBeNull();
    });

    it('updates status/entry on repeated ingestion without changing createdAt', async () => {
      storage.upsertVerifiedDevice({
        lcscId: 'C111111',
        entryJson: '{"v":1}',
        status: 'unresolved',
        errorCount: 2,
        warningCount: 0,
      });
      const first = storage.getVerifiedDevice('C111111');

      await new Promise((resolve) => setTimeout(resolve, 5));

      storage.upsertVerifiedDevice({
        lcscId: 'C111111',
        entryJson: '{"v":2}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 0,
      });
      const second = storage.getVerifiedDevice('C111111');

      expect(second).toMatchObject({ entryJson: '{"v":2}', status: 'resolved', errorCount: 0 });
      expect(second?.createdAt).toBe(first?.createdAt);
    });

    it('lists verified devices newest-first, optionally filtered by status', () => {
      storage.upsertVerifiedDevice({
        lcscId: 'C1',
        entryJson: '{}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 0,
      });
      storage.upsertVerifiedDevice({
        lcscId: 'C2',
        entryJson: '{}',
        status: 'unresolved',
        errorCount: 1,
        warningCount: 0,
      });

      const all = storage.listVerifiedDevices();
      expect(all.map((d) => d.lcscId).sort()).toEqual(['C1', 'C2']);

      const resolvedOnly = storage.listVerifiedDevices('resolved');
      expect(resolvedOnly).toHaveLength(1);
      expect(resolvedOnly[0]?.lcscId).toBe('C1');
    });
  });
});

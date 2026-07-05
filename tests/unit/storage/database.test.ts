import { describe, it, expect, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { Storage } from '../../../src/storage/database.js';
import {
  getGlobalMetricsCollector,
  resetGlobalMetricsCollector,
} from '../../../src/observability/index.js';

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
    resetGlobalMetricsCollector();
    const config = createTestConfig();
    storage = new Storage(config);
    storage.initialize();
  });

  it('should initialize database and create tables', () => {
    expect(() => storage.initialize()).not.toThrow();
  });

  it('should set and get cache entries', () => {
    storage.cacheSet('test-key', 'test-value');
    const value = storage.cacheGet('test-key');
    expect(value).toBe('test-value');
  });

  it('should return null for missing cache keys', () => {
    const value = storage.cacheGet('non-existent');
    expect(value).toBeNull();
  });

  it('should allow zero TTL (no expiry)', () => {
    storage.cacheSet('no-expiry', 'value', 0);
    expect(storage.cacheGet('no-expiry')).toBe('value');
  });

  it('should return cached values within TTL', () => {
    storage.cacheSet('stays', 'value', 60);
    expect(storage.cacheGet('stays')).toBe('value');
  });

  it('should delete cache entries', () => {
    storage.cacheSet('delete-me', 'value');
    storage.cacheDelete('delete-me');
    const value = storage.cacheGet('delete-me');
    expect(value).toBeNull();
  });

  it('should clear all cache entries', () => {
    storage.cacheSet('key1', 'val1');
    storage.cacheSet('key2', 'val2');
    storage.cacheClear();
    expect(storage.cacheGet('key1')).toBeNull();
    expect(storage.cacheGet('key2')).toBeNull();
  });

  it('should record cache observability counters', () => {
    storage.cacheSet('observed', 'value');
    expect(storage.cacheGet('observed')).toBe('value');
    expect(storage.cacheGet('missing')).toBeNull();
    storage.cacheDelete('observed');

    const snapshot = getGlobalMetricsCollector().snapshot();
    expect(snapshot.cache).toMatchObject({ hits: 1, misses: 1, writes: 1, deletes: 1 });
    expect(snapshot.cache.hitRate).toBe(0.5);
  });

  it('should upsert and retrieve project cache', () => {
    storage.upsertProjectCache({
      projectHash: 'abc123',
      projectName: 'test-project',
      schematicSnapshot: 'snap1',
      boardSnapshot: null,
      bomSnapshot: null,
      lastSyncedAt: new Date().toISOString(),
      easyedaVersion: '1.0',
    });

    const retrieved = storage.getProjectCache('abc123');
    expect(retrieved).toMatchObject({
      projectHash: 'abc123',
      projectName: 'test-project',
      schematicSnapshot: 'snap1',
      easyedaVersion: '1.0',
    });
  });

  it('should handle missing project cache gracefully', () => {
    const retrieved = storage.getProjectCache('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should insert and query artifacts', () => {
    storage.insertArtifact({
      id: 'art-1',
      projectHash: 'proj-1',
      type: 'gerber',
      filePath: '/tmp/gerbers.zip',
      createdAt: new Date().toISOString(),
      metadata: '{}',
    });

    const artifacts = storage.getArtifacts('proj-1');
    expect(artifacts).toMatchObject([{ id: 'art-1', type: 'gerber' }]);
  });

  it('should filter artifacts by type', () => {
    storage.insertArtifact({
      id: 'a1',
      projectHash: 'p1',
      type: 'gerber',
      filePath: '/g.zip',
      createdAt: new Date().toISOString(),
      metadata: null,
    });
    storage.insertArtifact({
      id: 'a2',
      projectHash: 'p1',
      type: 'bom',
      filePath: '/b.csv',
      createdAt: new Date().toISOString(),
      metadata: null,
    });
    storage.insertArtifact({
      id: 'a3',
      projectHash: 'p1',
      type: 'pdf',
      filePath: '/d.pdf',
      createdAt: new Date().toISOString(),
      metadata: null,
    });

    const gerbers = storage.getArtifacts('p1', 'gerber');
    expect(gerbers).toMatchObject([{ id: 'a1' }]);

    const all = storage.getArtifacts('p1');
    expect(all).toHaveLength(3);
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

    it('deletes a verified device', () => {
      storage.upsertVerifiedDevice({
        lcscId: 'C3',
        entryJson: '{}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 0,
      });
      storage.deleteVerifiedDevice('C3');
      expect(storage.getVerifiedDevice('C3')).toBeNull();
    });
  });
});

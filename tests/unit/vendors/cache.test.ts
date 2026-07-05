import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createFileVendorCache,
  createNoopVendorCache,
  cacheKey,
} from '../../../src/vendors/cache.js';

describe('cacheKey', () => {
  it('is stable regardless of object key order', () => {
    const a = cacheKey(['lcsc', 'resistors', { b: '2', a: '1' }]);
    const b = cacheKey(['lcsc', 'resistors', { a: '1', b: '2' }]);
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = cacheKey(['lcsc', 'resistors', { a: '1' }]);
    const b = cacheKey(['lcsc', 'capacitors', { a: '1' }]);
    expect(a).not.toBe(b);
  });
});

describe('createNoopVendorCache', () => {
  it('always returns null and never persists anything', async () => {
    const cache = createNoopVendorCache();
    await cache.set('key', { foo: 'bar' }, 60);
    const result = await cache.get('key');
    expect(result).toBeNull();
  });
});

describe('createFileVendorCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-cache-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a key that was never set', async () => {
    const cache = createFileVendorCache(dir);
    const result = await cache.get('missing');
    expect(result).toBeNull();
  });

  it('round-trips a value written with set', async () => {
    const cache = createFileVendorCache(dir);
    await cache.set('key', { foo: 'bar' }, 3600);
    const result = await cache.get<{ foo: string }>('key');
    expect(result?.value).toEqual({ foo: 'bar' });
    expect(result?.storedAt).toBeLessThanOrEqual(Date.now());
  });

  it('expires an entry once its TTL has elapsed', async () => {
    const cache = createFileVendorCache(dir);
    const key = 'expiring';
    await cache.set(key, { foo: 'bar' }, 3600);

    // Rewrite the entry's storedAt to simulate it being far in the past.
    const file = path.join(dir, 'vendors', `${key}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
    entry.storedAt = Date.now() - 7200 * 1000;
    fs.writeFileSync(file, JSON.stringify(entry), 'utf-8');

    const result = await cache.get(key);
    expect(result).toBeNull();
  });

  it('does not throw when the cache directory cannot be created', async () => {
    // Point at a path where a parent segment is a file, not a directory.
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not a directory');
    const cache = createFileVendorCache(path.join(blockerFile, 'nested'));

    await expect(cache.set('key', { foo: 'bar' }, 60)).resolves.toBeUndefined();
    await expect(cache.get('key')).resolves.toBeNull();
  });
});

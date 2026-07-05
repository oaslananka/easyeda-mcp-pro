/**
 * Vendor response cache — a small file-based TTL cache shared by vendor
 * clients so repeated lookups (e.g. category snapshots) avoid re-hitting
 * rate-limited public APIs.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface CacheReadResult<T> {
  value: T;
  storedAt: number;
}

export interface VendorCache {
  get<T>(key: string): Promise<CacheReadResult<T> | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** Build a stable cache key from an ordered list of key parts. */
export function cacheKey(parts: Array<string | number | Record<string, unknown>>): string {
  const stable = parts
    .map((part) => (typeof part === 'object' ? stableStringify(part) : String(part)))
    .join('|');
  return createHash('sha256').update(stable).digest('hex');
}

function stableStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

/** A cache that never stores or returns anything. Safe default for callers that opt out. */
export function createNoopVendorCache(): VendorCache {
  return {
    async get() {
      return null;
    },
    async set() {
      // no-op
    },
  };
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  ttlSeconds: number;
}

/** A file-based TTL cache rooted at `${cacheDir}/vendors`. Failures are swallowed — caching is best-effort. */
export function createFileVendorCache(cacheDir: string): VendorCache {
  const dir = path.join(cacheDir, 'vendors');

  return {
    async get<T>(key: string): Promise<CacheReadResult<T> | null> {
      try {
        const raw = await fs.readFile(path.join(dir, `${key}.json`), 'utf-8');
        const entry = JSON.parse(raw) as CacheEntry<T>;
        const ageSeconds = (Date.now() - entry.storedAt) / 1000;
        if (ageSeconds > entry.ttlSeconds) return null;
        return { value: entry.value, storedAt: entry.storedAt };
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      try {
        await fs.mkdir(dir, { recursive: true });
        const entry: CacheEntry<T> = { value, storedAt: Date.now(), ttlSeconds };
        await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(entry), 'utf-8');
      } catch {
        // best-effort cache; write failures must never break a vendor call
      }
    },
  };
}

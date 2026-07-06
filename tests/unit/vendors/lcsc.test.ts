import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { LcscClient } from '../../../src/vendors/lcsc/client.js';
import { createNoopVendorCache, type VendorCache } from '../../../src/vendors/cache.js';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
  request: requestMock,
}));

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: Readable.from([JSON.stringify(body)]) };
}

function textResponse(statusCode: number, text: string) {
  return { statusCode, body: Readable.from([text]) };
}

function createTestConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    JLCSEARCH_ENABLED: true,
  });
}

function createTestConfigWithApiKey() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    JLCSEARCH_ENABLED: true,
    LCSC_API_KEY: 'test-lcsc-key',
  });
}

function resistor(overrides: Record<string, unknown> = {}) {
  return {
    lcsc: 25804,
    mfr: '0603WAF1002T5E',
    description: '',
    stock: 37165617,
    price1: 0.000842857,
    in_stock: true,
    package: '0603',
    is_basic: true,
    is_preferred: false,
    attributes: JSON.stringify({ Resistance: '10kΩ', Tolerance: '±1%' }),
    ...overrides,
  };
}

/** Mock every category endpoint with an empty list, for tests that only care about one category. */
function mockAllCategoriesEmpty() {
  requestMock.mockImplementation(async (url: string) => {
    for (const category of [
      'resistors',
      'capacitors',
      'diodes',
      'mosfets',
      'leds',
      'microcontrollers',
      'switches',
      'led_drivers',
    ]) {
      if (typeof url === 'string' && url.includes(`/${category}/list.json`)) {
        return jsonResponse(200, { [category]: [] });
      }
    }
    return jsonResponse(200, {});
  });
}

function createMemoryCache(): VendorCache {
  const store = new Map<string, { value: unknown; storedAt: number }>();
  return {
    async get(key) {
      return (store.get(key) as { value: unknown; storedAt: number } | undefined) ?? null;
    },
    async set(key, value) {
      store.set(key, { value, storedAt: Date.now() });
    },
  };
}

describe('LcscClient', () => {
  beforeEach(() => {
    requestMock.mockReset();
    mockAllCategoriesEmpty();
  });

  it('should construct with default config', () => {
    const config = createTestConfig();
    const client = new LcscClient(config);
    expect(client).toBeInstanceOf(LcscClient);
  });

  it('should have expected methods', () => {
    const config = createTestConfig();
    const client = new LcscClient(config);
    expect(typeof client.searchParts).toBe('function');
    expect(typeof client.getPartDetail).toBe('function');
    expect(typeof client.getPartsByCategory).toBe('function');
    expect(typeof client.searchCategory).toBe('function');
  });

  it('should handle empty search gracefully', async () => {
    const config = createTestConfig();
    const client = new LcscClient(config);
    const result = await client.searchParts('');
    expect(result.parts).toEqual([]);
    expect(result.total).toBe(0);
  });

  describe('searchCategory', () => {
    it('fetches a known category and normalizes fields', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor()] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const result = await client.searchCategory('resistors', { resistance: '10k' });

      expect(result.total).toBe(1);
      expect(result.parts[0]).toMatchObject({
        lcsc: 'C25804',
        manufacturer: '0603WAF1002T5E',
        category: 'resistors',
        package: '0603',
        stock: 37165617,
        inStock: true,
        classification: 'basic',
        attributes: { Resistance: '10kΩ', Tolerance: '±1%' },
      });
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('/resistors/list.json'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns empty results for an unrecognized category without hitting the network', async () => {
      const client = new LcscClient(createTestConfig());
      // @ts-expect-error -- intentionally passing an unsupported category
      const result = await client.searchCategory('inductors');
      expect(result).toEqual({ parts: [], total: 0, fromCache: false, cacheAgeSeconds: 0 });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('marks classification as extended when is_basic and is_preferred are both false', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, {
            resistors: [resistor({ is_basic: false, is_preferred: false })],
          });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const result = await client.searchCategory('resistors');
      expect(result.parts[0]?.classification).toBe('extended');
    });

    it('falls back to empty attributes when the raw attributes string is not valid JSON', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, {
            resistors: [resistor({ attributes: 'not-valid-json{' })],
          });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const result = await client.searchCategory('resistors');
      expect(result.parts[0]?.attributes).toEqual({});
    });
  });

  describe('caching', () => {
    it('serves a repeated category query from cache without a second HTTP call', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor()] });
        }
        return jsonResponse(200, {});
      });

      const cache = createMemoryCache();
      const client = new LcscClient(createTestConfig(), cache);

      const first = await client.searchCategory('resistors', { resistance: '10k' });
      expect(first.fromCache).toBe(false);
      const callCountAfterFirst = requestMock.mock.calls.length;

      const second = await client.searchCategory('resistors', { resistance: '10k' });
      expect(second.fromCache).toBe(true);
      expect(second.parts).toEqual(first.parts);
      expect(requestMock.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('does not cache when a noop cache is used (the default)', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor()] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig(), createNoopVendorCache());
      await client.searchCategory('resistors');
      const callCountAfterFirst = requestMock.mock.calls.length;
      await client.searchCategory('resistors');
      expect(requestMock.mock.calls.length).toBeGreaterThan(callCountAfterFirst - 1);
      expect(requestMock.mock.calls.length).toBe(callCountAfterFirst * 2);
    });
  });

  describe('searchParts', () => {
    it('maps a recognized keyword to its category and applies an extracted package filter', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          expect(url).toContain('package=0603');
          return jsonResponse(200, { resistors: [resistor()] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const result = await client.searchParts('10k resistor 0603');

      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]?.category).toBe('resistors');
    });

    it('scans all categories and filters client-side for an unrecognized query', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, {
            resistors: [resistor({ mfr: 'ACME-WIDGET-1' })],
          });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const result = await client.searchParts('acme-widget');

      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]?.manufacturer).toBe('ACME-WIDGET-1');
    });

    it('falls back to the LCSC official API when jlcsearch is entirely unavailable and a key is configured', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockImplementation(async (url: string) => {
          if (typeof url === 'string' && url.includes('jlcsearch')) {
            return textResponse(500, 'boom');
          }
          return jsonResponse(200, { parts: [{ lcsc: 'C2' }], total: 1 });
        });

        const client = new LcscClient(createTestConfigWithApiKey());
        const pending = client.searchParts('capacitor');
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.parts[0]?.lcsc).toBe('C2');
        const fallbackCall = requestMock.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('lcsc.com/api/search'),
        );
        expect(fallbackCall).toBeDefined();
        expect(fallbackCall?.[1]).toMatchObject({ method: 'POST' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('computes cache age when every scanned category is served from cache', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor()] });
        }
        return jsonResponse(200, {});
      });

      const cache = createMemoryCache();
      const client = new LcscClient(createTestConfig(), cache);

      await client.searchParts('resistor');
      const callCountAfterFirst = requestMock.mock.calls.length;

      const second = await client.searchParts('resistor');
      expect(second.fromCache).toBe(true);
      expect(second.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(requestMock.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('rethrows when jlcsearch fails and no LCSC_API_KEY is configured', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValue(textResponse(500, 'boom'));

        const client = new LcscClient(createTestConfig());
        const pending = client.searchParts('capacitor');
        const assertion = expect(pending).rejects.toMatchObject({
          code: 'VENDOR_API_UNAVAILABLE',
        });
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getPartDetail', () => {
    it('finds a part by scanning cached category snapshots', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor({ lcsc: 25804 })] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const part = await client.getPartDetail('C25804');

      expect(part).toMatchObject({
        lcsc: 'C25804',
        category: 'resistors',
        classification: 'basic',
      });
    });

    it('accepts a bare numeric code without the C prefix', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor({ lcsc: 25804 })] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const part = await client.getPartDetail('25804');
      expect(part?.lcsc).toBe('C25804');
    });

    it('returns null when every category is reachable but none contain the part', async () => {
      const client = new LcscClient(createTestConfig());
      const part = await client.getPartDetail('C999999999');
      expect(part).toBeNull();
    });

    it('throws when jlcsearch is entirely unreachable and no LCSC_API_KEY is configured', async () => {
      requestMock.mockResolvedValue(textResponse(500, 'boom'));

      const client = new LcscClient(createTestConfig());
      await expect(client.getPartDetail('C1')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
      });
    });

    it('falls back to the official API when jlcsearch is entirely unreachable and a key is configured', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('jlcsearch')) {
          return textResponse(500, 'boom');
        }
        return jsonResponse(200, { lcsc: 'C1', manufacturer: 'fallback-mfr' });
      });

      const client = new LcscClient(createTestConfigWithApiKey());
      const part = await client.getPartDetail('C1');

      expect(part).toMatchObject({ lcsc: 'C1', manufacturer: 'fallback-mfr' });
      const fallbackCall = requestMock.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('lcsc.com/api/part'),
      );
      expect(fallbackCall).toBeDefined();
    });

    it('returns null for a non-numeric LCSC code when no LCSC_API_KEY is configured', async () => {
      const client = new LcscClient(createTestConfig());
      const part = await client.getPartDetail('not-a-numeric-code');
      expect(part).toBeNull();
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('throws when the LCSC official API returns a non-2xx status for a non-numeric code', async () => {
      requestMock.mockResolvedValue(textResponse(503, 'unavailable'));

      const client = new LcscClient(createTestConfigWithApiKey());
      await expect(client.getPartDetail('not-a-numeric-code')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        message: expect.stringContaining('LCSC official API'),
      });
    });

    it('surfaces cache metadata on the returned part', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/resistors/list.json')) {
          return jsonResponse(200, { resistors: [resistor({ lcsc: 25804 })] });
        }
        return jsonResponse(200, {});
      });

      const store = new Map<string, { value: unknown; storedAt: number }>();
      const cache: VendorCache = {
        async get(key) {
          return (store.get(key) as { value: unknown; storedAt: number } | undefined) ?? null;
        },
        async set(key, value) {
          store.set(key, { value, storedAt: Date.now() });
        },
      };

      const client = new LcscClient(createTestConfig(), cache);
      await client.getPartDetail('C25804');
      const second = await client.getPartDetail('C25804');

      expect(second?.fromCache).toBe(true);
      expect(second?.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getPartsByCategory', () => {
    it('returns parts for a known category', async () => {
      requestMock.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/capacitors/list.json')) {
          return jsonResponse(200, { capacitors: [resistor({ lcsc: 14663 })] });
        }
        return jsonResponse(200, {});
      });

      const client = new LcscClient(createTestConfig());
      const parts = await client.getPartsByCategory('capacitors');
      expect(parts).toHaveLength(1);
      expect(parts[0]?.lcsc).toBe('C14663');
    });

    it('returns an empty array for an unknown category', async () => {
      const client = new LcscClient(createTestConfig());
      const parts = await client.getPartsByCategory('not-a-real-category');
      expect(parts).toEqual([]);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });
});

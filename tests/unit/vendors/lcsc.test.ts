import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { LcscClient } from '../../../src/vendors/lcsc/client.js';

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

describe('LcscClient', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(jsonResponse(200, { results: [], count: 0 }));
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
  });

  it('should handle empty search gracefully', async () => {
    const config = createTestConfig();
    const client = new LcscClient(config);
    const result = await client.searchParts('');
    expect(result.parts).toEqual([]);
    expect(result.total).toBe(0);
  });

  describe('requests', () => {
    it('returns parts from the jlcsearch API on success', async () => {
      requestMock.mockResolvedValueOnce(jsonResponse(200, { results: [{ lcsc: 'C1' }], count: 1 }));

      const client = new LcscClient(createTestConfig());
      const result = await client.searchParts('resistor', { limit: 10, page: 1 });

      expect(result).toEqual({ parts: [{ lcsc: 'C1' }], total: 1 });
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/search'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('rethrows when jlcsearch fails and no LCSC_API_KEY is configured', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValue(textResponse(500, 'boom'));

        const client = new LcscClient(createTestConfig());
        const pending = client.searchParts('resistor');
        const assertion = expect(pending).rejects.toMatchObject({
          code: 'VENDOR_API_UNAVAILABLE',
        });
        await vi.runAllTimersAsync();
        await assertion;
        // no api key configured -> only jlcsearch was ever hit (all retries)
        for (const call of requestMock.mock.calls) {
          expect(call[0]).toContain('jlcsearch');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to the LCSC official API when jlcsearch fails and a key is configured', async () => {
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

        expect(result.parts[0].lcsc).toBe('C2');
        const fallbackCall = requestMock.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('lcsc.com/api/search'),
        );
        expect(fallbackCall).toBeDefined();
        expect(fallbackCall?.[1]).toMatchObject({ method: 'POST' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns a single part detail, unwrapping a { part } envelope', async () => {
      requestMock.mockResolvedValueOnce(jsonResponse(200, { part: { lcsc: 'C3' } }));

      const client = new LcscClient(createTestConfig());
      const part = await client.getPartDetail('C3');

      expect(part).toEqual({ lcsc: 'C3' });
    });

    it('rethrows a not-found error when there is no fallback key', async () => {
      requestMock.mockResolvedValue(textResponse(404, 'not found'));

      const client = new LcscClient(createTestConfig());
      await expect(client.getPartDetail('missing')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
      });
    });

    it('returns parts by category, preferring `parts` over `results`', async () => {
      requestMock.mockResolvedValueOnce(jsonResponse(200, { parts: [{ lcsc: 'C4' }] }));

      const client = new LcscClient(createTestConfig());
      const parts = await client.getPartsByCategory('resistors');

      expect(parts).toEqual([{ lcsc: 'C4' }]);
    });
  });
});

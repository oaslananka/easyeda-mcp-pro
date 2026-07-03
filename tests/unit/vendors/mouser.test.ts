import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { MouserClient } from '../../../src/vendors/mouser/client.js';

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

function createEnabledConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    MOUSER_ENABLED: true,
    MOUSER_API_KEY: 'test-api-key',
  });
}

describe('MouserClient', () => {
  it('should throw when MOUSER_ENABLED is false', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      MOUSER_ENABLED: false,
    });
    expect(() => new MouserClient(config)).toThrow('Mouser API is not enabled');
  });

  it('should throw when API key is missing', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      MOUSER_ENABLED: true,
      MOUSER_API_KEY: '',
    });
    expect(() => new MouserClient(config)).toThrow('Mouser API key is missing');
  });

  it('should construct when enabled with key', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      MOUSER_ENABLED: true,
      MOUSER_API_KEY: 'test-api-key',
    });
    const client = new MouserClient(config);
    expect(client).toBeInstanceOf(MouserClient);
    expect(typeof client.searchByKeyword).toBe('function');
    expect(typeof client.searchByPartNumber).toBe('function');
    expect(typeof client.getPriceAndAvailability).toBe('function');
  });

  describe('requests', () => {
    beforeEach(() => {
      requestMock.mockReset();
    });

    it('parses search-by-keyword results', async () => {
      requestMock.mockResolvedValueOnce(
        jsonResponse(200, {
          SearchResults: {
            Parts: [
              {
                MouserPartNumber: 'MSR-1',
                Manufacturer: 'Acme',
                Description: 'A resistor',
                DataSheetUrl: 'https://example.com/ds',
                PriceBreaks: [{ Quantity: 1, Price: 0.5 }],
                AvailabilityInStock: 10,
                LeadTime: '2 weeks',
                RoHS: true,
              },
            ],
            NumberOfResult: 1,
          },
        }),
      );

      const client = new MouserClient(createEnabledConfig());
      const parts = await client.searchByKeyword('resistor');

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        mouserNumber: 'MSR-1',
        priceBreaks: [{ quantity: 1, price: 0.5 }],
        rohs: true,
      });
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/search/keyword'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('parses search-by-part-number results', async () => {
      requestMock.mockResolvedValueOnce(
        jsonResponse(200, {
          SearchResults: { Parts: [{ MouserPartNumber: 'MSR-2' }] },
        }),
      );

      const client = new MouserClient(createEnabledConfig());
      const parts = await client.searchByPartNumber('MSR-2');

      expect(parts[0].mouserNumber).toBe('MSR-2');
    });

    it('returns price and availability for a known part', async () => {
      requestMock.mockResolvedValueOnce(
        jsonResponse(200, {
          SearchResults: { Parts: [{ MouserPartNumber: 'MSR-3', AvailabilityInStock: 5 }] },
        }),
      );

      const client = new MouserClient(createEnabledConfig());
      const part = await client.getPriceAndAvailability('MSR-3');

      expect(part.mouserNumber).toBe('MSR-3');
      expect(part.availability).toBe(5);
    });

    it('throws VENDOR_API_UNAVAILABLE when the part is not found', async () => {
      requestMock.mockResolvedValueOnce(jsonResponse(200, { SearchResults: { Parts: [] } }));

      const client = new MouserClient(createEnabledConfig());
      await expect(client.getPriceAndAvailability('missing')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        retryable: false,
      });
    });

    it('throws a retryable RATE_LIMITED error on 429', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValue(jsonResponse(429, {}));

        const client = new MouserClient(createEnabledConfig());
        const pending = client.searchByKeyword('x');
        const assertion = expect(pending).rejects.toMatchObject({
          code: 'RATE_LIMITED',
          retryable: true,
        });
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces the parsed ErrorMessage on a 4xx JSON error body', async () => {
      requestMock.mockResolvedValueOnce(
        textResponse(400, JSON.stringify({ ErrorMessage: 'bad key' })),
      );

      const client = new MouserClient(createEnabledConfig());
      await expect(client.searchByKeyword('x')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        message: 'bad key',
      });
    });

    it('falls back to a generic message on a 4xx non-JSON error body', async () => {
      requestMock.mockResolvedValueOnce(textResponse(400, 'not json'));

      const client = new MouserClient(createEnabledConfig());
      await expect(client.searchByKeyword('x')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        message: 'Mouser API returned status 400',
      });
    });
  });
});

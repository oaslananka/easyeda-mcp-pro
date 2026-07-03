import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { DigiKeyClient } from '../../../src/vendors/digikey/client.js';

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

function tokenResponse() {
  return jsonResponse(200, { access_token: 'tok-abc', expires_in: 600, token_type: 'bearer' });
}

function createEnabledConfig(overrides: Record<string, unknown> = {}) {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    DIGIKEY_ENABLED: true,
    DIGIKEY_CLIENT_ID: 'test-client-id',
    DIGIKEY_CLIENT_SECRET: 'test-client-secret',
    ...overrides,
  });
}

describe('DigiKeyClient', () => {
  it('should throw when DIGIKEY_ENABLED is false', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      DIGIKEY_ENABLED: false,
    });
    expect(() => new DigiKeyClient(config)).toThrow('DigiKey API is not enabled');
  });

  it('should throw when credentials are missing', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      DIGIKEY_ENABLED: true,
      DIGIKEY_CLIENT_ID: '',
      DIGIKEY_CLIENT_SECRET: '',
    });
    expect(() => new DigiKeyClient(config)).toThrow('DigiKey credentials are missing');
  });

  it('should construct when enabled with credentials', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      DIGIKEY_ENABLED: true,
      DIGIKEY_CLIENT_ID: 'test-client-id',
      DIGIKEY_CLIENT_SECRET: 'test-client-secret',
    });
    const client = new DigiKeyClient(config);
    expect(client).toBeInstanceOf(DigiKeyClient);
    expect(typeof client.searchByKeyword).toBe('function');
    expect(typeof client.getProductDetails).toBe('function');
    expect(typeof client.getDigitalBom).toBe('function');
  });

  it('should use sandbox URL when configured', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      DIGIKEY_ENABLED: true,
      DIGIKEY_CLIENT_ID: 'test-client-id',
      DIGIKEY_CLIENT_SECRET: 'test-client-secret',
      DIGIKEY_SANDBOX: true,
    });
    const client = new DigiKeyClient(config);
    expect(client).toBeDefined();
  });

  describe('requests', () => {
    beforeEach(() => {
      requestMock.mockReset();
    });

    it('acquires a token then searches by keyword', async () => {
      requestMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        jsonResponse(200, {
          Products: [
            {
              DigiKeyPartNumber: 'DK-1',
              ManufacturerPartNumber: 'MFR-1',
              Manufacturer: 'Acme',
              Description: 'A resistor',
              QuantityAvailable: 100,
              UnitPrice: 0.1,
              DataSheetUrl: 'https://example.com/ds',
              PhotoUrl: 'https://example.com/photo',
              RoHSStatus: 'compliant',
            },
          ],
        }),
      );

      const client = new DigiKeyClient(createEnabledConfig());
      const parts = await client.searchByKeyword('resistor');

      expect(parts).toHaveLength(1);
      expect(parts[0].digiKeyPartNumber).toBe('DK-1');
      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(requestMock.mock.calls[0][0]).toContain('/v1/oauth2/token');
      expect(requestMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    });

    it('reuses a cached token across multiple calls', async () => {
      requestMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse(200, {}))
        .mockResolvedValueOnce(jsonResponse(200, {}));

      const client = new DigiKeyClient(createEnabledConfig());
      await client.searchByKeyword('a');
      await client.searchByKeyword('b');

      // one token acquisition + two searches, no second token call
      expect(requestMock).toHaveBeenCalledTimes(3);
      expect(requestMock.mock.calls[0][0]).toContain('/v1/oauth2/token');
    });

    it('fetches product details via GET', async () => {
      requestMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        jsonResponse(200, {
          digiKeyPartNumber: 'DK-2',
          manufacturerPartNumber: 'MFR-2',
          manufacturer: 'Acme',
          description: 'A capacitor',
          quantityAvailable: 5,
          unitPrice: 1.2,
          datasheetUrl: '',
          photoUrl: '',
          rohsStatus: '',
        }),
      );

      const client = new DigiKeyClient(createEnabledConfig());
      const part = await client.getProductDetails('DK-2');

      expect(part.digiKeyPartNumber).toBe('DK-2');
      expect(requestMock.mock.calls[1][1]).toMatchObject({ method: 'GET' });
    });

    it('builds a digital BOM result with a total count', async () => {
      requestMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        jsonResponse(200, {
          Parts: [{ DigiKeyPartNumber: 'DK-3' }],
          TotalCount: 1,
        }),
      );

      const client = new DigiKeyClient(createEnabledConfig());
      const result = await client.getDigitalBom(['DK-3']);

      expect(result.total).toBe(1);
      expect(result.parts[0].digiKeyPartNumber).toBe('DK-3');
    });

    it('throws VENDOR_API_UNAVAILABLE when the token request fails', async () => {
      requestMock.mockResolvedValueOnce(textResponse(401, 'unauthorized'));

      const client = new DigiKeyClient(createEnabledConfig());
      await expect(client.searchByKeyword('x')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
      });
    });

    it('throws a retryable RATE_LIMITED error on 429', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValue(jsonResponse(429, {}));

        const client = new DigiKeyClient(createEnabledConfig());
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

    it('throws VENDOR_API_UNAVAILABLE on a non-2xx apiGet response', async () => {
      requestMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(textResponse(404, 'not found'));

      const client = new DigiKeyClient(createEnabledConfig());
      await expect(client.getProductDetails('missing')).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        retryable: false,
      });
    });
  });
});

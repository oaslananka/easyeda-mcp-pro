import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { JlcpcbClient } from '../../../src/vendors/jlcpcb/client.js';

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
    JLCPCB_MODE: 'approved_api',
    JLCPCB_CLIENT_ID: 'test-client-id',
    JLCPCB_CLIENT_SECRET: 'test-client-secret',
  });
}

function createDisabledConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    JLCPCB_MODE: 'disabled',
  });
}

describe('JlcpcbClient', () => {
  it('should construct when credentials are present', () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);
    expect(client).toBeInstanceOf(JlcpcbClient);
  });

  it('should throw when JLCPCB_MODE is disabled', () => {
    const config = createDisabledConfig();
    expect(() => new JlcpcbClient(config)).toThrow('JLCPCB API is not enabled');
  });

  it('should throw when credentials are missing in approved_api mode', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      JLCPCB_MODE: 'approved_api',
      JLCPCB_CLIENT_ID: '',
      JLCPCB_CLIENT_SECRET: '',
    });
    expect(() => new JlcpcbClient(config)).toThrow('JLCPCB credentials are missing');
  });

  it('should reject paid workflow method', async () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);

    await expect(
      client.placeOrder({ boardCount: 5, layers: 2, width: 50, height: 30 }),
    ).rejects.toThrow('intentionally unsupported');
  });

  it('should have expected methods', () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);
    expect(typeof client.getQuote).toBe('function');
    expect(typeof client.placeOrder).toBe('function');
    expect(typeof client.getOrderStatus).toBe('function');
    expect(typeof client.checkCapabilities).toBe('function');
  });

  describe('requests', () => {
    beforeEach(() => {
      requestMock.mockReset();
    });

    it('returns a parsed quote on success', async () => {
      const quote = { total: 42.5, currency: 'USD', breakdown: [{ item: 'pcb', cost: 42.5 }] };
      requestMock.mockResolvedValueOnce(jsonResponse(200, quote));

      const client = new JlcpcbClient(createEnabledConfig());
      const result = await client.getQuote({ boardCount: 5, layers: 2, width: 50, height: 30 });

      expect(result).toEqual(quote);
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/order/getQuote'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('fetches order status via GET with the order id in the query string', async () => {
      requestMock.mockResolvedValueOnce(
        jsonResponse(200, { status: 'in_production', details: {} }),
      );

      const client = new JlcpcbClient(createEnabledConfig());
      const result = await client.getOrderStatus('ORD-123');

      expect(result.status).toBe('in_production');
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('orderId=ORD-123'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns capability results', async () => {
      const capabilities = [{ feature: 'impedance', supported: true }];
      requestMock.mockResolvedValueOnce(jsonResponse(200, capabilities));

      const client = new JlcpcbClient(createEnabledConfig());
      const result = await client.checkCapabilities({ layers: 4 });

      expect(result).toEqual(capabilities);
    });

    it('throws a retryable RATE_LIMITED error on 429', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValue(jsonResponse(429, { message: 'slow down' }));

        const client = new JlcpcbClient(createEnabledConfig());
        const pending = client.getQuote({ boardCount: 1, layers: 2, width: 10, height: 10 });
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

    it('throws a retryable VENDOR_API_UNAVAILABLE error on 5xx', async () => {
      vi.useFakeTimers();
      try {
        requestMock.mockResolvedValue(textResponse(503, 'service unavailable'));

        const client = new JlcpcbClient(createEnabledConfig());
        const pending = client.getQuote({ boardCount: 1, layers: 2, width: 10, height: 10 });
        const assertion = expect(pending).rejects.toMatchObject({
          code: 'VENDOR_API_UNAVAILABLE',
          retryable: true,
        });
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces the parsed error message on 4xx with a JSON body', async () => {
      requestMock.mockResolvedValueOnce(
        textResponse(400, JSON.stringify({ message: 'bad width' })),
      );

      const client = new JlcpcbClient(createEnabledConfig());
      await expect(
        client.getQuote({ boardCount: 1, layers: 2, width: -1, height: 10 }),
      ).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        retryable: false,
        message: 'bad width',
      });
    });

    it('falls back to a generic message on 4xx with a non-JSON body', async () => {
      requestMock.mockResolvedValueOnce(textResponse(400, 'not json'));

      const client = new JlcpcbClient(createEnabledConfig());
      await expect(
        client.getQuote({ boardCount: 1, layers: 2, width: 10, height: 10 }),
      ).rejects.toMatchObject({
        code: 'VENDOR_API_UNAVAILABLE',
        message: 'JLCPCB API returned status 400',
      });
    });
  });
});

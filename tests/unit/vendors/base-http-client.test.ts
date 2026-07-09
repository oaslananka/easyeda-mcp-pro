import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  httpRequestWithRetry,
  configureVendorRateLimit,
  resetVendorRateLimitStateForTests,
} from '../../../src/vendors/base-http-client.js';
import {
  getGlobalMetricsCollector,
  resetGlobalMetricsCollector,
} from '../../../src/observability/index.js';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
  request: requestMock,
}));

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
} as any;

function okResponse() {
  return { statusCode: 200, body: Readable.from(['{}']) };
}

describe('base http client observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalMetricsCollector();
  });

  it('records vendor request timing on success', async () => {
    requestMock.mockResolvedValueOnce(okResponse());

    const result = await httpRequestWithRetry('https://vendor.example/api', {}, logger, 0);
    const snapshot = getGlobalMetricsCollector().snapshot();

    expect(result.statusCode).toBe(200);
    expect(snapshot.vendors['vendor.example']).toMatchObject({
      requestCount: 1,
      errorCount: 0,
      lastStatusCode: 200,
    });
  });

  it('records vendor request timing on failure', async () => {
    requestMock.mockRejectedValueOnce(new Error('network down'));

    await expect(
      httpRequestWithRetry('https://vendor.example/api', {}, logger, 0),
    ).rejects.toThrow();
    const snapshot = getGlobalMetricsCollector().snapshot();

    expect(snapshot.vendors['vendor.example']).toMatchObject({
      requestCount: 1,
      errorCount: 1,
    });
  });
});

describe('vendor rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVendorRateLimitStateForTests();
  });

  afterEach(() => {
    resetVendorRateLimitStateForTests();
  });

  it('does not delay requests when rate limiting is disabled (default)', async () => {
    requestMock.mockImplementation(() => Promise.resolve(okResponse()));

    const start = Date.now();
    await httpRequestWithRetry('https://vendor.example/a', {}, logger, 0);
    await httpRequestWithRetry('https://vendor.example/b', {}, logger, 0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('delays a second request to the same host until the configured interval has elapsed', async () => {
    vi.useFakeTimers();
    try {
      configureVendorRateLimit(200);
      requestMock.mockImplementation(() => Promise.resolve(okResponse()));

      const first = httpRequestWithRetry('https://vendor.example/a', {}, logger, 0);
      await vi.runAllTimersAsync();
      await first;

      const second = httpRequestWithRetry('https://vendor.example/b', {}, logger, 0);
      let resolved = false;
      void second.then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      await second;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
      configureVendorRateLimit(0);
    }
  });

  it('does not delay requests to different hosts', async () => {
    vi.useFakeTimers();
    try {
      configureVendorRateLimit(5000);
      requestMock.mockImplementation(() => Promise.resolve(okResponse()));

      await httpRequestWithRetry('https://vendor-a.example/x', {}, logger, 0);
      const second = httpRequestWithRetry('https://vendor-b.example/y', {}, logger, 0);
      await vi.advanceTimersByTimeAsync(10);
      await expect(second).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      vi.useRealTimers();
      configureVendorRateLimit(0);
    }
  });
});

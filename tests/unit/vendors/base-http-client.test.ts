import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpRequestWithRetry } from '../../../src/vendors/base-http-client.js';
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

describe('base http client observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalMetricsCollector();
  });

  it('records vendor request timing on success', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: Readable.from(['{}']),
    });

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

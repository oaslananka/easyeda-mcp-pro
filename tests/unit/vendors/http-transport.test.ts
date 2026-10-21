import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  httpRequestWithRetry,
  resetVendorRateLimitStateForTests,
} from '../../../src/vendors/base-http-client.js';
import {
  getGlobalMetricsCollector,
  resetGlobalMetricsCollector,
} from '../../../src/observability/index.js';

const logger = pino({ level: 'silent' });

describe('vendor HTTP transport contract', () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let handleRequest: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    resetVendorRateLimitStateForTests();
    resetGlobalMetricsCollector();
    server = createServer((request, response) => handleRequest(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('preserves POST headers, body, response status and UTF-8 text', async () => {
    let receivedBody = '';
    let receivedHeader: string | string[] | undefined;
    handleRequest = (request, response) => {
      receivedHeader = request.headers['x-vendor-test'];
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (receivedBody += chunk));
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        response.write('{"part":"direnç');
        response.end('"}');
      });
    };

    const result = await httpRequestWithRetry(
      `${origin}/part`,
      { method: 'POST', headers: { 'x-vendor-test': 'value' }, body: '{"mpn":"R1"}' },
      logger,
      0,
    );

    expect(result).toEqual({ statusCode: 201, responseText: '{"part":"direnç"}' });
    expect(receivedBody).toBe('{"mpn":"R1"}');
    expect(receivedHeader).toBe('value');
  });

  it.each([
    { chunks: [Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')], expected: '\uFEFF{}' },
    { chunks: [Buffer.from([0xc3]), Buffer.from([0xb6])], expected: 'ö' },
    { chunks: [Buffer.from([0x66, 0x80])], expected: 'f\uFFFD' },
    { chunks: [Buffer.alloc(0)], expected: '' },
  ])('preserves UTF-8 decoding for response bytes $chunks', async ({ chunks, expected }) => {
    handleRequest = (_request, response) => {
      for (const chunk of chunks) response.write(chunk);
      response.end();
    };

    const result = await httpRequestWithRetry(`${origin}/bytes`, {}, logger, 0);

    expect(result.responseText).toBe(expected);
  });

  it('returns redirect responses without following them', async () => {
    const visited: string[] = [];
    handleRequest = (request, response) => {
      visited.push(request.url ?? '');
      response.writeHead(302, { location: `${origin}/target` });
      response.end('redirect body');
    };

    const result = await httpRequestWithRetry(`${origin}/start`, {}, logger, 0);

    expect(result).toEqual({ statusCode: 302, responseText: 'redirect body' });
    expect(visited).toEqual(['/start']);
  });

  it('retries 5xx and 429 within the existing HTTP attempt budget', async () => {
    let attempts = 0;
    handleRequest = (_request, response) => {
      attempts += 1;
      response.writeHead([503, 429, 200][attempts - 1] ?? 500);
      response.end(String(attempts));
    };

    const result = await httpRequestWithRetry(`${origin}/retry`, {}, logger);

    expect(result).toEqual({ statusCode: 200, responseText: '3' });
    expect(attempts).toBe(3);
    expect(getGlobalMetricsCollector().snapshot().vendors['127.0.0.1']).toMatchObject({
      requestCount: 1,
      errorCount: 0,
      lastStatusCode: 200,
    });
  });

  it('returns 4xx bodies without retrying', async () => {
    const requests = vi.fn();
    handleRequest = (_request, response) => {
      requests();
      response.writeHead(400);
      response.end('invalid part');
    };

    expect(await httpRequestWithRetry(`${origin}/bad`, {}, logger)).toEqual({
      statusCode: 400,
      responseText: 'invalid part',
    });
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('bounds response body reads by the configured timeout', async () => {
    handleRequest = (_request, response) => {
      response.writeHead(200);
      response.write('unfinished');
    };

    await expect(
      httpRequestWithRetry(`${origin}/slow`, { timeoutMs: 100 }, logger, 0),
    ).rejects.toMatchObject({ code: 'VENDOR_API_UNAVAILABLE', retryable: true });
    expect(getGlobalMetricsCollector().snapshot().vendors['127.0.0.1']).toMatchObject({
      requestCount: 1,
      errorCount: 1,
    });
  });
});

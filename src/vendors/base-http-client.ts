import { request } from 'undici';
import type { Readable } from 'node:stream';
import { EasyEdaMcpError } from '../schemas/common.js';
import type pino from 'pino';

/** Default max retries for HTTP requests (2 retries = 3 total attempts). */
export const DEFAULT_MAX_RETRIES = 2;
/** Default base delay for exponential backoff (1 second). */
export const DEFAULT_BASE_DELAY_MS = 1000;
/** Default timeout for HTTP requests (30 seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Read the entire body of a readable stream and return it as a UTF-8 string.
 * Works with both Buffer and string chunks.
 */
export async function readBody(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Options for an HTTP request. */
export interface RequestOptions {
  /** HTTP method (default: GET). */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body string. */
  body?: string;
  /** Timeout in milliseconds (default: 30s). */
  timeoutMs?: number;
}

/** Result of a completed HTTP request. */
export interface RequestResult {
  /** HTTP status code. */
  statusCode: number;
  /** Response body as a string. */
  responseText: string;
}

export interface RequestResult {
  statusCode: number;
  responseText: string;
}

/**
 * Perform an HTTP request with exponential-backoff retry logic.
 *
 * Retries on 429 (rate-limit), 5xx (server errors), network failures,
 * and retryable `EasyEdaMcpError` instances.
 *
 * @param url - The full request URL.
 * @param options - Request method, headers, body, and timeout.
 * @param logger - Pino logger instance for structured logging.
 * @param maxRetries - Max retries before giving up (default: 2).
 * @throws {EasyEdaMcpError} With code `VENDOR_API_UNAVAILABLE` when all attempts fail.
 */
export async function httpRequestWithRetry(
  url: string,
  options: RequestOptions,
  logger: pino.Logger,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<RequestResult> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      logger.debug({ url, method, attempt }, 'http request');

      const { statusCode, body } = await request(url, {
        method,
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const responseText = await readBody(body as Readable);

      if ((statusCode === 429 || statusCode >= 500) && attempt <= maxRetries) {
        const delay = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ url, statusCode, attempt, delay }, 'retryable error');
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return { statusCode, responseText };
    } catch (err) {
      lastError = err;
      if (err instanceof EasyEdaMcpError && !err.retryable) throw err;
      if (attempt <= maxRetries) {
        const delay = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.debug({ url, attempt, delay }, 'request retry');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError instanceof EasyEdaMcpError
    ? lastError
    : new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: 'HTTP request failed after retries.',
        suggestion: 'Check network connectivity.',
        retryable: true,
        details: { error: String(lastError) },
      });
}

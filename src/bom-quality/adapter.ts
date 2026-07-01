/**
 * BOM quality — supplier adapter layer.
 *
 * Provides a common {@link SupplierAdapter} interface over each vendor
 * client so quality checks can query any configured supplier uniformly.
 *
 * Each adapter:
 *  - normalises part data into {@link SupplierQueryResult}
 *  - records a query timestamp for provenance
 *  - wraps transient errors with an exponential-backoff retry
 *
 * @module
 */

import { type LcscClient } from '../vendors/lcsc/client.js';
import { type MouserClient } from '../vendors/mouser/client.js';
import { type DigiKeyClient } from '../vendors/digikey/client.js';
import { EasyEdaMcpError } from '../schemas/common.js';
import { getLogger } from '../utils/logger.js';
import type pino from 'pino';
import type {
  SupplierKind,
  SupplierQueryResult,
  PartLifecycle,
  SupplierQueryStatus,
} from './types.js';

// ── Retry helper ───────────────────────────────────────────────────────────

const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 2_000;
const RETRY_ATTEMPTS = 2;

interface RetryableFn<T> {
  (attempt: number): Promise<T>;
}

async function withRetry<T>(
  label: string,
  fn: RetryableFn<T>,
  logger: pino.Logger,
  attempts: number = RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;

      // Only retry on retryable errors (rate limits, 5xx)
      const retryable = err instanceof EasyEdaMcpError ? err.retryable === true : true; // unknown errors are not retried

      if (!retryable || i === attempts) {
        throw err;
      }

      const delay = Math.min(RETRY_BASE_MS * 2 ** i, RETRY_MAX_MS);
      logger.debug({ delay, attempt: i + 1, label }, 'retrying supplier query');
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

function toLifecycle(raw: unknown): PartLifecycle {
  if (typeof raw === 'boolean') return raw ? 'discontinued' : 'active';
  if (typeof raw === 'string') {
    const lc = raw.toLowerCase();
    if (lc === 'active' || lc === 'production') return 'active';
    if (lc.includes('discon') || lc.includes('obsolete') || lc === 'eol') return 'discontinued';
  }
  return 'unknown';
}

function supplierSource(kind: SupplierKind): string {
  switch (kind) {
    case 'lcsc':
      return 'lcsc:jlcsearch-or-official-api';
    case 'mouser':
      return 'mouser:search-api';
    case 'digikey':
      return 'digikey:product-search-api';
    case 'jlcpcb':
      return 'jlcpcb:approved-api';
  }
}

function readStatusCode(details: unknown): number | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as Record<string, unknown>).statusCode;
  return typeof value === 'number' ? value : undefined;
}

function sanitizeReason(value: string): string {
  return value
    .replace(
      /(authorization|bearer|basic|api[-_ ]?key|client[-_ ]?secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .slice(0, 240);
}

export function classifySupplierFailure(error: unknown): {
  status: SupplierQueryStatus;
  reason: string;
  statusCode?: number;
} {
  const statusCode = error instanceof EasyEdaMcpError ? readStatusCode(error.details) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (error instanceof EasyEdaMcpError) {
    if (error.code === 'RATE_LIMITED' || statusCode === 429) {
      return { status: 'rate_limited', reason: sanitizeReason(message), statusCode };
    }
    if (error.code === 'CREDENTIALS_MISSING' || statusCode === 401 || statusCode === 403) {
      return { status: 'unauthorized', reason: sanitizeReason(message), statusCode };
    }
    if (error.code === 'VENDOR_API_UNAVAILABLE') {
      return { status: 'unavailable', reason: sanitizeReason(message), statusCode };
    }
  }

  if (
    error instanceof SyntaxError ||
    lower.includes('json') ||
    lower.includes('parse') ||
    lower.includes('invalid response')
  ) {
    return { status: 'invalid_response', reason: sanitizeReason(message), statusCode };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborterror') ||
    lower.includes('aborted')
  ) {
    return { status: 'timeout', reason: sanitizeReason(message), statusCode };
  }

  return { status: 'unavailable', reason: sanitizeReason(message), statusCode };
}

function noMatchResult(supplier: SupplierKind, now: string): SupplierQueryResult {
  return {
    supplier,
    status: 'no_match',
    found: false,
    lifecycle: 'unknown',
    stock: 0,
    queriedAt: now,
    source: supplierSource(supplier),
    cacheAgeSeconds: 0,
    fromCache: false,
    confidence: 'medium',
    reason: 'no matching part returned by supplier API',
  };
}

function unavailableResult(
  supplier: SupplierKind,
  now: string,
  error: unknown,
): SupplierQueryResult {
  const failure = classifySupplierFailure(error);
  return {
    supplier,
    status: failure.status,
    found: false,
    lifecycle: 'unknown',
    stock: 0,
    queriedAt: now,
    source: supplierSource(supplier),
    cacheAgeSeconds: 0,
    fromCache: false,
    confidence: 'low',
    reason: failure.reason,
    statusCode: failure.statusCode,
  };
}

function freshProvenance(
  kind: SupplierKind,
): Pick<SupplierQueryResult, 'source' | 'cacheAgeSeconds' | 'fromCache'> {
  return {
    source: supplierSource(kind),
    cacheAgeSeconds: 0,
    fromCache: false,
  };
}

// ── SupplierAdapter interface ──────────────────────────────────────────────

export interface SupplierAdapter {
  /** Short supplier key (e.g. 'lcsc', 'mouser'). */
  readonly kind: SupplierKind;
  /** Human-readable supplier name. */
  readonly displayName: string;
  /** Whether this supplier is configured and available. */
  isAvailable(): boolean;
  /**
   * Query a part by LCSC code or manufacturer part number.
   * Returns `null` when the part is not found (not an error).
   */
  queryPart(identifier: { lcsc?: string; mpn?: string }): Promise<SupplierQueryResult | null>;
}

// ── LCSC adapter ───────────────────────────────────────────────────────────

export class LcscAdapter implements SupplierAdapter {
  readonly kind: SupplierKind = 'lcsc';
  readonly displayName = 'LCSC';
  private client: LcscClient | null;
  private logger: pino.Logger;

  constructor(client: LcscClient | null) {
    this.client = client;
    this.logger = getLogger();
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private buildFoundResult(
    detail: import('../vendors/lcsc/client.js').LcscPart,
    now: string,
  ): SupplierQueryResult {
    const unitPrice =
      detail.priceBreaks?.[0]?.unitPrice ??
      (typeof detail.price === 'number'
        ? detail.price
        : typeof detail.price === 'string'
          ? parseFloat(detail.price)
          : undefined);

    return {
      supplier: 'lcsc',
      status: 'found',
      found: true,
      lcsc: detail.lcsc,
      mpn: detail.manufacturer || undefined,
      manufacturer: detail.manufacturer || undefined,
      description: detail.description || undefined,
      lifecycle: detail.discontinued ? 'discontinued' : 'active',
      stock: detail.stockCount ?? detail.stock ?? 0,
      unitPrice,
      currency: 'USD',
      leadTimeDays: detail.leadTime,
      queriedAt: now,
      ...freshProvenance('lcsc'),
      confidence: 'high',
    };
  }

  async queryPart(identifier: {
    lcsc?: string;
    mpn?: string;
  }): Promise<SupplierQueryResult | null> {
    const client = this.client;
    if (!client) return null;
    if (!identifier.lcsc && !identifier.mpn) return null;

    const lcscCode = identifier.lcsc;
    if (!lcscCode) return null; // LCSC requires an LCSC code

    const now = new Date().toISOString();

    try {
      const detail = await withRetry(
        `lcsc.getPartDetail(${lcscCode})`,
        () => client.getPartDetail(lcscCode),
        this.logger,
      );

      if (!detail) {
        return noMatchResult('lcsc', now);
      }

      return this.buildFoundResult(detail, now);
    } catch (err) {
      this.logger.warn({ err, lcscCode }, 'lcsc adapter query failed');
      // Return an "unavailable" result rather than throwing
      return unavailableResult('lcsc', now, err);
    }
  }
}

// ── Mouser adapter ─────────────────────────────────────────────────────────

export class MouserAdapter implements SupplierAdapter {
  readonly kind: SupplierKind = 'mouser';
  readonly displayName = 'Mouser';
  private client: MouserClient | null;
  private logger: pino.Logger;

  constructor(client: MouserClient | null) {
    this.client = client;
    this.logger = getLogger();
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private buildFoundResult(
    part: import('../vendors/mouser/client.js').MouserPart,
    now: string,
  ): SupplierQueryResult {
    return {
      supplier: 'mouser',
      status: 'found',
      found: true,
      mpn: part.manufacturer || undefined,
      manufacturer: part.manufacturer || undefined,
      description: part.description || undefined,
      lifecycle: 'active',
      stock: part.availability ?? 0,
      unitPrice: part.priceBreaks?.[0]?.price,
      currency: 'USD',
      leadTimeDays: part.leadTime ? parseInt(part.leadTime, 10) || undefined : undefined,
      queriedAt: now,
      ...freshProvenance('mouser'),
      confidence: 'high',
    };
  }

  async queryPart(identifier: {
    lcsc?: string;
    mpn?: string;
  }): Promise<SupplierQueryResult | null> {
    const client = this.client;
    if (!client) return null;
    const mpn = identifier.mpn;
    if (!mpn) return null; // Mouser requires an MPN

    const now = new Date().toISOString();

    try {
      const results = await withRetry(
        `mouser.searchByPartNumber(${mpn})`,
        () => client.searchByPartNumber(mpn),
        this.logger,
      );

      if (!results || results.length === 0) {
        return noMatchResult('mouser', now);
      }

      const part = results[0];
      if (!part) {
        return noMatchResult('mouser', now);
      }

      return this.buildFoundResult(part, now);
    } catch (err) {
      this.logger.warn({ err, mpn }, 'mouser adapter query failed');
      return unavailableResult('mouser', now, err);
    }
  }
}

// ── DigiKey adapter ────────────────────────────────────────────────────────

export class DigiKeyAdapter implements SupplierAdapter {
  readonly kind: SupplierKind = 'digikey';
  readonly displayName = 'DigiKey';
  private client: DigiKeyClient | null;
  private logger: pino.Logger;

  constructor(client: DigiKeyClient | null) {
    this.client = client;
    this.logger = getLogger();
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private buildFoundResult(
    part: import('../vendors/digikey/client.js').DigiKeyPart,
    mpn: string,
    now: string,
  ): SupplierQueryResult {
    return {
      supplier: 'digikey',
      status: 'found',
      found: true,
      mpn: part.manufacturerPartNumber || undefined,
      manufacturer: part.manufacturer || undefined,
      description: part.description || undefined,
      lifecycle: toLifecycle(part.rohsStatus), // RoHS active is a loose proxy
      stock: part.quantityAvailable ?? 0,
      unitPrice: part.unitPrice || undefined,
      currency: 'USD',
      queriedAt: now,
      ...freshProvenance('digikey'),
      confidence:
        part.manufacturerPartNumber?.toLowerCase() === mpn.toLowerCase() ? 'high' : 'medium',
    };
  }

  async queryPart(identifier: {
    lcsc?: string;
    mpn?: string;
  }): Promise<SupplierQueryResult | null> {
    const client = this.client;
    if (!client) return null;
    const mpn = identifier.mpn;
    if (!mpn) return null; // DigiKey requires MPN or keyword

    const now = new Date().toISOString();

    try {
      // Use keyword search as a proxy — DigiKey doesn't expose a
      // direct MPN-lookup endpoint in the current client.
      const results = await withRetry(
        `digikey.searchByKeyword(${mpn})`,
        () => client.searchByKeyword(mpn),
        this.logger,
      );

      if (!results || results.length === 0) {
        return noMatchResult('digikey', now);
      }

      // Take the first result — keyword search returns best match first
      const part = results[0];
      if (!part) {
        return noMatchResult('digikey', now);
      }

      return this.buildFoundResult(part, mpn, now);
    } catch (err) {
      this.logger.warn({ err, mpn }, 'digikey adapter query failed');
      return unavailableResult('digikey', now, err);
    }
  }
}

// ── Adapter registry / factory ─────────────────────────────────────────────

export interface AdapterMap {
  lcsc: LcscAdapter;
  mouser: MouserAdapter;
  digikey: DigiKeyAdapter;
}

/**
 * Build the adapter map from a ToolContext vendors object.
 * Each adapter wraps the corresponding vendor client (or null if disabled).
 */
export function createAdapters(vendors: {
  lcsc: LcscClient | null;
  mouser: MouserClient | null;
  digikey: DigiKeyClient | null;
}): AdapterMap {
  return {
    lcsc: new LcscAdapter(vendors.lcsc),
    mouser: new MouserAdapter(vendors.mouser),
    digikey: new DigiKeyAdapter(vendors.digikey),
  };
}

/**
 * Return the subset of adapters that are currently configured / available.
 */
export function availableAdapters(adapters: AdapterMap): SupplierAdapter[] {
  return Object.values(adapters).filter((a) => a.isAvailable());
}

import { type EnvConfig } from '../../config/env.js';
import { EasyEdaMcpError } from '../../schemas/common.js';
import { getLogger } from '../../utils/logger.js';
import type pino from 'pino';
import { httpRequestWithRetry, DEFAULT_REQUEST_TIMEOUT_MS } from '../base-http-client.js';
import { type VendorCache, createNoopVendorCache, cacheKey } from '../cache.js';

/**
 * Component categories exposed by the public jlcsearch API
 * (https://jlcsearch.tscircuit.com), each backed by its own
 * `/{category}/list.json` endpoint. There is no generic cross-category
 * full-text search or single-part lookup endpoint — every lookup is a
 * category-scoped, in-stock-first snapshot capped at 100 results.
 */
export const LCSC_CATEGORIES = [
  'resistors',
  'capacitors',
  'diodes',
  'mosfets',
  'leds',
  'microcontrollers',
  'switches',
  'led_drivers',
] as const;

export type LcscCategory = (typeof LCSC_CATEGORIES)[number];

export function isLcscCategory(value: string): value is LcscCategory {
  return (LCSC_CATEGORIES as readonly string[]).includes(value);
}

export interface LcscPart {
  lcsc: string;
  manufacturer: string;
  description: string;
  datasheet: string;
  stock: number;
  price: string;
  category: string;
  package: string;
  inStock: boolean;
  stockCount?: number;
  leadTime?: number;
  discontinued?: boolean;
  priceBreaks?: Array<{ quantity?: number; unitPrice?: number }>;
  /** LCSC/JLCPCB assembly classification, when the backing dataset exposes it. */
  classification?: 'basic' | 'preferred' | 'extended';
  /** Parametric attributes (e.g. Resistance, Tolerance) as reported by the source. */
  attributes?: Record<string, string>;
  /** Whether this result was served from the vendor cache. */
  fromCache?: boolean;
  /** Age of the cached data in seconds; 0 when live. */
  cacheAgeSeconds?: number;
}

export interface LcscSearchResponse {
  parts: LcscPart[];
  total: number;
  fromCache?: boolean;
  cacheAgeSeconds?: number;
}

/** Raw shape of a single component as returned by a jlcsearch `list.json` endpoint. */
interface RawJlcsearchComponent {
  lcsc: number | string;
  mfr?: string;
  description?: string;
  stock?: number;
  price1?: number;
  in_stock?: boolean;
  package?: string;
  is_basic?: boolean;
  is_preferred?: boolean;
  attributes?: string | Record<string, string>;
  [key: string]: unknown;
}

interface CategoryFetchResult {
  items: RawJlcsearchComponent[];
  fromCache: boolean;
  cacheAgeSeconds: number;
}

const CATEGORY_KEYWORDS: Record<LcscCategory, string[]> = {
  resistors: ['resistor', 'resistors', 'ohm'],
  capacitors: ['capacitor', 'capacitors', 'ceramic cap'],
  diodes: ['diode', 'diodes', 'zener', 'schottky'],
  mosfets: ['mosfet', 'mosfets', 'nmos', 'pmos'],
  leds: ['led', 'leds', 'light emitting diode'],
  microcontrollers: ['microcontroller', 'microcontrollers', 'mcu', 'esp32', 'stm32'],
  switches: ['switch', 'switches', 'button', 'tactile'],
  led_drivers: ['led driver', 'led-driver', 'led_driver', 'constant current driver'],
};

const PACKAGE_PATTERN =
  /\b(0201|0402|0603|0805|1206|1210|SOT-?23\w*|SOD-?123\w*|TO-?\d+\w*|SOIC-?\d+\w*|QFN-?\d+\w*)\b/i;

function normalizeLcscCode(raw: unknown): string {
  const asString = String(raw);
  const num = typeof raw === 'number' ? raw : parseInt(asString.replace(/^c/i, ''), 10);
  return Number.isFinite(num) ? `C${num}` : asString;
}

function toRawLcscId(code: string): number | null {
  const num = parseInt(code.replace(/^c/i, ''), 10);
  return Number.isFinite(num) ? num : null;
}

function parseAttributes(raw: RawJlcsearchComponent['attributes']): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function normalizeRawPart(raw: RawJlcsearchComponent, category: LcscCategory): LcscPart {
  const stock = typeof raw.stock === 'number' ? raw.stock : 0;
  const classification: LcscPart['classification'] = raw.is_basic
    ? 'basic'
    : raw.is_preferred
      ? 'preferred'
      : 'extended';

  return {
    lcsc: normalizeLcscCode(raw.lcsc),
    manufacturer: typeof raw.mfr === 'string' ? raw.mfr : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    datasheet: '',
    stock,
    stockCount: stock,
    price: raw.price1 !== undefined ? String(raw.price1) : '',
    category,
    package: typeof raw.package === 'string' ? raw.package : '',
    inStock: typeof raw.in_stock === 'boolean' ? raw.in_stock : stock > 0,
    classification,
    attributes: parseAttributes(raw.attributes),
  };
}

export class LcscClient {
  private config: EnvConfig;
  private logger: pino.Logger;
  private jlcsearchBase: string;
  private lcscApiKey: string;
  private cache: VendorCache;
  private cacheTtlSeconds: number;

  constructor(config: EnvConfig, cache: VendorCache = createNoopVendorCache()) {
    this.config = config;
    this.logger = getLogger();
    this.jlcsearchBase = config.JLCSEARCH_BASE_URL.replace(/\/+$/, '');
    this.lcscApiKey = config.LCSC_API_KEY;
    this.cache = cache;
    this.cacheTtlSeconds = config.SOURCING_CACHE_TTL_SECONDS;
  }

  private async jlcsearchRequest<T>(
    path: string,
    options: { method?: string; query?: Record<string, string> },
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const query = options.query
      ? Object.fromEntries(
          Object.entries(options.query).filter(([, v]) => v !== undefined && v !== ''),
        )
      : undefined;
    const queryString =
      query && Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : '';
    const url = `${this.jlcsearchBase}${path}${queryString}`;

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      { method, headers: { accept: 'application/json' }, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
      this.logger,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `LCSC jlcsearch API returned status ${statusCode}`,
        suggestion: 'Check JLCSEARCH_BASE_URL and network connectivity.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  private async lcscOfficialRequest<T>(
    path: string,
    options: { method?: string; body?: unknown },
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const url = `https://www.lcsc.com/api${path}`;

    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (this.lcscApiKey) {
      headers['x-api-key'] = this.lcscApiKey;
    }

    if (options.body) {
      headers['content-type'] = 'application/json';
    }

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `LCSC official API returned status ${statusCode}`,
        suggestion: 'Check LCSC_API_KEY and network connectivity.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  /** Fetch one category's `list.json`, transparently caching the raw item list. */
  private async fetchCategory(
    category: LcscCategory,
    query: Record<string, string>,
  ): Promise<CategoryFetchResult> {
    const key = this.cacheTtlSeconds > 0 ? cacheKey(['lcsc', category, query]) : undefined;

    if (key) {
      const cached = await this.cache.get<RawJlcsearchComponent[]>(key);
      if (cached) {
        return {
          items: cached.value,
          fromCache: true,
          cacheAgeSeconds: Math.floor((Date.now() - cached.storedAt) / 1000),
        };
      }
    }

    const data = await this.jlcsearchRequest<Record<string, RawJlcsearchComponent[]>>(
      `/${category}/list.json`,
      { query },
    );
    const items = data[category] ?? [];

    if (key) {
      await this.cache.set(key, items, this.cacheTtlSeconds);
    }

    return { items, fromCache: false, cacheAgeSeconds: 0 };
  }

  /**
   * Search a single known category with jlcsearch's native parametric filters
   * (e.g. `package`, `resistance`, `capacitance`, `in_stock`).
   */
  async searchCategory(
    category: LcscCategory,
    filters: Record<string, string> = {},
    options?: { limit?: number },
  ): Promise<LcscSearchResponse> {
    if (!isLcscCategory(category)) {
      return { parts: [], total: 0, fromCache: false, cacheAgeSeconds: 0 };
    }

    const query: Record<string, string> = { ...filters };
    if (options?.limit) query.limit = String(Math.min(options.limit, 100));

    const { items, fromCache, cacheAgeSeconds } = await this.fetchCategory(category, query);
    const parts = items.map((raw) => normalizeRawPart(raw, category));
    return { parts, total: parts.length, fromCache, cacheAgeSeconds };
  }

  /**
   * Best-effort keyword search. jlcsearch has no generic full-text search
   * endpoint, so this maps recognizable keywords (resistor, mosfet, 0603, ...)
   * to one or more category snapshots and filters them client-side. Queries
   * that don't match a known category scan all categories with a small
   * per-category limit.
   */
  async searchParts(
    query: string,
    options?: { limit?: number; page?: number },
  ): Promise<LcscSearchResponse> {
    const limit = options?.limit ?? 20;
    const lower = query.toLowerCase().trim();
    if (!lower) return { parts: [], total: 0, fromCache: false, cacheAgeSeconds: 0 };

    const packageMatch = query.match(PACKAGE_PATTERN);
    const filters: Record<string, string> = {};
    if (packageMatch) filters.package = packageMatch[0].toUpperCase();

    const matchedCategories = (Object.entries(CATEGORY_KEYWORDS) as Array<[LcscCategory, string[]]>)
      .filter(([, keywords]) => keywords.some((k) => lower.includes(k)))
      .map(([category]) => category);

    const categoriesToScan = matchedCategories.length > 0 ? matchedCategories : LCSC_CATEGORIES;
    const perCategoryLimit = matchedCategories.length > 0 ? Math.min(Math.max(limit, 20), 100) : 20;

    try {
      const results = await Promise.all(
        categoriesToScan.map((category) =>
          this.searchCategory(category, filters, { limit: perCategoryLimit }),
        ),
      );

      let parts = results.flatMap((r) => r.parts);

      if (matchedCategories.length === 0) {
        const packageToken = packageMatch?.[0]?.toLowerCase();
        const tokens = lower.split(/\s+/).filter((t) => t.length > 1 && t !== packageToken);
        if (tokens.length > 0) {
          parts = parts.filter((p) =>
            tokens.some(
              (t) =>
                p.manufacturer.toLowerCase().includes(t) ||
                p.description.toLowerCase().includes(t) ||
                p.package.toLowerCase().includes(t),
            ),
          );
        }
      }

      parts.sort((a, b) => (b.stockCount ?? 0) - (a.stockCount ?? 0));
      const limited = parts.slice(0, limit);
      const fromCache = results.length > 0 && results.every((r) => r.fromCache);
      const cacheAgeSeconds = fromCache
        ? Math.min(...results.map((r) => r.cacheAgeSeconds ?? 0))
        : 0;

      return { parts: limited, total: limited.length, fromCache, cacheAgeSeconds };
    } catch (err) {
      if (this.lcscApiKey) {
        this.logger.debug('jlcsearch failed, falling back to lcsc official api');
        return this.lcscOfficialRequest<LcscSearchResponse>('/search', {
          method: 'POST',
          body: { keyword: query, limit, page: options?.page ?? 1 },
        });
      }
      throw err;
    }
  }

  /**
   * Get detailed information for a specific LCSC part by its LCSC code.
   *
   * jlcsearch has no single-part lookup endpoint, so this scans the cached
   * per-category snapshots (each capped at the top 100 in-stock parts) for a
   * matching `lcsc` id. Parts outside that in-stock snapshot will not be
   * found via the keyless tier even though they exist at LCSC — this is a
   * known limitation of the public dataset, not a bug.
   */
  async getPartDetail(lcscCode: string): Promise<LcscPart | null> {
    const numericId = toRawLcscId(lcscCode);
    if (numericId === null) {
      return this.lcscApiKey ? this.officialPartDetail(lcscCode) : null;
    }

    const settled = await Promise.allSettled(
      LCSC_CATEGORIES.map(async (category) => ({
        category,
        ...(await this.fetchCategory(category, { limit: '100' })),
      })),
    );

    const successes = settled.filter(
      (s): s is PromiseFulfilledResult<CategoryFetchResult & { category: LcscCategory }> =>
        s.status === 'fulfilled',
    );

    for (const { value } of successes) {
      const match = value.items.find((raw) => Number(raw.lcsc) === numericId);
      if (match) {
        return {
          ...normalizeRawPart(match, value.category),
          fromCache: value.fromCache,
          cacheAgeSeconds: value.cacheAgeSeconds,
        };
      }
    }

    if (successes.length === 0) {
      if (this.lcscApiKey) {
        this.logger.debug('jlcsearch unavailable, falling back to lcsc official api');
        return this.officialPartDetail(lcscCode);
      }
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: 'LCSC jlcsearch API is unavailable across all categories',
        suggestion: 'Check JLCSEARCH_BASE_URL and network connectivity, or configure LCSC_API_KEY.',
        retryable: true,
      });
    }

    // Categories were reachable but no match was found in the in-stock snapshot.
    return null;
  }

  private async officialPartDetail(lcscCode: string): Promise<LcscPart | null> {
    return this.lcscOfficialRequest<LcscPart | null>(`/part/${encodeURIComponent(lcscCode)}`, {});
  }

  /** Get parts for a known category. Unknown categories return an empty list. */
  async getPartsByCategory(category: string): Promise<LcscPart[]> {
    if (!isLcscCategory(category)) return [];
    const { parts } = await this.searchCategory(category);
    return parts;
  }
}

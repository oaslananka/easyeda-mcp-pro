import { type EnvConfig } from '../../config/env.js';
import { EasyEdaMcpError } from '../../schemas/common.js';
import { getLogger } from '../../utils/logger.js';
import type pino from 'pino';
import { httpRequestWithRetry, DEFAULT_REQUEST_TIMEOUT_MS } from '../base-http-client.js';

interface MouserPriceBreak {
  quantity: number;
  price: number;
}

export interface MouserPart {
  mouserNumber: string;
  manufacturer: string;
  description: string;
  datasheetUrl: string;
  priceBreaks: MouserPriceBreak[];
  availability: number;
  leadTime: string;
  rohs: boolean;
}

export class MouserClient {
  private readonly config: EnvConfig;
  private readonly logger: pino.Logger;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: EnvConfig) {
    this.config = config;
    this.logger = getLogger();
    this.baseUrl = config.MOUSER_API_BASE_URL.replace(/\/+$/, '');
    this.apiKey = config.MOUSER_API_KEY;

    if (!config.MOUSER_ENABLED) {
      throw new EasyEdaMcpError({
        code: 'FEATURE_DISABLED',
        message: 'Mouser API is not enabled. Set MOUSER_ENABLED=true to enable.',
        suggestion: 'Set MOUSER_ENABLED=true and provide MOUSER_API_KEY in your environment.',
        retryable: false,
      });
    }

    if (!this.apiKey) {
      throw new EasyEdaMcpError({
        code: 'CREDENTIALS_MISSING',
        message: 'Mouser API key is missing.',
        suggestion: 'Set MOUSER_API_KEY environment variable.',
        retryable: false,
      });
    }
  }

  private async apiPost<T>(endpoint: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}?apiKey=${encodeURIComponent(this.apiKey)}`;

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
    );

    if (statusCode === 429) {
      throw new EasyEdaMcpError({
        code: 'RATE_LIMITED',
        message: 'Mouser API rate limit exceeded.',
        suggestion: 'Retry after a short delay or reduce request frequency.',
        retryable: true,
      });
    }

    if (statusCode < 200 || statusCode >= 300) {
      let parsed: { ErrorMessage?: string } | null = null;
      try {
        parsed = JSON.parse(responseText) as { ErrorMessage?: string };
      } catch {
        // ignore
      }
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: parsed?.ErrorMessage ?? `Mouser API returned status ${statusCode}`,
        suggestion: 'Check MOUSER_API_KEY and request parameters.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  private parseMouserPart(raw: Record<string, unknown>): MouserPart {
    const priceBreaks: MouserPriceBreak[] = [];
    const rawBreaks = raw['PriceBreaks'] as Array<Record<string, unknown>> | undefined;
    if (rawBreaks) {
      for (const pb of rawBreaks) {
        priceBreaks.push({
          quantity: Number(pb['Quantity'] ?? 0),
          price: Number(pb['Price'] ?? 0),
        });
      }
    }

    return {
      mouserNumber: String(raw['MouserPartNumber'] ?? raw['MouserNumber'] ?? ''),
      manufacturer: String(raw['Manufacturer'] ?? ''),
      description: String(raw['Description'] ?? ''),
      datasheetUrl: String(raw['DataSheetUrl'] ?? raw['DatasheetUrl'] ?? ''),
      priceBreaks,
      availability: Number(raw['AvailabilityInStock'] ?? raw['Availability'] ?? 0),
      leadTime: String(raw['LeadTime'] ?? ''),
      rohs: Boolean(raw['RoHS'] ?? raw['Rohs'] ?? false),
    };
  }

  /**
   * Search Mouser parts by keyword.
   * @param query - The search keyword
   * @returns Array of matching parts
   */
  async searchByKeyword(query: string): Promise<MouserPart[]> {
    const response = await this.apiPost<{
      SearchResults?: {
        Parts?: Array<Record<string, unknown>>;
        NumberOfResult?: number;
      };
    }>('/api/v1/search/keyword', {
      SearchByKeywordRequest: { keyword: query },
    });

    const parts = response.SearchResults?.Parts ?? [];
    return parts.map((p) => this.parseMouserPart(p));
  }

  /**
   * Search Mouser parts by exact manufacturer part number.
   * @param partNumber - The manufacturer part number
   * @returns Array of matching parts
   */
  async searchByPartNumber(partNumber: string): Promise<MouserPart[]> {
    const response = await this.apiPost<{
      SearchResults?: {
        Parts?: Array<Record<string, unknown>>;
        NumberOfResult?: number;
      };
    }>('/api/v1/search/partnumber', {
      SearchByPartNumberRequest: { partNumber },
    });

    const parts = response.SearchResults?.Parts ?? [];
    return parts.map((p) => this.parseMouserPart(p));
  }

  /**
   * Get price and availability for a specific Mouser part number.
   * @param mouserNumber - The Mouser system part number
   * @returns Part details with pricing and stock
   */
  async getPriceAndAvailability(mouserNumber: string): Promise<MouserPart> {
    const response = await this.apiPost<{
      SearchResults?: {
        Parts?: Array<Record<string, unknown>>;
      };
    }>('/api/v1/search/partnumber', {
      SearchByPartNumberRequest: { partNumber: mouserNumber },
    });

    const raw = response.SearchResults?.Parts?.[0];
    if (!raw) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `Mouser part ${mouserNumber} not found.`,
        suggestion: 'Verify the Mouser part number is correct.',
        retryable: false,
        details: { mouserNumber },
      });
    }

    return this.parseMouserPart(raw);
  }
}

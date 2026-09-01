import { type EnvConfig } from '../../config/env.js';
import { EasyEdaMcpError } from '../../schemas/common.js';
import { getLogger } from '../../utils/logger.js';
import type pino from 'pino';
import { httpRequestWithRetry, DEFAULT_REQUEST_TIMEOUT_MS } from '../base-http-client.js';

export interface DigiKeyPart {
  digiKeyPartNumber: string;
  manufacturerPartNumber: string;
  manufacturer: string;
  description: string;
  quantityAvailable: number;
  unitPrice: number;
  datasheetUrl: string;
  photoUrl: string;
  rohsStatus: string;
}

export interface DigiKeyDigitalBomResult {
  parts: DigiKeyPart[];
  total: number;
}

interface DigiKeyTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class DigiKeyClient {
  private readonly config: EnvConfig;
  private readonly logger: pino.Logger;
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: EnvConfig) {
    this.config = config;
    this.logger = getLogger();
    this.clientId = config.DIGIKEY_CLIENT_ID;
    this.clientSecret = config.DIGIKEY_CLIENT_SECRET;

    if (!config.DIGIKEY_ENABLED) {
      throw new EasyEdaMcpError({
        code: 'FEATURE_DISABLED',
        message: 'DigiKey API is not enabled. Set DIGIKEY_ENABLED=true to enable.',
        suggestion:
          'Set DIGIKEY_ENABLED=true and provide DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.',
        retryable: false,
      });
    }

    if (!this.clientId || !this.clientSecret) {
      throw new EasyEdaMcpError({
        code: 'CREDENTIALS_MISSING',
        message: 'DigiKey credentials are missing.',
        suggestion: 'Set DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET environment variables.',
        retryable: false,
      });
    }

    if (config.DIGIKEY_SANDBOX) {
      this.baseUrl = 'https://sandbox-api.digikey.com';
      this.authUrl = 'https://sandbox-api.digikey.com/v1/oauth2/token';
    } else {
      this.baseUrl = 'https://api.digikey.com';
      this.authUrl = 'https://api.digikey.com/v1/oauth2/token';
    }
  }

  private async ensureToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && now < this.tokenExpiresAt - 60) {
      return this.accessToken;
    }

    this.logger.debug('digikey acquiring oauth2 token');

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const { statusCode, responseText } = await httpRequestWithRetry(
      this.authUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basicAuth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(this.clientId),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `DigiKey OAuth2 token request failed with status ${statusCode}`,
        suggestion: 'Check DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, and network connectivity.',
        retryable: false,
        details: { statusCode },
      });
    }

    const tokenData = JSON.parse(responseText) as DigiKeyTokenResponse;
    this.accessToken = tokenData.access_token;
    this.tokenExpiresAt = now + tokenData.expires_in;

    return this.accessToken;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}${path}`;

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'X-DIGIKEY-Client-Id': this.clientId,
        },
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
    );

    if (statusCode === 429) {
      throw new EasyEdaMcpError({
        code: 'RATE_LIMITED',
        message: 'DigiKey API rate limit exceeded.',
        suggestion: 'Retry after a short delay or reduce request frequency.',
        retryable: true,
      });
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `DigiKey API returned status ${statusCode}`,
        suggestion: 'Check request parameters and DigiKey API status.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}${path}`;

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'X-DIGIKEY-Client-Id': this.clientId,
        },
        body: JSON.stringify(body),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
    );

    if (statusCode === 429) {
      throw new EasyEdaMcpError({
        code: 'RATE_LIMITED',
        message: 'DigiKey API rate limit exceeded.',
        suggestion: 'Retry after a short delay or reduce request frequency.',
        retryable: true,
      });
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `DigiKey API returned status ${statusCode}`,
        suggestion: 'Check request parameters and DigiKey API status.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  private parseDigiKeyPart(raw: Record<string, unknown>): DigiKeyPart {
    return {
      digiKeyPartNumber: String(raw['DigiKeyPartNumber'] ?? raw['digiKeyPartNumber'] ?? ''),
      manufacturerPartNumber: String(
        raw['ManufacturerPartNumber'] ?? raw['manufacturerPartNumber'] ?? '',
      ),
      manufacturer: String(raw['Manufacturer'] ?? raw['manufacturer'] ?? ''),
      description: String(raw['Description'] ?? raw['description'] ?? ''),
      quantityAvailable: Number(raw['QuantityAvailable'] ?? raw['quantityAvailable'] ?? 0),
      unitPrice: Number(raw['UnitPrice'] ?? raw['unitPrice'] ?? 0),
      datasheetUrl: String(raw['DataSheetUrl'] ?? raw['datasheetUrl'] ?? ''),
      photoUrl: String(raw['PhotoUrl'] ?? raw['photoUrl'] ?? ''),
      rohsStatus: String(raw['RoHSStatus'] ?? raw['rohsStatus'] ?? ''),
    };
  }

  /**
   * Search DigiKey parts by keyword.
   * @param query - The search keyword
   * @returns Array of matching parts
   */
  async searchByKeyword(query: string): Promise<DigiKeyPart[]> {
    const response = await this.apiPost<{
      Products?: Array<Record<string, unknown>>;
    }>('/search/v3/products/keyword', {
      Keywords: query,
      Limit: 25,
      Offset: 0,
      locale: this.config.DIGIKEY_LOCALE,
      currency: this.config.DIGIKEY_CURRENCY,
    });

    const products = response.Products ?? [];
    return products.map((p) => this.parseDigiKeyPart(p));
  }

  /**
   * Get detailed product information for a specific DigiKey part number.
   * @param digiKeyPartNumber - The DigiKey part number
   * @returns Part details
   */
  async getProductDetails(digiKeyPartNumber: string): Promise<DigiKeyPart> {
    const response = await this.apiGet<Record<string, unknown>>(
      `/products/v4/search/product-details?digikeyPartNumber=${encodeURIComponent(digiKeyPartNumber)}&locale=${encodeURIComponent(this.config.DIGIKEY_LOCALE)}&currency=${encodeURIComponent(this.config.DIGIKEY_CURRENCY)}`,
    );

    return this.parseDigiKeyPart(response);
  }

  /**
   * Get pricing and availability for multiple DigiKey parts (digital BOM).
   * @param partNumbers - Array of DigiKey part numbers
   * @returns BOM result with parts list and total count
   */
  async getDigitalBom(partNumbers: string[]): Promise<DigiKeyDigitalBomResult> {
    const response = await this.apiPost<{
      Parts?: Array<Record<string, unknown>>;
      TotalCount?: number;
    }>('/bom/v1/bom', {
      Parts: partNumbers.map((pn) => ({ DigiKeyPartNumber: pn })),
      locale: this.config.DIGIKEY_LOCALE,
      currency: this.config.DIGIKEY_CURRENCY,
    });

    const parts = (response.Parts ?? []).map((p) => this.parseDigiKeyPart(p));
    const total = response.TotalCount ?? parts.length;

    return { parts, total };
  }
}

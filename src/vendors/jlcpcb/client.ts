import { type EnvConfig } from '../../config/env.js';
import { EasyEdaMcpError } from '../../schemas/common.js';
import { getLogger } from '../../utils/logger.js';
import type pino from 'pino';
import { httpRequestWithRetry, DEFAULT_REQUEST_TIMEOUT_MS } from '../base-http-client.js';

interface JlcPcbLayerConfig {
  layerId: number;
  copperWeight: string;
  thickness?: number;
}

interface JlcPcbStencilConfig {
  included: boolean;
  type?: 'top' | 'bottom' | 'both';
}

export interface JlcPcbOrderRequest {
  boardCount: number;
  layers: number;
  width: number;
  height: number;
  color?: string;
  surfaceFinish?: string;
  copperWeight?: string;
  boardThickness?: number;
  impedance?: boolean;
  solderMask?: string;
  silkscreen?: string;
  stencil?: JlcPcbStencilConfig;
  layerConfig?: JlcPcbLayerConfig[];
  deliveryTime?: string;
  pcbQty?: number;
}

export interface JlcPcbQuoteResult {
  total: number;
  currency: string;
  breakdown: Array<{ item: string; cost: number }>;
}

export interface JlcPcbOrderResult {
  orderId: string;
}

export interface JlcPcbOrderStatus {
  status: string;
  details: unknown;
}

export interface JlcPcbCapability {
  feature: string;
  supported: boolean;
  constraints?: string;
}

/** Maximum retry attempts for JLCPCB API calls (3 vs base default 2). */
const JLCPCB_MAX_RETRIES = 3;

export class JlcpcbClient {
  private config: EnvConfig;
  private logger: pino.Logger;
  private baseUrl: string;

  constructor(config: EnvConfig) {
    this.config = config;
    this.logger = getLogger();
    this.baseUrl = config.JLCPCB_API_BASE_URL.replace(/\/+$/, '');

    if (config.JLCPCB_MODE !== 'approved_api') {
      throw new EasyEdaMcpError({
        code: 'FEATURE_DISABLED',
        message: 'JLCPCB API is not enabled. Set JLCPCB_MODE=approved_api to enable.',
        suggestion:
          'Set JLCPCB_MODE=approved_api and provide JLCPCB_CLIENT_ID and JLCPCB_CLIENT_SECRET.',
        retryable: false,
      });
    }

    if (!config.JLCPCB_CLIENT_ID || !config.JLCPCB_CLIENT_SECRET) {
      throw new EasyEdaMcpError({
        code: 'CREDENTIALS_MISSING',
        message: 'JLCPCB credentials are missing.',
        suggestion: 'Set JLCPCB_CLIENT_ID and JLCPCB_CLIENT_SECRET environment variables.',
        retryable: false,
      });
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'x-client-id': this.config.JLCPCB_CLIENT_ID,
      'x-client-secret': this.config.JLCPCB_CLIENT_SECRET,
      'content-type': 'application/json',
    };
  }

  private async requestWithRetry<T>(
    path: string,
    options: { method?: string; body?: unknown },
  ): Promise<T> {
    const method = options.method ?? 'POST';
    const url = `${this.baseUrl}${path}`;
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    const { statusCode, responseText } = await httpRequestWithRetry(
      url,
      {
        method,
        headers: this.authHeaders(),
        body: bodyStr,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      this.logger,
      JLCPCB_MAX_RETRIES,
    );

    if (statusCode === 429) {
      this.logger.warn({ url, statusCode }, 'jlcpcb rate limited');
      throw new EasyEdaMcpError({
        code: 'RATE_LIMITED',
        message: `JLCPCB API rate limit exceeded.`,
        suggestion: 'Retry after a short delay or reduce request frequency.',
        retryable: true,
      });
    }

    if (statusCode >= 500) {
      this.logger.warn({ url, statusCode }, 'jlcpcb server error');
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: `JLCPCB API returned status ${statusCode}`,
        suggestion: 'Check JLCPCB credentials and request parameters.',
        retryable: true,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    if (statusCode < 200 || statusCode >= 300) {
      let parsed: { message?: string; error?: string } | null = null;
      try {
        parsed = JSON.parse(responseText) as { message?: string; error?: string };
      } catch {
        // ignore parse failure
      }
      throw new EasyEdaMcpError({
        code: 'VENDOR_API_UNAVAILABLE',
        message: parsed?.message ?? parsed?.error ?? `JLCPCB API returned status ${statusCode}`,
        suggestion: 'Check JLCPCB credentials and request parameters.',
        retryable: statusCode >= 500,
        details: { statusCode, response: responseText.slice(0, 500) },
      });
    }

    return JSON.parse(responseText) as T;
  }

  /**
   * Request a quotation for a PCB order from JLCPCB.
   * @param request - The PCB order specification
   * @returns Quote result with total cost and breakdown
   */
  async getQuote(request: JlcPcbOrderRequest): Promise<JlcPcbQuoteResult> {
    return this.requestWithRetry<JlcPcbQuoteResult>('/api/order/getQuote', {
      method: 'POST',
      body: request,
    });
  }

  /**
   * Paid/order-like operations are intentionally unsupported by this MCP package.
   * Use the quote gating workflow to prepare audit evidence, then complete procurement outside the agent.
   */
  async placeOrder(_request: JlcPcbOrderRequest): Promise<JlcPcbOrderResult> {
    throw new EasyEdaMcpError({
      code: 'FEATURE_DISABLED',
      message: 'JLCPCB order placement is intentionally unsupported by easyeda-mcp-pro.',
      suggestion:
        'Use easyeda_jlcpcb_quote_workflow for quote/audit preparation, then complete any purchase manually in an approved procurement workflow.',
      retryable: false,
    });
  }

  /**
   * Get the current status of an existing JLCPCB order.
   * @param orderId - The JLCPCB order ID
   * @returns Order status and details
   */
  async getOrderStatus(orderId: string): Promise<JlcPcbOrderStatus> {
    return this.requestWithRetry<JlcPcbOrderStatus>(
      `/api/order/getOrderDetail?orderId=${encodeURIComponent(orderId)}`,
      { method: 'GET' },
    );
  }

  /**
   * Check JLCPCB capabilities for a given board specification.
   * @param boardSpec - Board specification to check
   * @returns Array of capability results
   */
  async checkCapabilities(boardSpec: Partial<JlcPcbOrderRequest>): Promise<JlcPcbCapability[]> {
    return this.requestWithRetry<JlcPcbCapability[]>('/api/capabilities/check', {
      method: 'POST',
      body: boardSpec,
    });
  }
}

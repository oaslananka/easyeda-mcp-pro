import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerExportTools } from '../../../src/tools/L1_export.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('JLCPCB quote workflow tool', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerExportTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'pro',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('prepares non-binding quote snapshot without bridge calls', async () => {
    const tool = registry.get('easyeda_jlcpcb_quote_workflow');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      provider: 'jlcpcb',
      action: 'estimate',
      projectId: 'proj-quote',
      board: { boardCount: 5, layers: 2, widthMm: 50, heightMm: 30 },
      vendorTermsReviewed: true,
      productionFilesReady: true,
      exportManifestVerified: true,
      productionReviewPassed: true,
      quote: {
        total: 12.34,
        currency: 'USD',
        estimated: true,
        nonBinding: true,
        source: 'local-estimate',
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.allowed).toBe(true);
    expect(result?.quote.non_binding).toBe(true);
    expect(result?.audit.paid_operation_attempted).toBe(false);
    expect(result?.unsupported_operations).toContain('place_order');
  });

  it('blocks order-like intent and records audit evidence', async () => {
    const tool = registry.get('easyeda_jlcpcb_quote_workflow');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      provider: 'jlcpcb',
      action: 'place_order',
      projectId: 'proj-quote',
      board: { boardCount: 5, layers: 2, widthMm: 50, heightMm: 30 },
      confirmation: {
        confirmed: true,
        confirmationText:
          'I understand this quote workflow is non-binding and no paid order will be placed by this tool',
        userId: 'user-1',
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.allowed).toBe(false);
    expect(result?.status).toBe('blocked');
    expect(result?.risk.paid_operation).toBe(true);
    expect(result?.audit.confirmed).toBe(true);
    expect(result?.audit.paid_operation_allowed).toBe(false);
    expect(result?.issues.map((issue: { code: string }) => issue.code)).toContain(
      'QUOTE_PAID_OPERATION_UNSUPPORTED',
    );
  });
});

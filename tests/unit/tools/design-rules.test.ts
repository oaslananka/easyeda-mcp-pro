import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerDesignRulesTools } from '../../../src/tools/L1_design_rules.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Design Rules Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerDesignRulesTools(registry, config);

    context = {
      profile: 'core',
      bridge: {
        connected: false,
        call: vi.fn(),
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('is registered with core profile, low risk, and no confirmWrite', () => {
    const tool = registry.get('easyeda_design_rules_lookup');
    expect(tool).toBeDefined();
    expect(tool!.profile).toBe('core');
    expect(tool!.risk).toBe('low');
    expect(tool!.confirmWrite).toBe(false);
    expect(tool!.annotations.readOnlyHint).toBe(true);
  });

  it('publishes the complete input signature through MCP tools/list', async () => {
    const server = new McpServer({ name: 'design-rules-schema-test', version: '1.0.0' });
    const client = new Client({ name: 'design-rules-schema-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registry.registerAllOnServer(server, context);

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const tool = listed.tools.find(
        (candidate) => candidate.name === 'easyeda_design_rules_lookup',
      );
      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;

      expect(tool?.inputSchema.type).toBe('object');
      expect(properties).toBeDefined();
      expect(Object.keys(properties ?? {})).toEqual(
        expect.arrayContaining([
          'topic',
          'currentA',
          'traceWidthMils',
          'traceWidthMm',
          'neckDownWidthMm',
          'manufacturerMinWidthMm',
          'environment',
          'temperatureRiseC',
          'layer',
          'copperWeightOz',
          'voltageV',
          'location',
          'protocol',
          'category',
          'loadA',
          'minBulkCapacitanceUfPerA',
          'minBulkCapacitanceUf',
          'id',
        ]),
      );
      expect(tool?.inputSchema.required).toContain('topic');
      expect(properties?.currentA).toMatchObject({ type: 'number' });
      expect(properties?.copperWeightOz).toMatchObject({ type: 'number' });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  describe('topic: trace-width', () => {
    it('returns a trace-width result', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, {
        topic: 'trace-width',
        currentA: 1,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      });
      expect((result as any).traceWidth).toBeDefined();
      expect((result as any).traceWidth.traceWidthMils).toBeGreaterThan(0);
    });
  });

  describe('topic: max-current', () => {
    it('returns a max-current result', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, {
        topic: 'max-current',
        traceWidthMils: 12,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      });
      expect((result as any).maxCurrent).toBeDefined();
      expect((result as any).maxCurrent.maxCurrentA).toBeGreaterThan(0);
    });
  });

  describe('topic: trace-current-review', () => {
    it('returns explicit unknowns when context and native routing data are missing', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = (await tool?.handler(context, { topic: 'trace-current-review' })) as {
        traceCurrentReview: {
          status: string;
          evidence: string;
          findings: Array<{ id: string; status: string }>;
        };
      };
      expect(tool?.outputSchema.parse(result)).toEqual(result);
      expect(result.traceCurrentReview.status).toBe('UNKNOWN');
      expect(result.traceCurrentReview.evidence).toBe('caller_supplied_unverified');
      expect(result.traceCurrentReview.findings).toContainEqual(
        expect.objectContaining({ id: 'ROUTE_GEOMETRY', status: 'UNKNOWN' }),
      );
      expect(context.bridge.call).not.toHaveBeenCalled();
    });

    it('flags supplied thermal and fab width risks without design mutation or false PASS', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = (await tool?.handler(context, {
        topic: 'trace-current-review',
        currentA: 2,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
        traceWidthMm: 1,
        neckDownWidthMm: 0.1,
        manufacturerMinWidthMm: 0.15,
      })) as {
        traceCurrentReview: {
          status: string;
          estimatedMinimumWidthMm: number;
          suppliedNarrowestWidthMm: number;
          findings: Array<{ id: string; status: string }>;
        };
      };
      expect(tool?.outputSchema.parse(result)).toEqual(result);
      expect(result.traceCurrentReview.status).toBe('WARNING');
      expect(result.traceCurrentReview.suppliedNarrowestWidthMm).toBe(0.1);
      expect(result.traceCurrentReview.estimatedMinimumWidthMm).toBeGreaterThan(0.1);
      expect(result.traceCurrentReview.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'THERMAL_ESTIMATE', status: 'WARNING' }),
          expect.objectContaining({ id: 'FABRICATION_WIDTH', status: 'WARNING' }),
          expect.objectContaining({ id: 'VIA_BOTTLENECK', status: 'UNKNOWN' }),
        ]),
      );
      expect(context.bridge.call).not.toHaveBeenCalled();
    });

    it('rejects invalid numeric inputs using the existing tool error contract', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = (await tool?.handler(context, {
        topic: 'trace-current-review',
        currentA: -5,
      })) as { error?: string; traceCurrentReview?: unknown };
      expect(result.error).toBeDefined();
      expect(result.traceCurrentReview).toBeUndefined();
    });

    it('retains legacy numeric calculator input and result keys', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = (await tool?.handler(context, {
        topic: 'trace-width',
        currentA: 1,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      })) as {
        traceWidth: {
          traceWidthMm: number;
          traceWidthMils: number;
          method: string;
          inputs: { copperWeightOz: number };
          units: { traceWidthMm: string };
        };
      };
      expect(tool?.outputSchema.parse(result)).toEqual(result);
      expect(result.traceWidth.traceWidthMils).toBeGreaterThan(11.5);
      expect(result.traceWidth.traceWidthMm).toBeGreaterThan(0.2);
      expect(result.traceWidth.method).toBe('IPC2221_EMPIRICAL_REFERENCE');
      expect(result.traceWidth.inputs.copperWeightOz).toBe(1);
      expect(result.traceWidth.units.traceWidthMm).toBe('mm');
    });
  });

  describe('topic: clearance', () => {
    it('returns a clearance result', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, {
        topic: 'clearance',
        voltageV: 12,
        location: 'external',
      });
      expect((result as any).clearance).toBeDefined();
      expect((result as any).clearance.minClearanceMm).toBeGreaterThan(0);
    });
  });

  describe('topic: protocol-routing', () => {
    it('returns a single protocol when specified', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'protocol-routing', protocol: 'i2c' });
      expect((result as any).protocolRouting).toBeDefined();
      expect((result as any).protocolRouting.protocol).toBe('i2c');
      expect((result as any).protocolRoutingList).toBeUndefined();
    });

    it('returns the full list when no protocol is specified', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'protocol-routing' });
      expect((result as any).protocolRoutingList).toBeDefined();
      expect((result as any).protocolRoutingList.length).toBeGreaterThan(1);
      expect((result as any).protocolRouting).toBeUndefined();
    });
  });

  describe('topic: decoupling', () => {
    it('returns a single category when specified', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'decoupling', category: 'mcu' });
      expect((result as any).decoupling).toBeDefined();
      expect((result as any).decoupling.category).toBe('mcu');
    });

    it('returns the full list when no category is specified', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'decoupling' });
      expect((result as any).decouplingList).toBeDefined();
      expect((result as any).decouplingList.length).toBeGreaterThan(1);
    });
  });

  describe('topic: bulk-capacitance', () => {
    it('returns a bulk-capacitance recommendation', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'bulk-capacitance', loadA: 2 });
      expect((result as any).bulkCapacitance).toBeDefined();
      expect((result as any).bulkCapacitance.requiredBulkCapacitanceUf).toBeGreaterThan(0);
    });

    it('surfaces an error rather than throwing for invalid input', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'bulk-capacitance', loadA: -1 });
      expect((result as any).error).toBeDefined();
      expect((result as any).bulkCapacitance).toBeUndefined();
    });
  });

  describe('topic: dfm-checklist', () => {
    it('returns the full checklist when no filters are given', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'dfm-checklist' });
      expect((result as any).dfmChecklist).toBeDefined();
      expect((result as any).dfmChecklist.length).toBeGreaterThan(5);
    });

    it('filters by category', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'dfm-checklist', category: 'drilling' });
      const items = (result as any).dfmChecklist;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.category).toBe('drilling');
    });

    it('returns a single item by id', async () => {
      const tool = registry.get('easyeda_design_rules_lookup');
      const result = await tool?.handler(context, { topic: 'dfm-checklist', id: 'annular-ring' });
      expect((result as any).dfmChecklistItem).toBeDefined();
      expect((result as any).dfmChecklistItem.id).toBe('annular-ring');
    });
  });
});

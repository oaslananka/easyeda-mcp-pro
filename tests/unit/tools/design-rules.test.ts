import { describe, it, expect, vi, beforeEach } from 'vitest';
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

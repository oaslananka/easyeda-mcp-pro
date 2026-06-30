import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

function createDevContext(bridgeCall = vi.fn()): ToolContext {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });

  return {
    profile: 'dev',
    bridge: {
      connected: true,
      call: bridgeCall,
    },
    config,
  } as unknown as ToolContext;
}

function createDevRegistry(): ToolRegistry {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });
  const registry = new ToolRegistry();
  registry.setProfile('dev');
  registerBuiltinTools(registry, config);
  return registry;
}

describe('diagnostics API tools', () => {
  it('registers the read-only schematic wire probe in dev profile', async () => {
    const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });
    const registry = new ToolRegistry();
    registry.setProfile('dev');
    registerBuiltinTools(registry, config);
    const tool = registry.get('easyeda_wire_probe');
    const bridgeCall = vi.fn().mockResolvedValue({
      total: 1,
      samples: [{ primitiveId: 'w1', net: '+5V', line: [1, 2, 3, 4] }],
    });

    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);

    const result = await tool?.handler(createDevContext(bridgeCall), { limit: 5 });

    expect(bridgeCall).toHaveBeenCalledWith('system.inspectWires', { limit: 5 });
    expect(result).toEqual({
      total: 1,
      samples: [{ primitiveId: 'w1', net: '+5V', line: [1, 2, 3, 4] }],
    });
  });

  it('returns not_available when the bridge does not expose wire inspection', async () => {
    const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });
    const registry = new ToolRegistry();
    registry.setProfile('dev');
    registerBuiltinTools(registry, config);
    const tool = registry.get('easyeda_wire_probe');
    const bridgeCall = vi
      .fn()
      .mockRejectedValue(new Error('SCH_PrimitiveWire.getAll is not available'));

    const result = await tool?.handler(createDevContext(bridgeCall), { limit: 5 });

    expect(result).toMatchObject({
      total: 0,
      samples: [],
      not_available: true,
      error: 'SCH_PrimitiveWire.getAll is not available',
    });
  });

  it('runs a consolidated EasyEDA live smoke report', async () => {
    const registry = createDevRegistry();
    const tool = registry.get('easyeda_live_smoke_report');
    const bridgeCall = vi.fn(async (method: string) => {
      switch (method) {
        case 'system.getStatus':
          return { connected: true, easyedaVersion: '3.2.149' };
        case 'system.apiInventory':
          return {
            total: 2,
            classes: [{ className: 'DMT_Board' }, { className: 'SCH_PrimitiveWire' }],
          };
        case 'system.inspectComponents':
          return { total: 2, samples: [{ designator: 'R1' }] };
        case 'system.inspectWires':
          return { total: 2, samples: [{ primitiveId: 'wire-1', line: [360, 575, 285, 500] }] };
        case 'schematic.listNets':
          return [
            { netName: 'GND', nodes: [{ component: 'R1', pin: '1' }] },
            { netName: '+5V', nodes: [{ component: 'R1', pin: '2' }] },
          ];
        default:
          throw new Error(`unexpected method: ${method}`);
      }
    });

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      projectId: '',
      limit: 10,
      includeRaw: true,
    })) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean }>;
      summary: {
        component_total?: number;
        wire_total?: number;
        net_total?: number;
        net_names?: string[];
      };
      raw?: { nets?: unknown };
    };

    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.summary).toMatchObject({
      component_total: 2,
      wire_total: 2,
      net_total: 2,
      net_names: ['GND', '+5V'],
    });
    expect(result.raw?.nets).toEqual([
      { netName: 'GND', nodes: [{ component: 'R1', pin: '1' }] },
      { netName: '+5V', nodes: [{ component: 'R1', pin: '2' }] },
    ]);
    expect(bridgeCall).toHaveBeenCalledWith(
      'schematic.listNets',
      { projectId: '' },
      { timeoutMs: 15000 },
    );
  });

  it('keeps the live smoke report running and marks failed checks', async () => {
    const registry = createDevRegistry();
    const tool = registry.get('easyeda_live_smoke_report');
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'system.inspectWires') throw new Error('wire inspection failed');
      return method === 'schematic.listNets' ? [] : { total: 0 };
    });

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      includeRaw: false,
    })) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; error?: string }>;
      raw?: unknown;
    };

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'wires')).toMatchObject({
      ok: false,
      error: 'wire inspection failed',
    });
    expect(result.raw).toBeUndefined();
    expect(bridgeCall).toHaveBeenCalledTimes(5);
  });
});

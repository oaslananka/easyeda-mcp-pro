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

  describe('easyeda_live_write_regression', () => {
    const testDeviceItem = { uuid: 'dev-uuid', libraryUuid: 'lib-uuid' };

    it('runs the schematic scope end to end and reports every step ok', async () => {
      const registry = createDevRegistry();
      const tool = registry.get('easyeda_live_write_regression');
      expect(tool).toBeDefined();
      expect(tool?.confirmWrite).toBe(true);

      let capturedNetA = '';
      const bridgeCall = vi.fn(async (method: string, params?: unknown) => {
        if (method === 'schematic.placeComponent') {
          const p = params as { x: number };
          return { primitiveId: p.x === 900 ? 'compA' : 'compB' };
        }
        if (method === 'schematic.connectPinToNet') {
          const p = params as { primitiveId: string; pinNumber: string; netName: string };
          if (p.pinNumber === '1') capturedNetA = p.netName;
          return { primitiveId: `wire-${p.primitiveId}-${p.pinNumber}` };
        }
        if (method === 'schematic.listNets') {
          return [{ netName: capturedNetA, nodes: [{}, {}] }];
        }
        if (method === 'api.call') {
          return {
            result: [
              { pinNumber: '1', pinName: '1', x: 10, y: 10, rotation: 0, pinLength: 10 },
              { pinNumber: '2', pinName: '2', x: 20, y: 10, rotation: 0, pinLength: 10 },
            ],
          };
        }
        if (method === 'schematic.addWire') {
          throw new Error('NET_COLLISION: point (20, 10) coincides with an existing pin');
        }
        if (method === 'schematic.deletePrimitive') return undefined;
        return null;
      });

      const result = (await tool?.handler(createDevContext(bridgeCall), {
        projectId: 'proj-1',
        testDeviceItem,
        scope: 'schematic',
        confirmWrite: true,
      })) as {
        ok: boolean;
        steps: Array<{ id: string; ok: boolean; error?: string }>;
        cleanup_performed: boolean;
      };

      expect(result.ok).toBe(true);
      const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
      expect(byId['schematic.place_a']?.ok).toBe(true);
      expect(byId['schematic.place_b']?.ok).toBe(true);
      expect(byId['schematic.connect_a_pin1']?.ok).toBe(true);
      expect(byId['schematic.connect_b_pin1_same_net']?.ok).toBe(true);
      expect(byId['schematic.verify_net_merge']?.ok).toBe(true);
      expect(byId['schematic.collision_guard_blocks_foreign_net']?.ok).toBe(true);
      expect(result.cleanup_performed).toBe(true);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
        primitiveIds: expect.arrayContaining(['compA', 'compB']),
      });
    });

    it('flags a failed step but still cleans up primitives created before the failure', async () => {
      const registry = createDevRegistry();
      const tool = registry.get('easyeda_live_write_regression');

      const bridgeCall = vi.fn(async (method: string, params?: unknown) => {
        if (method === 'schematic.placeComponent') {
          const p = params as { x: number };
          if (p.x === 900) return { primitiveId: 'compA' };
          throw new Error('place failed');
        }
        if (method === 'schematic.deletePrimitive') return undefined;
        return null;
      });

      const result = (await tool?.handler(createDevContext(bridgeCall), {
        projectId: 'proj-1',
        testDeviceItem,
        scope: 'schematic',
        confirmWrite: true,
      })) as {
        ok: boolean;
        steps: Array<{ id: string; ok: boolean; error?: string }>;
        cleanup_performed: boolean;
      };

      expect(result.ok).toBe(false);
      const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
      expect(byId['schematic.place_a']?.ok).toBe(true);
      expect(byId['schematic.place_b']?.ok).toBe(false);
      expect(result.cleanup_performed).toBe(true);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
        primitiveIds: ['compA'],
      });
    });

    it('runs the pcb scope and verifies delete actually removes the via', async () => {
      const registry = createDevRegistry();
      const tool = registry.get('easyeda_live_write_regression');

      let viaDeleted = false;
      const bridgeCall = vi.fn(async (method: string) => {
        if (method === 'pcb.addVia') return { primitiveId: 'via1' };
        if (method === 'pcb.addTrack') return { primitiveIds: ['trk1'] };
        if (method === 'pcb.listVias') {
          return { items: viaDeleted ? [] : [{ primitiveId: 'via1' }] };
        }
        if (method === 'pcb.deleteComponent') {
          viaDeleted = true;
          return { notFound: [] };
        }
        return null;
      });

      const result = (await tool?.handler(createDevContext(bridgeCall), {
        testDeviceItem,
        scope: 'pcb',
        confirmWrite: true,
      })) as {
        ok: boolean;
        steps: Array<{ id: string; ok: boolean; error?: string }>;
        cleanup_performed: boolean;
      };

      expect(result.ok).toBe(true);
      expect(result.cleanup_performed).toBe(false); // pcb scope self-cleans, no schematic primitives
      const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
      expect(byId['pcb.add_via']?.ok).toBe(true);
      expect(byId['pcb.add_track']?.ok).toBe(true);
      expect(byId['pcb.verify_readback']?.ok).toBe(true);
      expect(byId['pcb.delete_and_verify_gone']?.ok).toBe(true);
    });

    it('fails the delete_and_verify_gone step when a primitive survives deletion', async () => {
      const registry = createDevRegistry();
      const tool = registry.get('easyeda_live_write_regression');

      const bridgeCall = vi.fn(async (method: string) => {
        if (method === 'pcb.addVia') return { primitiveId: 'via1' };
        if (method === 'pcb.addTrack') return { primitiveIds: ['trk1'] };
        if (method === 'pcb.listVias') return { items: [{ primitiveId: 'via1' }] };
        if (method === 'pcb.deleteComponent') return { notFound: [] }; // reports success but via never actually disappears
        return null;
      });

      const result = (await tool?.handler(createDevContext(bridgeCall), {
        testDeviceItem,
        scope: 'pcb',
        confirmWrite: true,
      })) as { steps: Array<{ id: string; ok: boolean; error?: string }> };

      const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
      expect(byId['pcb.delete_and_verify_gone']?.ok).toBe(false);
      expect(byId['pcb.delete_and_verify_gone']?.error).toContain('still present');
    });
  });
});

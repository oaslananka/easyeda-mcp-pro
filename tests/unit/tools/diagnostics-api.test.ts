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
});

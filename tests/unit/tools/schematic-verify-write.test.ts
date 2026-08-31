import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerSchematicReadTools } from '../../../src/tools/L1_schematic_read.js';
import type { ToolContext } from '../../../src/tools/types.js';

describe('easyeda_schematic_verify_write component read-back', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerSchematicReadTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('accepts the paginated component envelope and uses its total for the delta verdict', async () => {
    bridgeCall
      .mockResolvedValueOnce({
        total: 3,
        items: [{ reference: 'R1' }, { reference: 'R2' }],
      })
      .mockResolvedValueOnce({ valid: true });

    const result = await registry.get('easyeda_schematic_verify_write')?.handler(context, {
      projectId: 'proj-123',
      beforeComponentCount: 2,
      expectedComponentCountDelta: 1,
    });

    expect(result).toMatchObject({
      components_available: true,
      component_count: 3,
      component_count_delta: 1,
      component_delta_matches: true,
      warnings: [],
    });
  });

  it('preserves the legacy bare-array component read-back contract', async () => {
    bridgeCall.mockResolvedValueOnce([{ reference: 'R1' }, { reference: 'R2' }]);

    const result = await registry.get('easyeda_schematic_verify_write')?.handler(context, {
      projectId: 'proj-123',
      beforeComponentCount: 1,
      expectedComponentCountDelta: 1,
    });

    expect(result).toMatchObject({
      components_available: true,
      component_count: 2,
      component_count_delta: 1,
      component_delta_matches: true,
    });
  });

  it('falls back to the item count when an envelope total is smaller than the returned page', async () => {
    bridgeCall.mockResolvedValueOnce({
      total: 1,
      items: [{ reference: 'R1' }, { reference: 'R2' }],
    });

    const result = await registry.get('easyeda_schematic_verify_write')?.handler(context, {
      projectId: 'proj-123',
      beforeComponentCount: 1,
      expectedComponentCountDelta: 1,
    });

    expect(result).toMatchObject({
      components_available: true,
      component_count: 2,
      component_count_delta: 1,
      component_delta_matches: true,
    });
  });

  it('treats an envelope without an items array as unavailable', async () => {
    bridgeCall.mockResolvedValueOnce({ total: 2, items: null });

    const result = await registry.get('easyeda_schematic_verify_write')?.handler(context, {
      projectId: 'proj-123',
      beforeComponentCount: 1,
      expectedComponentCountDelta: 1,
    });

    expect(result).toMatchObject({
      components_available: false,
      component_count: undefined,
      component_count_delta: undefined,
      component_delta_matches: undefined,
    });
    expect(result?.warnings).toContain('Component read-back returned a non-array response.');
  });

  it('treats a null component read-back as unavailable', async () => {
    bridgeCall.mockResolvedValueOnce(null);

    const result = await registry.get('easyeda_schematic_verify_write')?.handler(context, {
      projectId: 'proj-123',
    });

    expect(result).toMatchObject({
      components_available: false,
      component_count: undefined,
    });
    expect(result?.warnings).toContain('Component read-back returned a non-array response.');
  });
});

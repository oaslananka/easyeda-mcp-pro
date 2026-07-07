import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbReadTools } from '../../../src/tools/L1_pcb_read.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('PCB Read Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<
    typeof vi.fn<(method: string, params?: unknown, opts?: unknown) => Promise<unknown>>
  >;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerPcbReadTools(registry, config);

    bridgeCall = vi.fn();

    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
        bridgeHost: '127.0.0.1',
        bridgePort: 49620,
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('easyeda_pcb_components returns items and total from the bridge', async () => {
    const tool = registry.get('easyeda_pcb_components');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);

    bridgeCall.mockResolvedValue({
      total: 1,
      items: [{ primitiveId: 'c1', designator: 'R1', x: 11000, y: 6000 }],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.listComponents', { limit: 100, offset: 0 });
    expect(result).toEqual({
      project_id: 'proj-123',
      components: [{ primitiveId: 'c1', designator: 'R1', x: 11000, y: 6000 }],
      total: 1,
    });
  });

  it('easyeda_pcb_components reports not_available on bridge error instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_components');
    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(result).toEqual({
      project_id: 'proj-123',
      components: [],
      total: 0,
      not_available: true,
      error: 'Bridge not connected',
    });
  });

  it('easyeda_pcb_tracks returns items and total from the bridge', async () => {
    const tool = registry.get('easyeda_pcb_tracks');
    bridgeCall.mockResolvedValue({
      total: 2,
      items: [
        { primitiveId: 't1', net: 'GND', startX: 150, startY: 150, endX: 200, endY: 150 },
        { primitiveId: 't2', net: 'GND', startX: 200, startY: 150, endX: 200, endY: 200 },
      ],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.listTracks', { limit: 100, offset: 0 });
    expect(result?.total).toBe(2);
    expect(result?.tracks).toHaveLength(2);
  });

  it('easyeda_pcb_tracks reports not_available on bridge error instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_tracks');
    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(result).toEqual({
      project_id: 'proj-123',
      tracks: [],
      total: 0,
      not_available: true,
      error: 'Bridge not connected',
    });
  });

  it('easyeda_pcb_vias returns items and total from the bridge', async () => {
    const tool = registry.get('easyeda_pcb_vias');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [{ primitiveId: 'v1', net: 'GND', x: 150, y: 150, holeDiameter: 300, diameter: 600 }],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.listVias', { limit: 100, offset: 0 });
    expect(result).toEqual({
      project_id: 'proj-123',
      vias: [{ primitiveId: 'v1', net: 'GND', x: 150, y: 150, holeDiameter: 300, diameter: 600 }],
      total: 1,
    });
  });

  it('easyeda_pcb_vias reports not_available on bridge error instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_vias');
    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(result).toEqual({
      project_id: 'proj-123',
      vias: [],
      total: 0,
      not_available: true,
      error: 'Bridge not connected',
    });
  });
});

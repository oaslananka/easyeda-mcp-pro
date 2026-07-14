import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerBoardTools } from '../../../src/tools/L1_board.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Board Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<
    typeof vi.fn<(method: string, params?: unknown, opts?: unknown) => Promise<unknown>>
  >;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerBoardTools(registry, config);

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

  it('easyeda_board_layers returns layer list from bridge', async () => {
    const tool = registry.get('easyeda_board_layers');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue([
      { name: 'Top Layer', type: 'signal', color: '#ff0000', visible: true, order: 1 },
      { name: 'Bottom Layer', type: 'signal', color: '#0000ff', visible: true, order: 2 },
      { name: 'GND Plane', type: 'plane', visible: false, order: 3 },
    ]);

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(bridgeCall).toHaveBeenCalledWith('board.listLayers', { projectId: 'proj-123' });
    expect(result).toBeDefined();
    expect(result?.project_id).toBe('proj-123');
    expect(result?.layers).toHaveLength(3);
    expect(result?.total).toBe(3);
    expect(result?.layers[0]).toMatchObject({
      name: 'Top Layer',
      type: 'signal',
      color: '#ff0000',
      visible: true,
      order: 1,
    });
    expect(result?.layers[2]).toMatchObject({
      name: 'GND Plane',
      type: 'plane',
      visible: false,
      order: 3,
    });
  });

  it('easyeda_board_stackup returns stackup data', async () => {
    const tool = registry.get('easyeda_board_stackup');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      totalLayers: 4,
      boardThicknessMm: 1.6,
      layers: [
        {
          name: 'Top Layer',
          type: 'signal',
          thicknessMm: 0.035,
          material: 'Copper',
          dielectricConstant: 4.5,
          copperWeightOz: 1,
        },
        {
          name: 'Dielectric',
          type: 'core',
          thicknessMm: 1.53,
          material: 'FR4',
          dielectricConstant: 4.5,
        },
        {
          name: 'Bottom Layer',
          type: 'signal',
          thicknessMm: 0.035,
          material: 'Copper',
          dielectricConstant: 4.5,
          copperWeightOz: 1,
        },
      ],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(bridgeCall).toHaveBeenCalledWith('board.getStackup', { projectId: 'proj-123' });
    expect(result).toBeDefined();
    expect(result?.project_id).toBe('proj-123');
    expect(result?.total_layers).toBe(4);
    expect(result?.board_thickness_mm).toBe(1.6);
    expect(result?.layers).toHaveLength(3);
    expect(result?.layers[0]).toMatchObject({
      name: 'Top Layer',
      type: 'signal',
      thickness_mm: 0.035,
      material: 'Copper',
      dielectric_constant: 4.5,
      copper_weight_oz: 1,
    });
  });

  it('easyeda_board_stackup marks copper-count-only data as unavailable', async () => {
    const tool = registry.get('easyeda_board_stackup');
    bridgeCall.mockResolvedValue({
      totalLayers: 2,
      layers: [],
      available: false,
      source: 'copper_layer_count_only',
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });
    expect(result).toMatchObject({
      project_id: 'proj-123',
      total_layers: 2,
      layers: [],
      data_source: 'copper_layer_count_only',
      not_available: true,
    });
    expect(result?.board_thickness_mm).toBeUndefined();
    expect(result?.error).toContain('only the copper-layer count was verified');
  });

  it('easyeda_board_dimensions returns dimensions', async () => {
    const tool = registry.get('easyeda_board_dimensions');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      widthMm: 100,
      heightMm: 80,
      shape: 'rectangle',
      mountingHoleCount: 4,
      areaMm2: 8000,
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(bridgeCall).toHaveBeenCalledWith('board.getDimensions', { projectId: 'proj-123' });
    expect(result).toBeDefined();
    expect(result?.project_id).toBe('proj-123');
    expect(result?.width_mm).toBe(100);
    expect(result?.height_mm).toBe(80);
    expect(result?.shape).toBe('rectangle');
    expect(result?.mounting_hole_count).toBe(4);
    expect(result?.area_mm2).toBe(8000);
  });

  it('easyeda_board_dimensions distinguishes a missing outline from a 0x0 board', async () => {
    const tool = registry.get('easyeda_board_dimensions');
    bridgeCall.mockResolvedValue({
      widthMm: 0,
      heightMm: 0,
      mountingHoleCount: 0,
      areaMm2: 0,
      hasOutline: false,
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });
    expect(result).toMatchObject({
      project_id: 'proj-123',
      width_mm: 0,
      height_mm: 0,
      has_outline: false,
      not_available: true,
    });
    expect(result?.error).toContain('No board outline');
  });

  it('easyeda_board_features returns feature counts', async () => {
    const tool = registry.get('easyeda_board_features');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      vias: 42,
      tracks: 156,
      zones: 8,
      pads: 320,
      components: 45,
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(bridgeCall).toHaveBeenCalledWith('board.getFeatures', { projectId: 'proj-123' });
    expect(result).toBeDefined();
    expect(result?.project_id).toBe('proj-123');
    expect(result?.vias).toBe(42);
    expect(result?.tracks).toBe(156);
    expect(result?.zones).toBe(8);
    expect(result?.pads).toBe(320);
    expect(result?.components).toBe(45);
  });

  it('easyeda_board_layers returns not_available when bridge call fails', async () => {
    const tool = registry.get('easyeda_board_layers');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge disconnected'));

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result?.not_available).toBe(true);
    expect(result?.project_id).toBe('proj-123');
    expect(result?.layers).toEqual([]);
    expect(result?.total).toBe(0);
    expect(result?.error).toBe('Bridge disconnected');
  });

  it('easyeda_board_stackup returns not_available when bridge call fails', async () => {
    const tool = registry.get('easyeda_board_stackup');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge disconnected'));

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result?.not_available).toBe(true);
    expect(result?.project_id).toBe('proj-123');
    expect(result?.total_layers).toBe(0);
    expect(result?.layers).toEqual([]);
    expect(result?.error).toBe('Bridge disconnected');
  });

  it('easyeda_board_dimensions returns not_available when bridge call fails', async () => {
    const tool = registry.get('easyeda_board_dimensions');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge disconnected'));

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result?.not_available).toBe(true);
    expect(result?.project_id).toBe('proj-123');
    expect(result?.mounting_hole_count).toBe(0);
    expect(result?.error).toBe('Bridge disconnected');
  });

  it('easyeda_board_features returns not_available when bridge call fails', async () => {
    const tool = registry.get('easyeda_board_features');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge disconnected'));

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result?.not_available).toBe(true);
    expect(result?.project_id).toBe('proj-123');
    expect(result?.vias).toBe(0);
    expect(result?.tracks).toBe(0);
    expect(result?.zones).toBe(0);
    expect(result?.pads).toBe(0);
    expect(result?.error).toBe('Bridge disconnected');
  });
});

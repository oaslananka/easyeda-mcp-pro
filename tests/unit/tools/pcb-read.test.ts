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

  it('easyeda_pcb_fills normalizes bridge polygon source without exposing it', async () => {
    const tool = registry.get('easyeda_pcb_fills');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);

    bridgeCall.mockResolvedValue({
      total: 1,
      items: [
        {
          primitiveId: 'fill-1',
          layer: 1,
          net: '',
          netless: true,
          fillMode: 0,
          lineWidth: 1,
          locked: false,
          polygonSource: ['R', 0, 0, 20, 10, 0, 0],
        },
      ],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 25, offset: 2 });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.listFills', { limit: 25, offset: 2 });
    expect(result).toEqual({
      project_id: 'proj-123',
      fills: [
        {
          primitiveId: 'fill-1',
          layer: 1,
          net: '',
          netless: true,
          fillMode: 0,
          lineWidth: 1,
          locked: false,
          polygon: {
            contours: [
              {
                points: [
                  { x: 0, y: 0 },
                  { x: 20, y: 0 },
                  { x: 20, y: 10 },
                  { x: 0, y: 10 },
                ],
                pointCount: 4,
                truncated: false,
                bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
              },
            ],
            contourCount: 1,
            pointCount: 4,
            truncated: false,
            bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
          },
        },
      ],
      total: 1,
    });
  });

  it('easyeda_pcb_regions normalizes bridge rule metadata and bounded geometry', async () => {
    const tool = registry.get('easyeda_pcb_regions');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);

    bridgeCall.mockResolvedValue({
      total: 1,
      items: [
        {
          primitiveId: 'region-1',
          layer: 12,
          ruleTypes: [5, 7],
          regionName: 'route keepout',
          lineWidth: 1,
          locked: true,
          polygonSource: ['R', 0, 0, 500, 500, 0, 0],
        },
      ],
    });

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 10, offset: 0 });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.listRegions', { limit: 10, offset: 0 });
    expect(result).toMatchObject({
      project_id: 'proj-123',
      total: 1,
      regions: [
        {
          primitiveId: 'region-1',
          ruleTypes: [5, 7],
          regionName: 'route keepout',
          polygon: {
            contourCount: 1,
            pointCount: 4,
            truncated: false,
            bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
          },
        },
      ],
    });
    expect((result?.regions as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'polygonSource',
    );
  });

  it('normalizes live CIRCLE sources and sanitizes invalid Fill metadata', async () => {
    const tool = registry.get('easyeda_pcb_fills');
    bridgeCall.mockResolvedValue({
      items: [
        {
          primitiveId: { opaque: true },
          layer: '12',
          net: 42,
          fillMode: 1.5,
          lineWidth: Number.NaN,
          locked: 1,
          polygonSource: ['CIRCLE', 10, 20, 5],
        },
      ],
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-circle',
      limit: 100,
      offset: 0,
    });
    const fill = ((result?.fills ?? []) as Array<Record<string, any>>)[0];

    expect(result?.total).toBe(1);
    expect(fill).toMatchObject({
      primitiveId: '',
      net: '',
      netless: true,
      locked: false,
      polygon: { contourCount: 1, pointCount: 32, truncated: false },
    });
    expect(fill.layer).toBeUndefined();
    expect(fill.fillMode).toBeUndefined();
    expect(fill.lineWidth).toBeUndefined();
    expect(fill.polygon.bounds.minX).toBeCloseTo(5);
    expect(fill.polygon.bounds.maxX).toBeCloseTo(15);
    expect(fill.polygon.bounds.minY).toBeCloseTo(15);
    expect(fill.polygon.bounds.maxY).toBeCloseTo(25);
  });

  it('bounds and truncates a 501-point straight Region source at 500 stored points', async () => {
    const tool = registry.get('easyeda_pcb_regions');
    const polygonSource = Array.from({ length: 501 }, (_, index) => ['L', index, index * 2]).flat();
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [
        {
          primitiveId: 'region-long',
          layer: 12,
          ruleTypes: [5, 'bad', 7.2, 9],
          regionName: 'long keepout',
          lineWidth: 0.2,
          locked: true,
          polygonSource,
        },
      ],
    });

    const result = await tool?.handler(context, { projectId: 'proj-long', limit: 100, offset: 0 });
    const region = ((result?.regions ?? []) as Array<Record<string, any>>)[0];

    expect(region.ruleTypes).toEqual([5, 9]);
    expect(region.polygon).toMatchObject({
      contourCount: 1,
      pointCount: 501,
      truncated: true,
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 1000 },
    });
    expect(region.polygon.contours[0].points).toHaveLength(500);
    expect(region.polygon.contours[0].truncated).toBe(true);
  });

  it('combines valid nested contours and ignores unsupported contour sources', async () => {
    const tool = registry.get('easyeda_pcb_regions');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [
        {
          primitiveId: 'region-nested',
          ruleTypes: [],
          regionName: '',
          locked: false,
          polygonSource: [
            ['R', 0, 0, 10, 10, 0, 0],
            ['R', 20, 30, 5, 7, 0, 0],
            ['ARC', 1, 2, 3],
            'not-a-contour',
          ],
        },
      ],
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-nested',
      limit: 100,
      offset: 0,
    });
    const polygon = ((result?.regions ?? []) as Array<Record<string, any>>)[0]?.polygon;
    expect(polygon).toMatchObject({
      contourCount: 2,
      pointCount: 8,
      truncated: false,
      bounds: { minX: 0, minY: 0, maxX: 25, maxY: 37 },
    });
    expect(polygon.contours).toHaveLength(2);
  });

  it('omits polygon output for malformed or unsupported source encodings', async () => {
    const tool = registry.get('easyeda_pcb_fills');
    const sources = [
      undefined,
      [],
      ['CIRCLE', 0, 0, 0],
      ['CIRCLE', 'x', 0, 2],
      ['R', 0, 0, 10],
      ['R', 0, 0, 10, 10, 45, 0],
      ['R', 0, 0, -1, 10, 0, 0],
      ['R', 0, 0, 10, 10, 0, 2],
      ['L', 0, 0, 'ARC', 1, 1],
      ['L', 0, 0],
      ['L', 0, 0, 'L', 1, 'bad', 'L', 2, 2],
    ];
    bridgeCall.mockResolvedValue({
      total: sources.length,
      items: sources.map((polygonSource, index) => ({
        primitiveId: `fill-${index}`,
        net: 'GND',
        locked: false,
        polygonSource,
      })),
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-invalid',
      limit: 100,
      offset: 0,
    });
    expect(
      (result?.fills as Array<Record<string, unknown>>).every((item) => !('polygon' in item)),
    ).toBe(true);
  });

  it.each([
    ['easyeda_pcb_fills', 'fills', 'pcb.listFills'],
    ['easyeda_pcb_regions', 'regions', 'pcb.listRegions'],
  ] as const)('%s reports not_available on bridge error', async (toolName, listKey) => {
    const tool = registry.get(toolName);
    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

    expect(result).toEqual({
      project_id: 'proj-123',
      [listKey]: [],
      total: 0,
      not_available: true,
      error: 'Bridge not connected',
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

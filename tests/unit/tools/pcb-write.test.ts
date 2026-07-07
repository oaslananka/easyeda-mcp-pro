import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbWriteTools } from '../../../src/tools/L1_pcb_write.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('PCB Write Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerPcbWriteTools(registry, config);

    bridgeCall = vi.fn();

    context = {
      profile: 'full',
      bridge: {
        connected: true,
        call: bridgeCall,
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

  it('should register all 10 PCB write tools', () => {
    expect(registry.get('easyeda_pcb_place_component')).toBeDefined();
    expect(registry.get('easyeda_pcb_add_track')).toBeDefined();
    expect(registry.get('easyeda_pcb_add_via')).toBeDefined();
    expect(registry.get('easyeda_pcb_add_zone')).toBeDefined();
    expect(registry.get('easyeda_pcb_delete_component')).toBeDefined();
    expect(registry.get('easyeda_pcb_modify_component')).toBeDefined();
    expect(registry.get('easyeda_pcb_place_component_group')).toBeDefined();
    expect(registry.get('easyeda_pcb_route_path_plan')).toBeDefined();
    expect(registry.get('easyeda_pcb_add_text')).toBeDefined();
    expect(registry.get('easyeda_pcb_add_silkscreen_line')).toBeDefined();
  });

  it('easyeda_pcb_place_component_group should preview without bridge calls', async () => {
    const tool = registry.get('easyeda_pcb_place_component_group');

    const result = await tool?.handler(context, {
      mode: 'preview',
      board: { widthMm: 60, heightMm: 40 },
      anchor: { x: 10, y: 10 },
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 6 }],
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(result?.applied).toBe(false);
    expect(result?.operations[0].method).toBe('pcb.modifyComponent');
  });

  it('easyeda_pcb_place_component_group should block apply without confirmation', async () => {
    const tool = registry.get('easyeda_pcb_place_component_group');

    const result = await tool?.handler(context, {
      mode: 'apply',
      board: { widthMm: 60, heightMm: 40 },
      anchor: { x: 10, y: 10 },
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 6 }],
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(result?.blocked).toBe(true);
    expect(result?.error).toContain('confirmWrite');
  });

  it('easyeda_pcb_place_component_group should apply valid placement with confirmation', async () => {
    const tool = registry.get('easyeda_pcb_place_component_group');
    bridgeCall.mockResolvedValue({ result: 'ok' });

    const result = await tool?.handler(context, {
      mode: 'apply',
      confirmWrite: true,
      board: { widthMm: 60, heightMm: 40 },
      anchor: { x: 10, y: 10 },
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 6 }],
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.modifyComponent', {
      primitiveId: 'p-u1',
      property: { x: 10, y: 10, rotation: 0, layer: 1 },
    });
    expect(result?.success).toBe(true);
    expect(result?.applied).toBe(true);
  });

  it('easyeda_pcb_route_path_plan should preview without bridge calls', async () => {
    const tool = registry.get('easyeda_pcb_route_path_plan');

    const result = await tool?.handler(context, {
      mode: 'preview',
      netName: 'GND',
      layer: 1,
      widthMm: 0.4,
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(result?.path_length_mm).toBe(10);
  });

  it('easyeda_pcb_route_path_plan should block unsafe apply before bridge call', async () => {
    const tool = registry.get('easyeda_pcb_route_path_plan');

    const result = await tool?.handler(context, {
      mode: 'apply',
      confirmWrite: true,
      netName: '3V3',
      layer: 1,
      widthMm: 0.2,
      minWidthMm: 0.4,
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(result?.blocked).toBe(true);
    expect(result?.issues[0].code).toBe('LAYOUT_TRACE_WIDTH_TOO_SMALL');
  });

  it('easyeda_pcb_route_path_plan should apply valid path with confirmation', async () => {
    const tool = registry.get('easyeda_pcb_route_path_plan');
    bridgeCall.mockResolvedValue({ result: 'track-1' });

    const result = await tool?.handler(context, {
      mode: 'apply',
      confirmWrite: true,
      netName: 'GND',
      layer: 1,
      widthMm: 0.4,
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.addTrack', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      layer: 1,
      width: 0.4,
      netName: 'GND',
    });
    expect(result?.success).toBe(true);
    expect(result?.applied).toBe(true);
  });

  it('easyeda_pcb_place_component should call bridge and return success', async () => {
    const tool = registry.get('easyeda_pcb_place_component');
    bridgeCall.mockResolvedValue('comp-1234');

    const result = await tool?.handler(context, {
      footprint: 'SOIC-8',
      x: 10,
      y: 20,
      rotation: 90,
      layer: 1,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.placeComponent', {
      footprint: 'SOIC-8',
      x: 10,
      y: 20,
      rotation: 90,
      layer: 1,
    });
    expect(result).toEqual({
      success: true,
      primitiveId: 'comp-1234',
    });
  });

  it('easyeda_pcb_add_track should pass structured points and call bridge', async () => {
    const tool = registry.get('easyeda_pcb_add_track');
    bridgeCall.mockResolvedValue({ primitiveId: 'track-5678', primitiveIds: ['track-5678'] });

    const result = await tool?.handler(context, {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      layer: 1,
      width: 0.254,
      netName: 'GND',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.addTrack', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      layer: 1,
      width: 0.254,
      netName: 'GND',
    });
    expect(result).toEqual({
      success: true,
      primitiveId: 'track-5678',
      primitiveIds: ['track-5678'],
    });
  });

  it('easyeda_pcb_add_via should place a via', async () => {
    const tool = registry.get('easyeda_pcb_add_via');
    bridgeCall.mockResolvedValue('via-999');

    const result = await tool?.handler(context, {
      x: 15,
      y: 15,
      outerDiameter: 0.6,
      holeSize: 0.3,
      netName: 'VCC',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.addVia', {
      x: 15,
      y: 15,
      outerDiameter: 0.6,
      holeSize: 0.3,
      netName: 'VCC',
    });
    expect(result).toEqual({
      success: true,
      primitiveId: 'via-999',
    });
  });

  it('easyeda_pcb_add_zone should place a zone', async () => {
    const tool = registry.get('easyeda_pcb_add_zone');
    bridgeCall.mockResolvedValue('zone-111');

    const result = await tool?.handler(context, {
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      layer: 2,
      netName: 'GND',
      clearance: 0.5,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.addZone', {
      points: [0, 0, 20, 0, 20, 20, 0, 20],
      layer: 2,
      netName: 'GND',
      clearance: 0.5,
    });
    expect(result).toEqual({
      success: true,
      primitiveId: 'zone-111',
    });
  });

  it('easyeda_pcb_add_zone should report bridge errors instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_add_zone');
    bridgeCall.mockRejectedValue(new Error('not_available'));

    const result = await tool?.handler(context, {
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      layer: 2,
      confirmWrite: true,
    });

    expect(result).toEqual({ success: false, error: 'not_available' });
  });

  describe('PCB text and silkscreen write helpers', () => {
    it('adds PCB text and extracts primitive ids from string and object bridge responses', async () => {
      const textTool = registry.get('easyeda_pcb_add_text');
      const lineTool = registry.get('easyeda_pcb_add_silkscreen_line');
      bridgeCall.mockResolvedValueOnce({ result: 'text-1' }).mockResolvedValueOnce('line-1');

      const textResult = await textTool?.handler(context, {
        layer: 3,
        x: 100,
        y: 200,
        text: 'REF**',
        fontFamily: 'NotoSansMonoCJKsc-Regular',
        fontSize: 1.2,
        lineWidth: 0.15,
        alignMode: 1,
        rotation: 90,
        reverse: false,
        expansion: 0,
        mirror: false,
        locked: true,
        confirmWrite: true,
      });
      const lineResult = await lineTool?.handler(context, {
        layer: 3,
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        lineWidth: 0.2,
        confirmWrite: true,
      });

      expect(bridgeCall).toHaveBeenNthCalledWith(1, 'pcb.addText', {
        layer: 3,
        x: 100,
        y: 200,
        text: 'REF**',
        fontFamily: 'NotoSansMonoCJKsc-Regular',
        fontSize: 1.2,
        lineWidth: 0.15,
        alignMode: 1,
        rotation: 90,
        reverse: false,
        expansion: 0,
        mirror: false,
        locked: true,
      });
      expect(bridgeCall).toHaveBeenNthCalledWith(2, 'pcb.addSilkscreenLine', {
        layer: 3,
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        lineWidth: 0.2,
      });
      expect(textResult).toEqual({ success: true, primitiveId: 'text-1' });
      expect(lineResult).toEqual({ success: true, primitiveId: 'line-1' });
    });

    it('extracts PCB helper primitive ids from primitiveId object responses', async () => {
      const textTool = registry.get('easyeda_pcb_add_text');
      const lineTool = registry.get('easyeda_pcb_add_silkscreen_line');
      bridgeCall.mockResolvedValueOnce({ primitiveId: 'text-primitive' }).mockResolvedValueOnce({
        result: 'line-result',
      });

      await expect(
        textTool?.handler(context, { layer: 3, x: 1, y: 2, text: 'T', confirmWrite: true }),
      ).resolves.toEqual({ success: true, primitiveId: 'text-primitive' });
      await expect(
        lineTool?.handler(context, {
          layer: 3,
          startX: 0,
          startY: 0,
          endX: 2,
          endY: 2,
          confirmWrite: true,
        }),
      ).resolves.toEqual({ success: true, primitiveId: 'line-result' });
    });

    it('reports non-Error bridge failures from PCB text helpers', async () => {
      const tool = registry.get('easyeda_pcb_add_text');
      bridgeCall.mockRejectedValue('font missing');

      const result = await tool?.handler(context, {
        layer: 3,
        x: 1,
        y: 2,
        text: 'BAD',
        confirmWrite: true,
      });

      expect(result).toEqual({ success: false, error: 'font missing' });
    });

    it('returns undefined when a PCB helper response has no primitive id fields', async () => {
      const tool = registry.get('easyeda_pcb_add_text');
      bridgeCall.mockResolvedValue({});

      const result = await tool?.handler(context, {
        layer: 3,
        x: 1,
        y: 2,
        text: 'NOID',
        confirmWrite: true,
      });

      expect(result).toEqual({ success: true, primitiveId: undefined });
    });

    it('reports Error bridge failures from PCB silkscreen helpers', async () => {
      const tool = registry.get('easyeda_pcb_add_silkscreen_line');
      bridgeCall.mockRejectedValue(new Error('no pcb tab'));

      const result = await tool?.handler(context, {
        layer: 3,
        startX: 0,
        startY: 0,
        endX: 1,
        endY: 1,
        confirmWrite: true,
      });

      expect(result).toEqual({ success: false, error: 'no pcb tab' });
    });
  });

  it('easyeda_pcb_delete_component should call bridge delete', async () => {
    const tool = registry.get('easyeda_pcb_delete_component');
    bridgeCall.mockResolvedValue({
      success: true,
      deletedCount: 2,
      deleted: ['comp-1', 'comp-2'],
      notFound: [],
    });

    const result = await tool?.handler(context, {
      primitiveIds: ['comp-1', 'comp-2'],
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.deleteComponent', {
      primitiveIds: ['comp-1', 'comp-2'],
    });
    expect(result).toEqual({
      success: true,
      deletedCount: 2,
      deleted: ['comp-1', 'comp-2'],
      notFound: [],
    });
  });

  it('easyeda_pcb_delete_component reports notFound ids instead of claiming success', async () => {
    const tool = registry.get('easyeda_pcb_delete_component');
    bridgeCall.mockResolvedValue({
      success: false,
      deletedCount: 1,
      deleted: ['comp-1'],
      notFound: ['bogus-id'],
    });

    const result = await tool?.handler(context, {
      primitiveIds: ['comp-1', 'bogus-id'],
      confirmWrite: true,
    });

    expect(result).toEqual({
      success: false,
      deletedCount: 1,
      deleted: ['comp-1'],
      notFound: ['bogus-id'],
    });
  });

  it('easyeda_pcb_delete_component should report bridge errors instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_delete_component');
    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, {
      primitiveIds: ['comp-1'],
      confirmWrite: true,
    });

    expect(result).toEqual({ success: false, error: 'Bridge not connected' });
  });

  it('easyeda_pcb_modify_component should call bridge modify', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue(true);

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      property: { x: 50, rotation: 180 },
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.modifyComponent', {
      primitiveId: 'comp-1',
      property: { x: 50, rotation: 180 },
    });
    expect(result).toEqual({
      success: true,
    });
  });

  it('easyeda_pcb_modify_component should report bridge errors instead of throwing', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockRejectedValue(new Error('Primitive not found'));

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      property: { x: 50 },
      confirmWrite: true,
    });

    expect(result).toEqual({ success: false, error: 'Primitive not found' });
  });
});

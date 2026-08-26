import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbWriteTools } from '../../../src/tools/L1_pcb_write.js';
import { EnvSchema } from '../../../src/config/env.js';
import {
  getGlobalTransactionManager,
  resetGlobalTransactionManagerForTests,
} from '../../../src/transactions/manager.js';

describe('PCB Write Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerPcbWriteTools(registry, config);
    resetGlobalTransactionManagerForTests();

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

  it('easyeda_pcb_place_component_group rejects unverified component layers', () => {
    const tool = registry.get('easyeda_pcb_place_component_group');
    expect(
      tool?.inputSchema.safeParse({
        board: { widthMm: 100, heightMm: 80 },
        anchor: { x: 10, y: 10 },
        layer: 15,
        components: [{ ref: 'U1', widthMm: 10, heightMm: 10 }],
      }).success,
    ).toBe(false);
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

  it('easyeda_pcb_place_component fails closed without calling the unsupported bridge method', async () => {
    const tool = registry.get('easyeda_pcb_place_component');

    const result = await tool?.handler(context, {
      footprint: 'SOIC-8',
      x: 10,
      y: 20,
      rotation: 90,
      layer: 1,
      confirmWrite: true,
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      not_available: true,
    });
    expect(result?.error).toContain('not supported');
    expect(result?.remediation).toContain('easyeda_schematic_sync_to_pcb');
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

  it('easyeda_pcb_add_zone should fail closed without calling the bridge', async () => {
    const tool = registry.get('easyeda_pcb_add_zone');

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

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      not_available: true,
      error: 'PCB copper-zone creation is not supported by the verified EasyEDA Pro runtime.',
      remediation:
        'Create or edit the copper zone in EasyEDA Pro manually until the complete native zone-creation contract is live-verified.',
    });
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

  it('easyeda_pcb_modify_component rejects the legacy unrestricted property bag', () => {
    const tool = registry.get('easyeda_pcb_modify_component');

    expect(
      tool?.inputSchema.safeParse({
        primitiveId: 'comp-1',
        property: { x: 50, manufacturer: 'unsafe-side-channel' },
        mode: 'preview',
      }).success,
    ).toBe(false);
  });

  it('easyeda_pcb_modify_component rejects an empty transform request', () => {
    const tool = registry.get('easyeda_pcb_modify_component');

    expect(
      tool?.inputSchema.safeParse({
        primitiveId: 'comp-1',
        mode: 'preview',
      }).success,
    ).toBe(false);
  });

  it('easyeda_pcb_modify_component previews a typed top-to-bottom transform without mutation', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [
        {
          primitiveId: 'comp-1',
          designator: 'U1',
          x: 10,
          y: 20,
          rotation: -90,
          layer: 1,
          locked: false,
        },
      ],
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'preview',
      side: 'bottom',
      xMil: 15,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(bridgeCall).toHaveBeenCalledWith('pcb.listComponents', {});
    expect(bridgeCall).not.toHaveBeenCalledWith('pcb.modifyComponent', expect.anything());
    expect(result).toMatchObject({
      success: true,
      mode: 'preview',
      applied: false,
      no_op: false,
      mirror_supported: false,
      before: { side: 'top', layer: 1, xMil: 10, yMil: 20, rotationDeg: 270 },
      planned: { side: 'bottom', layer: 2, xMil: 15, yMil: 20, rotationDeg: 270 },
    });
    expect(tool?.outputSchema.safeParse(result).success).toBe(true);
  });

  it('easyeda_pcb_modify_component blocks apply without explicit confirmation', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [{ primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false }],
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, applied: false });
    expect(result?.error).toContain('confirmWrite=true');
  });

  it('easyeda_pcb_modify_component applies and read-back verifies a typed side transform', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = {
      primitiveId: 'comp-1',
      designator: 'U1',
      x: 10,
      y: 20,
      rotation: -90,
      layer: 1,
      locked: false,
    };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        state = {
          ...state,
          ...params.property,
          rotation: params.property.rotation ?? state.rotation,
        };
        return { primitiveId: state.primitiveId };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      rotationDeg: -90,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.modifyComponent', {
      primitiveId: 'comp-1',
      property: { layer: 2, x: 15 },
    });
    expect(result).toMatchObject({
      success: true,
      mode: 'apply',
      applied: true,
      rolled_back: false,
      transaction_state: 'committed',
      after: { side: 'bottom', layer: 2, xMil: 15, yMil: 20, rotationDeg: 270 },
    });
    const transactionId = result?.transaction_id;
    expect(transactionId).toBeTruthy();
    expect(getGlobalTransactionManager().get(transactionId!).operations[0]?.target.type).toBe(
      'pcb-primitive',
    );
  });

  it('easyeda_pcb_modify_component applies and verifies a bottom-to-top transition', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = {
      primitiveId: 'comp-1',
      designator: 'U1',
      x: 10,
      y: 20,
      rotation: 270,
      layer: 2,
      locked: false,
    };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        state = { ...state, ...params.property };
        return { primitiveId: state.primitiveId };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'top',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('pcb.modifyComponent', {
      primitiveId: 'comp-1',
      property: { layer: 1 },
    });
    expect(result).toMatchObject({
      success: true,
      applied: true,
      after: { side: 'top', layer: 1, xMil: 10, yMil: 20, rotationDeg: 270 },
      transaction_state: 'committed',
    });
  });

  it('easyeda_pcb_modify_component treats an already-matching transform as an idempotent no-op', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [{ primitiveId: 'comp-1', x: 10, y: 20, rotation: 270, layer: 2, locked: false }],
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      rotationDeg: -90,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, applied: false, no_op: true });
  });

  it('easyeda_pcb_modify_component rejects an unsupported component layer before mutation', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue({
      total: 1,
      items: [{ primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 12, locked: false }],
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, applied: false });
    expect(result?.error).toContain('complete supported transform state');
  });

  it('easyeda_pcb_modify_component fails closed when the component cannot be read back', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    bridgeCall.mockResolvedValue({ total: 0 });

    const result = await tool?.handler(context, {
      primitiveId: 'missing',
      mode: 'apply',
      side: 'bottom',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, applied: false });
    expect(result?.error).toContain('was not found');
  });

  it('easyeda_pcb_modify_component restores a partial write when the bridge throws after mutation', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = { primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false };
    let modifyCount = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        modifyCount += 1;
        state = { ...state, ...params.property };
        if (modifyCount === 1) throw new Error('connection lost after native write');
        return { primitiveId: state.primitiveId };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      confirmWrite: true,
    });

    expect(modifyCount).toBe(2);
    expect(state).toMatchObject({ layer: 1, x: 10, y: 20, rotation: 0, locked: false });
    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: true,
      transaction_state: 'rolled-back',
      restored: {
        side: 'top',
        layer: 1,
        xMil: 10,
        yMil: 20,
        rotationDeg: 0,
        locked: false,
      },
    });
    expect(result?.error).toContain('connection lost after native write');
  });

  it('easyeda_pcb_modify_component retries rollback when automatic compensation cannot be verified', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = { primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false };
    let modifyCount = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        modifyCount += 1;
        if (modifyCount === 1) {
          state = { ...state, ...params.property };
          throw new Error('connection lost after native write');
        }
        if (modifyCount === 2) throw new Error('automatic compensation unavailable');
        state = { ...state, ...params.property };
        return { primitiveId: state.primitiveId };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      confirmWrite: true,
    });

    expect(modifyCount).toBe(3);
    expect(state).toMatchObject({ layer: 1, x: 10, y: 20, rotation: 0, locked: false });
    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: true,
      transaction_state: 'rolled-back',
      restored: { side: 'top', layer: 1, xMil: 10, yMil: 20, rotationDeg: 0, locked: false },
    });
    expect(result?.error).toContain('connection lost after native write');
  });

  it('easyeda_pcb_modify_component reports fail-closed state when explicit rollback also fails', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = { primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false };
    let modifyCount = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        modifyCount += 1;
        if (modifyCount === 1) {
          state = { ...state, ...params.property };
          throw new Error('connection lost after native write');
        }
        throw new Error('rollback transport unavailable');
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      confirmWrite: true,
    });

    expect(modifyCount).toBe(3);
    expect(state).toMatchObject({ layer: 2, x: 15, y: 20, rotation: 0, locked: false });
    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: false,
      transaction_state: 'failed',
    });
    expect(result?.error).toContain('connection lost after native write');
    expect(result?.error).toContain('rollback failed');
  });

  it('easyeda_pcb_modify_component rolls back when native success cannot be proven by read-back', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    let state = { primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false };
    let modifyCount = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.listComponents') return { total: 1, items: [{ ...state }] };
      if (method === 'pcb.modifyComponent') {
        modifyCount += 1;
        if (modifyCount === 1) state = { ...state, x: params.property.x ?? state.x, layer: 1 };
        else state = { ...state, ...params.property };
        return { primitiveId: state.primitiveId };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      confirmWrite: true,
    });

    expect(modifyCount).toBe(2);
    expect(state).toMatchObject({ layer: 1, x: 10, y: 20, rotation: 0, locked: false });
    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: true,
      transaction_state: 'rolled-back',
      restored: { side: 'top', layer: 1, xMil: 10, yMil: 20, rotationDeg: 0, locked: false },
    });
    expect(result?.error).toContain('read-back');
  });
});

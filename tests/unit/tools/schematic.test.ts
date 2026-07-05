import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerSchematicReadTools } from '../../../src/tools/L1_schematic_read.js';
import { registerSchematicWriteTools } from '../../../src/tools/L1_schematic_write.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Schematic Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerSchematicReadTools(registry, config);
    registerSchematicWriteTools(registry, config);

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
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('easyeda_schematic_net_detail should call schematic.getNetDetail and return net nodes', async () => {
    const tool = registry.get('easyeda_schematic_net_detail');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      netName: 'GND',
      nodes: [
        { component: 'R1', pin: '2' },
        { component: 'C1', pin: '1' },
      ],
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'GND',
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.getNetDetail', {
      projectId: 'proj-123',
      netName: 'GND',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      net_name: 'GND',
      node_count: 2,
      nodes: [
        { component_ref: 'R1', pin: '2' },
        { component_ref: 'C1', pin: '1' },
      ],
    });
  });

  it('easyeda_schematic_net_detail should handle missing net gracefully', async () => {
    const tool = registry.get('easyeda_schematic_net_detail');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue(null);

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'UNKNOWN_NET',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      net_name: 'UNKNOWN_NET',
      node_count: 0,
      nodes: [],
      not_available: true,
    });
  });

  it('easyeda_schematic_place_component should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_place_component');
    bridgeCall.mockResolvedValue({ componentId: 'comp-123' });

    const result = await tool?.handler(context, {
      deviceItem: { libraryUuid: 'lib-uuid', uuid: 'device-uuid' },
      x: 100,
      y: 200,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.placeComponent', {
      deviceItem: { libraryUuid: 'lib-uuid', uuid: 'device-uuid' },
      x: 100,
      y: 200,
      rotation: undefined,
      mirror: undefined,
      subPartName: undefined,
      addIntoBom: undefined,
      addIntoPcb: undefined,
    });
    expect(result).toEqual({
      success: true,
      component: { componentId: 'comp-123' },
    });
  });

  it('easyeda_schematic_place_component supports dry-run collision warnings', async () => {
    const tool = registry.get('easyeda_schematic_place_component');
    bridgeCall.mockResolvedValueOnce([
      { reference: 'R1', position: { x: 105, y: 203 } },
      { reference: 'C1', position: { x: 400, y: 400 } },
    ]);

    const result = await tool?.handler(context, {
      deviceItem: { libraryUuid: 'lib-uuid', uuid: 'device-uuid' },
      x: 100,
      y: 200,
      dryRun: true,
      checkPlacementCollision: true,
      collisionRadius: 10,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(1);
    expect(bridgeCall).toHaveBeenCalledWith('schematic.listComponents', {
      projectId: 'active',
      limit: 500,
      offset: 0,
    });
    expect(result).toMatchObject({
      success: true,
      dry_run: true,
      placement_guard: {
        collision_checked: true,
        collision_radius: 10,
        nearby_components: [{ reference: 'R1' }],
      },
      verification: {
        applied: false,
        before_component_count: 2,
      },
    });
  });

  it('easyeda_schematic_place_component can verify write readback', async () => {
    const tool = registry.get('easyeda_schematic_place_component');
    bridgeCall
      .mockResolvedValueOnce([{ reference: 'R1', position: { x: 10, y: 10 } }])
      .mockResolvedValueOnce({ componentId: 'comp-123' })
      .mockResolvedValueOnce([
        { reference: 'R1', position: { x: 10, y: 10 } },
        { reference: 'R2', position: { x: 100, y: 200 } },
      ]);

    const result = await tool?.handler(context, {
      deviceItem: { libraryUuid: 'lib-uuid', uuid: 'device-uuid' },
      x: 100,
      y: 200,
      verifyAfterWrite: true,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledTimes(3);
    expect(bridgeCall).toHaveBeenNthCalledWith(2, 'schematic.placeComponent', {
      deviceItem: { libraryUuid: 'lib-uuid', uuid: 'device-uuid' },
      x: 100,
      y: 200,
      rotation: undefined,
      mirror: undefined,
      subPartName: undefined,
      addIntoBom: undefined,
      addIntoPcb: undefined,
    });
    expect(result).toMatchObject({
      success: true,
      component: { componentId: 'comp-123' },
      verification: {
        applied: true,
        before_component_count: 1,
        after_component_count: 2,
        component_count_delta: 1,
        readback_available: true,
      },
    });
  });
  it('easyeda_schematic_add_wire should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_add_wire');
    bridgeCall.mockResolvedValue({ wireId: 'wire-123' });

    const result = await tool?.handler(context, {
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
      ],
      netName: 'VCC',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.addWire', {
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
      ],
      netName: 'VCC',
      color: undefined,
      lineWidth: undefined,
      lineType: undefined,
    });
    expect(result).toEqual({
      success: true,
      wire: { wireId: 'wire-123' },
    });
  });

  it('easyeda_schematic_delete_primitive should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_delete_primitive');
    bridgeCall.mockResolvedValue(true);

    const result = await tool?.handler(context, {
      primitiveIds: ['prim-1', 'prim-2'],
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
      primitiveIds: ['prim-1', 'prim-2'],
    });
    expect(result).toEqual({
      success: true,
    });
  });

  it('easyeda_schematic_modify_primitive should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_modify_primitive');
    bridgeCall.mockResolvedValue(true);

    const result = await tool?.handler(context, {
      primitiveId: 'prim-1',
      property: { value: '10k' },
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.modifyPrimitive', {
      primitiveId: 'prim-1',
      property: { value: '10k' },
    });
    expect(result).toEqual({
      success: true,
      result: true,
    });
  });

  // ── Real schematic net creation tools ─────────────────────────────

  it('easyeda_schematic_create_net_flag should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_create_net_flag');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(true);

    bridgeCall.mockResolvedValue({
      primitiveId: 'netflag-1',
      netName: 'TEST_NET',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'TEST_NET',
      x: 100,
      y: 200,
      rotation: 0,
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.createNetFlag', {
      projectId: 'proj-123',
      netName: 'TEST_NET',
      x: 100,
      y: 200,
      rotation: 0,
      identification: undefined,
    });
    expect(result).toEqual({
      success: true,
      netFlag: {
        primitiveId: 'netflag-1',
        netName: 'TEST_NET',
      },
    });
  });

  it('easyeda_schematic_create_net_flag should forward power-flag identification', async () => {
    const tool = registry.get('easyeda_schematic_create_net_flag');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({ primitiveId: 'netflag-2', netName: 'VCC' });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'VCC',
      x: 0,
      y: 0,
      identification: 'Power',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.createNetFlag', {
      projectId: 'proj-123',
      netName: 'VCC',
      x: 0,
      y: 0,
      rotation: undefined,
      identification: 'Power',
    });
    expect(result).toEqual({
      success: true,
      netFlag: { primitiveId: 'netflag-2', netName: 'VCC' },
    });
  });

  it('easyeda_schematic_create_net_flag should handle bridge error', async () => {
    const tool = registry.get('easyeda_schematic_create_net_flag');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge timeout'));

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'TEST_NET',
      x: 100,
      y: 200,
      confirmWrite: true,
    });

    expect(result).toEqual({
      success: false,
      error: 'Bridge timeout',
    });
  });

  it('easyeda_schematic_create_net_port should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_create_net_port');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(true);

    bridgeCall.mockResolvedValue({
      primitiveId: 'netport-1',
      netName: 'DATA_BUS',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'DATA_BUS',
      x: 300,
      y: 400,
      portType: 'bidirectional',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.createNetPort', {
      projectId: 'proj-123',
      netName: 'DATA_BUS',
      x: 300,
      y: 400,
      portType: 'bidirectional',
      rotation: undefined,
    });
    expect(result).toEqual({
      success: true,
      netPort: {
        primitiveId: 'netport-1',
        netName: 'DATA_BUS',
      },
    });
  });

  it('easyeda_schematic_connect_pin_to_net should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_connect_pin_to_net');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(true);

    bridgeCall.mockResolvedValue({ connected: true });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      primitiveId: 'comp-1',
      pinNumber: '1',
      netName: 'VCC',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.connectPinToNet', {
      projectId: 'proj-123',
      primitiveId: 'comp-1',
      pinNumber: '1',
      netName: 'VCC',
    });
    expect(result).toEqual({
      success: true,
      connection: {
        primitiveId: 'comp-1',
        pinNumber: '1',
        netName: 'VCC',
      },
    });
  });

  it('easyeda_schematic_connect_pin_to_net should handle bridge error', async () => {
    const tool = registry.get('easyeda_schematic_connect_pin_to_net');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Invalid primitiveId'));

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      primitiveId: 'invalid-comp',
      pinNumber: '99',
      netName: 'VCC',
      confirmWrite: true,
    });

    expect(result).toEqual({
      success: false,
      error: 'Invalid primitiveId',
    });
  });

  it('easyeda_schematic_connect_pins_by_net should call bridge and return success', async () => {
    const tool = registry.get('easyeda_schematic_connect_pins_by_net');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(true);

    bridgeCall.mockResolvedValue({ count: 3 });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'DATA_BUS',
      pins: [
        { primitiveId: 'comp-1', pinNumber: '1' },
        { primitiveId: 'comp-2', pinNumber: '3' },
        { primitiveId: 'comp-3', pinNumber: '5' },
      ],
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.connectPinsByNet', {
      projectId: 'proj-123',
      netName: 'DATA_BUS',
      pins: [
        { primitiveId: 'comp-1', pinNumber: '1' },
        { primitiveId: 'comp-2', pinNumber: '3' },
        { primitiveId: 'comp-3', pinNumber: '5' },
      ],
    });
    expect(result).toMatchObject({
      success: true,
      count: 3,
      connections: [
        { primitiveId: 'comp-1', pinNumber: '1', netName: 'DATA_BUS' },
        { primitiveId: 'comp-2', pinNumber: '3', netName: 'DATA_BUS' },
        { primitiveId: 'comp-3', pinNumber: '5', netName: 'DATA_BUS' },
      ],
    });
  });

  it('easyeda_schematic_validate_netlist should call bridge and return netlist data', async () => {
    const tool = registry.get('easyeda_schematic_validate_netlist');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(false);

    bridgeCall.mockResolvedValue({
      nets: [
        { netName: 'VCC', refs: ['R1', 'C1'], pins: ['1', '2'], hasNetFlag: true },
        { netName: 'GND', refs: ['C1'], pins: ['2'], hasNetFlag: true },
      ],
      floatingPins: [{ primitiveId: 'comp-4', pinNumber: '3' }],
      warnings: [],
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      includeWireCheck: false,
    });

    expect(bridgeCall).toHaveBeenCalledWith('schematic.validateNetlist', {
      projectId: 'proj-123',
      includeWireCheck: false,
    });
    expect(result).toMatchObject({
      project_id: 'proj-123',
      total_nets: 2,
      valid: true,
      warnings: [],
      floating_pins: [{ primitiveId: 'comp-4', pinNumber: '3' }],
    });
    expect(result?.netlist).toHaveLength(2);
    expect(result?.netlist[0]).toMatchObject({
      net_name: 'VCC',
      connected_refs: ['R1', 'C1'],
      connected_pins: ['1', '2'],
      has_net_flag: true,
    });
  });

  it('easyeda_schematic_validate_netlist should handle bridge error', async () => {
    const tool = registry.get('easyeda_schematic_validate_netlist');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge not connected'));

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      includeWireCheck: false,
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      valid: false,
      not_available: true,
      total_nets: 0,
      floating_pins: [],
      warnings: [],
    });
    expect(result?.error).toBeDefined();
  });

  it('easyeda_project_save should call bridge and return success', async () => {
    const tool = registry.get('easyeda_project_save');
    expect(tool).toBeDefined();
    expect(tool?.confirmWrite).toBe(true);

    const fakeDate = '2026-06-12T01:00:00.000Z';
    bridgeCall.mockResolvedValue({ savedAt: fakeDate });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      confirmWrite: true,
    });

    expect(bridgeCall).toHaveBeenCalledWith('project.save', {
      projectId: 'proj-123',
    });
    expect(result).toMatchObject({
      success: true,
      project_id: 'proj-123',
      saved_at: fakeDate,
    });
  });

  it('easyeda_project_save should handle bridge error', async () => {
    const tool = registry.get('easyeda_project_save');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Save failed: permission denied'));

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      project_id: 'proj-123',
    });
    expect(result?.error).toContain('permission denied');
  });

  describe('easyeda_schematic_nets', () => {
    it('lists nets with node connections', async () => {
      const tool = registry.get('easyeda_schematic_nets');
      expect(tool).toBeDefined();
      bridgeCall.mockResolvedValue([{ netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] }]);

      const result = await tool?.handler(context, { projectId: 'proj-123' });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.listNets', { projectId: 'proj-123' });
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 1,
        nets: [{ net_name: 'GND', node_count: 1, nodes: [{ component_ref: 'R1', pin: '2' }] }],
      });
    });

    it('returns not_available on bridge error', async () => {
      const tool = registry.get('easyeda_schematic_nets');
      bridgeCall.mockRejectedValue(new Error('bridge down'));

      const result = await tool?.handler(context, { projectId: 'proj-123' });

      expect(result).toMatchObject({
        project_id: 'proj-123',
        nets: [],
        total: 0,
        not_available: true,
      });
      expect(result?.error).toBe('bridge down');
    });
  });

  describe('easyeda_schematic_components', () => {
    it('lists components with defaults for missing fields', async () => {
      const tool = registry.get('easyeda_schematic_components');
      expect(tool).toBeDefined();
      bridgeCall.mockResolvedValue([{ reference: 'R1', value: '10k' }]);

      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        limit: 100,
        offset: 0,
      });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.listComponents', {
        projectId: 'proj-123',
        limit: 100,
        offset: 0,
      });
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 1,
        components: [{ reference: 'R1', value: '10k', footprint: '' }],
      });
    });

    it('returns not_available on bridge error', async () => {
      const tool = registry.get('easyeda_schematic_components');
      bridgeCall.mockRejectedValue(new Error('bridge down'));

      const result = await tool?.handler(context, { projectId: 'proj-123', limit: 100, offset: 0 });

      expect(result).toMatchObject({
        project_id: 'proj-123',
        components: [],
        total: 0,
        not_available: true,
      });
    });
  });

  describe('easyeda_schematic_search_device', () => {
    it('returns devices found by the bridge', async () => {
      const tool = registry.get('easyeda_schematic_search_device');
      expect(tool).toBeDefined();
      bridgeCall.mockResolvedValue([{ libraryUuid: 'lib-1', uuid: 'dev-1' }]);

      const result = await tool?.handler(context, { key: 'resistor' });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.searchDevice', {
        key: 'resistor',
        libraryUuid: undefined,
        classification: undefined,
        symbolType: undefined,
        itemsOfPage: 20,
        page: 1,
      });
      expect(result).toEqual({
        devices: [{ libraryUuid: 'lib-1', uuid: 'dev-1' }],
        total: 1,
        provider_tier: 'local_library',
      });
    });

    it('treats a non-array bridge response as no results', async () => {
      const tool = registry.get('easyeda_schematic_search_device');
      bridgeCall.mockResolvedValue(null);

      const result = await tool?.handler(context, { key: 'resistor' });

      expect(result).toEqual({ devices: [], total: 0, provider_tier: 'local_library' });
    });

    it('returns not_available on bridge error', async () => {
      const tool = registry.get('easyeda_schematic_search_device');
      bridgeCall.mockRejectedValue(new Error('search timeout'));

      const result = await tool?.handler(context, { key: 'resistor' });

      expect(result).toMatchObject({
        devices: [],
        total: 0,
        not_available: true,
        error: 'search timeout',
      });
    });
  });

  it('easyeda_schematic_verify_write returns component delta and netlist readback', async () => {
    const tool = registry.get('easyeda_schematic_verify_write');
    bridgeCall
      .mockResolvedValueOnce([{ reference: 'R1' }, { reference: 'R2' }, { reference: 'C1' }])
      .mockResolvedValueOnce({ valid: true, nets: [{ netName: 'OUT' }] });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'OUT',
      beforeComponentCount: 2,
      expectedComponentCountDelta: 1,
      includeWireCheck: true,
    });

    expect(bridgeCall).toHaveBeenNthCalledWith(1, 'schematic.listComponents', {
      projectId: 'proj-123',
      limit: 500,
      offset: 0,
    });
    expect(bridgeCall).toHaveBeenNthCalledWith(2, 'schematic.validateNetlist', {
      projectId: 'proj-123',
      netName: 'OUT',
      includeWireCheck: true,
    });
    expect(result).toEqual({
      project_id: 'proj-123',
      net_name: 'OUT',
      components_available: true,
      component_count: 3,
      component_count_delta: 1,
      component_delta_matches: true,
      netlist_available: true,
      netlist_validation: { valid: true, nets: [{ netName: 'OUT' }] },
      warnings: [],
    });
  });

  it('easyeda_schematic_verify_write reports unavailable readbacks as warnings', async () => {
    const tool = registry.get('easyeda_schematic_verify_write');
    bridgeCall
      .mockRejectedValueOnce(new Error('components unavailable'))
      .mockRejectedValueOnce(new Error('netlist unavailable'));

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      beforeComponentCount: 2,
      expectedComponentCountDelta: 1,
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      components_available: false,
      netlist_available: false,
    });
    expect((result as { warnings: string[] }).warnings).toEqual([
      'Component read-back unavailable: components unavailable',
      'Netlist validation unavailable: netlist unavailable',
    ]);
  });
  describe('easyeda_schematic_component_pins', () => {
    it('parses pin data from a direct field response', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      expect(tool).toBeDefined();
      bridgeCall.mockResolvedValue({
        result: [{ pinNumber: '1', pinName: 'VCC', x: 10, y: 20, rotation: 0, pinLength: 5 }],
      });

      const result = await tool?.handler(context, { primitiveId: 'comp-1' });

      expect(bridgeCall).toHaveBeenCalledWith('api.call', {
        path: 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
        args: ['comp-1'],
      });
      expect(result).toMatchObject({
        primitiveId: 'comp-1',
        success: true,
        pins: [{ pinNumber: '1', pinName: 'VCC', x: 10, y: 20, rotation: 0, pinLength: 5 }],
      });
    });

    it('falls back to the nested state object when direct fields are absent', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      bridgeCall.mockResolvedValue({
        result: [
          { state: { PinNumber: '2', PinName: 'GND', X: 1, Y: 2, Rotation: 90, PinLength: 3 } },
        ],
      });

      const result = await tool?.handler(context, { primitiveId: 'comp-2' });

      expect(result?.pins).toEqual([
        { pinNumber: '2', pinName: 'GND', x: 1, y: 2, rotation: 90, pinLength: 3 },
      ]);
    });

    it('returns an empty pin list when the bridge result has no pins', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      bridgeCall.mockResolvedValue(undefined);

      const result = await tool?.handler(context, { primitiveId: 'comp-3' });

      expect(result).toMatchObject({ primitiveId: 'comp-3', pins: [], success: true });
    });

    it('returns success=false on bridge error', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      bridgeCall.mockRejectedValue(new Error('not found'));

      const result = await tool?.handler(context, { primitiveId: 'missing' });

      expect(result).toMatchObject({
        primitiveId: 'missing',
        pins: [],
        success: false,
        error: 'not found',
      });
    });
  });
});

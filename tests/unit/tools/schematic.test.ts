import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerSchematicReadTools } from '../../../src/tools/L1_schematic_read.js';
import { registerSchematicWriteTools } from '../../../src/tools/L1_schematic_write.js';
import { EnvSchema } from '../../../src/config/env.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/index.js';

describe('Schematic Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
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

    expect(bridgeCall).toHaveBeenCalledWith(
      'schematic.getNetDetail',
      { projectId: 'proj-123', netName: 'GND', operationTimeoutMs: 15_000 },
      { timeoutMs: 20_000 },
    );

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

  it('easyeda_schematic_net_detail applies a bounded bridge deadline and returns timeout diagnostics', async () => {
    const tool = registry.get('easyeda_schematic_net_detail');
    const timeoutError = Object.assign(
      new Error('Net detail timed out during component pin read'),
      {
        code: 'NET_DETAIL_TIMEOUT',
        data: { stage: 'component_pin_read', component: 'U1', netName: 'VBUS' },
      },
    );
    bridgeCall.mockRejectedValue(timeoutError);

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      netName: 'VBUS',
    });

    expect(bridgeCall).toHaveBeenCalledWith(
      'schematic.getNetDetail',
      { projectId: 'proj-123', netName: 'VBUS', operationTimeoutMs: 15_000 },
      { timeoutMs: 20_000 },
    );
    expect(result).toMatchObject({
      project_id: 'proj-123',
      net_name: 'VBUS',
      node_count: 0,
      nodes: [],
      not_available: true,
      timed_out: true,
      error_code: 'NET_DETAIL_TIMEOUT',
      timeout_stage: 'component_pin_read',
      timeout_component: 'U1',
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

  it('easyeda_schematic_sheet_info reports focused page identity without inventing geometry', async () => {
    const tool = registry.get('easyeda_schematic_sheet_info');
    bridgeCall.mockResolvedValue({
      currentPage: {
        uuid: 'page-1',
        name: 'Sheet 1',
        parentSchematicUuid: 'sch-1',
        showTitleBlock: true,
      },
      pages: [{ uuid: 'page-1', name: 'Sheet 1' }],
      source: 'focused_document',
      focusedDocument: { uuid: 'page-1', tabId: 'tab-1' },
      diagnostics: { currentPageAvailable: true, pageListAvailable: true },
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      sheet: { uuid: 'page-1', name: 'Sheet 1' },
      metadata_source: 'focused_document',
      geometry_available: false,
      warning:
        'Focused schematic page identity is available, but this EasyEDA runtime did not expose page geometry.',
    });
    expect(result).not.toHaveProperty('page_size');
    expect(result).not.toHaveProperty('not_available');
  });

  it('easyeda_schematic_sheet_info rejects empty metadata as unavailable', async () => {
    const tool = registry.get('easyeda_schematic_sheet_info');
    bridgeCall.mockResolvedValue({
      currentPage: null,
      pages: [],
      diagnostics: { currentPageAvailable: false, pageListAvailable: false },
    });

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      not_available: true,
      geometry_available: false,
      error: 'EasyEDA did not expose metadata for the focused schematic page.',
    });
    expect(result).not.toHaveProperty('sheet');
    expect(result).not.toHaveProperty('page_size');
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

  it('easyeda_schematic_modify_primitive records a snapshot-backed transaction operation', async () => {
    const tool = registry.get('easyeda_schematic_modify_primitive');
    const manager = resetGlobalTransactionManagerForTests();
    const transaction = manager.begin({ documentId: 'proj-1' });
    let snapshotRead = 0;
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        snapshotRead += 1;
        return {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'prim-1',
          primitiveKind: 'component',
          property: { value: snapshotRead === 1 ? '1k' : '10k' },
        };
      }
      if (method === 'schematic.modifyPrimitive') return { result: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-1',
      transactionId: transaction.id,
      primitiveId: 'prim-1',
      property: { value: '10k' },
      confirmWrite: true,
    });

    expect(bridgeCall.mock.calls.map((call: any[]) => call[0])).toEqual([
      'schematic.getPrimitiveSnapshot',
      'schematic.modifyPrimitive',
      'schematic.getPrimitiveSnapshot',
    ]);
    expect(result).toMatchObject({
      success: true,
      transaction: {
        id: transaction.id,
        operation_state: 'applied',
        before_hash: expect.any(String),
        after_hash: expect.any(String),
      },
    });
    expect(manager.get(transaction.id).operations).toHaveLength(1);
  });

  it('easyeda_schematic_modify_primitive compensates when post-write snapshot read fails', async () => {
    const tool = registry.get('easyeda_schematic_modify_primitive');
    const manager = resetGlobalTransactionManagerForTests();
    const transaction = manager.begin({ documentId: 'proj-1' });
    const before = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'prim-1',
      primitiveKind: 'component',
      property: { value: '1k' },
    };
    let current = structuredClone(before);
    let snapshotCalls = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        snapshotCalls += 1;
        if (snapshotCalls === 2) throw new Error('post-write read failed');
        return structuredClone(current);
      }
      if (method === 'schematic.modifyPrimitive') {
        current = { ...before, property: { value: '10k' } };
        return true;
      }
      if (method === 'schematic.restorePrimitiveSnapshot') {
        current = structuredClone(params.snapshot);
        return { restored: true, snapshot: current };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-1',
      transactionId: transaction.id,
      primitiveId: 'prim-1',
      property: { value: '10k' },
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'restored' },
    });
    expect(current).toEqual(before);
    expect(bridgeCall).toHaveBeenCalledWith('schematic.restorePrimitiveSnapshot', {
      snapshot: before,
    });
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [expect.objectContaining({ state: 'cancelled', compensation: 'restored' })],
    });
  });

  it('easyeda_schematic_modify_primitive rejects a transaction bound to another project', async () => {
    const tool = registry.get('easyeda_schematic_modify_primitive');
    const manager = resetGlobalTransactionManagerForTests();
    const transaction = manager.begin({ documentId: 'proj-A' });

    const result = await tool?.handler(context, {
      projectId: 'proj-B',
      transactionId: transaction.id,
      primitiveId: 'prim-1',
      property: { value: '10k' },
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_INVALID_STATE',
    });
    expect(bridgeCall).not.toHaveBeenCalled();
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

  describe('schematic cosmetic and title-block write tools', () => {
    it('rejects schematic text alignment outside the documented 1..9 enum', async () => {
      const textTool = registry.get('easyeda_schematic_add_text');

      await expect(
        textTool?.handler(context, {
          x: 10,
          y: 20,
          content: 'INVALID ALIGN',
          alignMode: 0,
          confirmWrite: true,
        }),
      ).rejects.toThrow();
      expect(bridgeCall).not.toHaveBeenCalled();
    });

    it('writes schematic text, rectangles, circles, and polygons through the bridge', async () => {
      bridgeCall
        .mockResolvedValueOnce({ primitiveId: 'txt-1' })
        .mockResolvedValueOnce({ primitiveId: 'rect-1' })
        .mockResolvedValueOnce({ primitiveId: 'circle-1' })
        .mockResolvedValueOnce({ primitiveId: 'poly-1' });

      const textTool = registry.get('easyeda_schematic_add_text');
      const rectTool = registry.get('easyeda_schematic_add_rectangle');
      const circleTool = registry.get('easyeda_schematic_add_circle');
      const polyTool = registry.get('easyeda_schematic_add_polygon');

      await expect(
        textTool?.handler(context, {
          x: 10,
          y: 20,
          content: 'POWER',
          color: '#FF0000',
          fontName: 'Arial',
          fontSize: 16,
          bold: true,
          italic: false,
          underline: true,
          alignMode: 1,
          confirmWrite: true,
        }),
      ).resolves.toEqual({ success: true, text: { primitiveId: 'txt-1' } });

      await expect(
        rectTool?.handler(context, {
          x: 1,
          y: 2,
          width: 30,
          height: 40,
          cornerRadius: 2,
          rotation: 0,
          color: '#00FF00',
          fillColor: 'none',
          lineWidth: 2,
          lineType: 1,
          fillStyle: 'none',
          confirmWrite: true,
        }),
      ).resolves.toEqual({ success: true, rectangle: { primitiveId: 'rect-1' } });

      await expect(
        circleTool?.handler(context, {
          centerX: 50,
          centerY: 60,
          radius: 7,
          color: '#0000FF',
          fillColor: 'none',
          lineWidth: 1,
          lineType: 0,
          fillStyle: 'none',
          confirmWrite: true,
        }),
      ).resolves.toEqual({ success: true, circle: { primitiveId: 'circle-1' } });

      await expect(
        polyTool?.handler(context, {
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 0, y: 10 },
          ],
          color: '#123456',
          fillColor: 'none',
          lineWidth: 1,
          lineType: 0,
          confirmWrite: true,
        }),
      ).resolves.toEqual({ success: true, polygon: { primitiveId: 'poly-1' } });

      expect(bridgeCall).toHaveBeenNthCalledWith(1, 'schematic.addText', {
        x: 10,
        y: 20,
        content: 'POWER',
        rotation: undefined,
        color: '#FF0000',
        fontName: 'Arial',
        fontSize: 16,
        bold: true,
        italic: false,
        underline: true,
        alignMode: 1,
      });
      expect(bridgeCall).toHaveBeenNthCalledWith(2, 'schematic.addRectangle', {
        x: 1,
        y: 2,
        width: 30,
        height: 40,
        cornerRadius: 2,
        rotation: 0,
        color: '#00FF00',
        fillColor: 'none',
        lineWidth: 2,
        lineType: 1,
        fillStyle: 'none',
      });
      expect(bridgeCall).toHaveBeenNthCalledWith(3, 'schematic.addCircle', {
        centerX: 50,
        centerY: 60,
        radius: 7,
        color: '#0000FF',
        fillColor: 'none',
        lineWidth: 1,
        lineType: 0,
        fillStyle: 'none',
      });
      expect(bridgeCall).toHaveBeenNthCalledWith(4, 'schematic.addPolygon', {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
        color: '#123456',
        fillColor: 'none',
        lineWidth: 1,
        lineType: 0,
      });
    });

    it('reports non-Error bridge failures from schematic cosmetic tools', async () => {
      const tool = registry.get('easyeda_schematic_add_text');
      bridgeCall.mockRejectedValue('native refused text');

      const result = await tool?.handler(context, {
        x: 1,
        y: 2,
        content: 'NOTE',
        confirmWrite: true,
      });

      expect(result).toEqual({ success: false, error: 'native refused text' });
    });

    it('updates title block fields and defaults missing success to false', async () => {
      const tool = registry.get('easyeda_schematic_set_title_block');
      bridgeCall.mockResolvedValue({});

      const result = await tool?.handler(context, {
        fields: { Company: { value: 'ACME', showValue: true } },
        showTitleBlock: true,
        confirmWrite: true,
      });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.setTitleBlock', {
        fields: { Company: { value: 'ACME', showValue: true } },
        showTitleBlock: true,
      });
      expect(result).toEqual({ success: false });
    });

    it('returns title block success when the bridge confirms the write', async () => {
      const tool = registry.get('easyeda_schematic_set_title_block');
      bridgeCall.mockResolvedValue({ success: true });

      const result = await tool?.handler(context, {
        fields: { Drawn: { value: 'Agent' } },
        confirmWrite: true,
      });

      expect(result).toEqual({ success: true });
    });

    it('reports title block bridge errors', async () => {
      const tool = registry.get('easyeda_schematic_set_title_block');
      bridgeCall.mockRejectedValue(new Error('unsafe title field'));

      const result = await tool?.handler(context, {
        fields: { Version: { value: '0.22.0' } },
        confirmWrite: true,
      });

      expect(result).toEqual({ success: false, error: 'unsafe title field' });
    });
  });

  describe('easyeda_schematic_sync_to_pcb', () => {
    it('calls schematic.syncToPcb and reports success', async () => {
      const tool = registry.get('easyeda_schematic_sync_to_pcb');
      expect(tool).toBeDefined();
      expect(tool?.confirmWrite).toBe(true);

      bridgeCall.mockResolvedValue({ synced: true });

      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        confirmWrite: true,
      });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.syncToPcb', { projectId: 'proj-123' });
      expect(result).toMatchObject({ success: true, requested: true });
      expect(result?.note).toContain('confirmation dialog');
    });

    it('defaults sync requested to true when the bridge omits synced', async () => {
      const tool = registry.get('easyeda_schematic_sync_to_pcb');
      bridgeCall.mockResolvedValue({});

      const result = await tool?.handler(context, { confirmWrite: true });

      expect(result).toMatchObject({ success: true, requested: true });
    });

    it('preserves a false sync request result from the bridge', async () => {
      const tool = registry.get('easyeda_schematic_sync_to_pcb');
      bridgeCall.mockResolvedValue({ synced: false });

      const result = await tool?.handler(context, { projectId: 'proj-123', confirmWrite: true });

      expect(result).toMatchObject({ success: true, requested: false });
    });

    it('reports failure when the schematic tab is not focused', async () => {
      const tool = registry.get('easyeda_schematic_sync_to_pcb');

      bridgeCall.mockRejectedValue(
        Object.assign(new Error('schematic.syncToPcb requires the schematic tab to be focused.'), {
          code: 'SCHEMATIC_NOT_FOCUSED',
        }),
      );

      const result = await tool?.handler(context, { confirmWrite: true });

      expect(result).toMatchObject({ success: false });
      expect(result?.error).toContain('requires the schematic tab');
    });
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
        nets: [
          {
            net_name: 'GND',
            raw_net_name: 'GND',
            canonical_net_name: 'GND',
            net_kind: 'ground',
            normalization_rules: [],
            imported_alias: false,
            node_count: 1,
            nodes: [{ component_ref: 'R1', pin: '2' }],
          },
        ],
        read_consistency: { stable: true, attempts: 2 },
      });
    });

    it('waits for net readback to settle before returning', async () => {
      const tool = registry.get('easyeda_schematic_nets');
      bridgeCall
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] }])
        .mockResolvedValueOnce([{ netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] }]);

      const result = await tool?.handler(context, { projectId: 'proj-123' });

      expect(bridgeCall).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 1,
        read_consistency: { stable: true, attempts: 3 },
      });
    });

    it('exposes canonical imported power names without hiding the raw name', async () => {
      const tool = registry.get('easyeda_schematic_nets');
      bridgeCall.mockResolvedValue([
        { netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U1', pin: '1' }] },
      ]);

      const result = await tool?.handler(context, { projectId: 'proj-imported' });

      expect(result?.nets).toEqual([
        expect.objectContaining({
          net_name: 'SYMBOLS_+3V3',
          raw_net_name: 'SYMBOLS_+3V3',
          canonical_net_name: '+3V3',
          net_kind: 'power',
          imported_alias: true,
          normalization_rules: ['strip-imported-symbols-power-prefix'],
        }),
      ]);
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
      bridgeCall.mockResolvedValue({ total: 1, items: [{ reference: 'R1', value: '10k' }] });

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
        read_consistency: { stable: true, attempts: 2 },
      });
    });

    it('waits for component readback to settle before returning', async () => {
      const tool = registry.get('easyeda_schematic_components');
      bridgeCall
        .mockResolvedValueOnce({ total: 0, items: [] })
        .mockResolvedValueOnce({ total: 1, items: [{ reference: 'R1', value: '10k' }] })
        .mockResolvedValueOnce({ total: 1, items: [{ reference: 'R1', value: '10k' }] });

      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        limit: 100,
        offset: 0,
      });

      expect(bridgeCall).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 1,
        components: [{ reference: 'R1', value: '10k', footprint: '' }],
        read_consistency: { stable: true, attempts: 3 },
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

  describe('easyeda_schematic_wires', () => {
    it('lists wires with read consistency metadata', async () => {
      const tool = registry.get('easyeda_schematic_wires');
      expect(tool).toBeDefined();
      bridgeCall.mockResolvedValue({
        total: 1,
        samples: [{ primitiveId: 'wire-1', line: [0, 0, 10, 0], net: 'GND', lineWidth: 1 }],
      });

      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        limit: 50,
        offset: 0,
      });

      expect(bridgeCall).toHaveBeenCalledWith('system.inspectWires', { limit: 50, offset: 0 });
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 1,
        wires: [{ primitiveId: 'wire-1', line: [0, 0, 10, 0], net: 'GND', lineWidth: 1 }],
        read_consistency: { stable: true, attempts: 2 },
      });
    });

    it('reports unstable wire readback after the bounded retry window', async () => {
      const tool = registry.get('easyeda_schematic_wires');
      bridgeCall
        .mockResolvedValueOnce({ total: 0, samples: [] })
        .mockResolvedValueOnce({ total: 1, samples: [{ primitiveId: 'wire-1' }] })
        .mockResolvedValueOnce({
          total: 2,
          samples: [{ primitiveId: 'wire-1' }, { primitiveId: 'wire-2' }],
        })
        .mockResolvedValueOnce({
          total: 3,
          samples: [
            { primitiveId: 'wire-1' },
            { primitiveId: 'wire-2' },
            { primitiveId: 'wire-3' },
          ],
        });

      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        limit: 50,
        offset: 0,
      });

      expect(bridgeCall).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({
        project_id: 'proj-123',
        total: 3,
        read_consistency: { stable: false, attempts: 4 },
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

    it('minimal:true strips full library metadata down to uuid/libraryUuid/name/pin_count/symbol_type', async () => {
      const tool = registry.get('easyeda_schematic_search_device');
      bridgeCall.mockResolvedValue([
        {
          libraryUuid: 'lib-1',
          uuid: 'dev-1',
          name: 'USB2.0-TYPE-C-16P',
          jlcpcbPartClass: 'Connectors',
          description: 'A very long vendor description nobody asked for',
          pins: [{ pinNumber: '1' }, { pinNumber: '2' }],
        },
      ]);

      const result = (await tool?.handler(context, { key: 'usb-c', minimal: true })) as any;

      expect(result.devices).toEqual([
        { uuid: 'dev-1', libraryUuid: 'lib-1', name: 'USB2.0-TYPE-C-16P', pin_count: 2 },
      ]);
    });

    it('omits minimal fields that are absent rather than emitting them as undefined', async () => {
      const tool = registry.get('easyeda_schematic_search_device');
      bridgeCall.mockResolvedValue([{ libraryUuid: 'lib-1', uuid: 'dev-1' }]);

      const result = (await tool?.handler(context, { key: 'resistor', minimal: true })) as any;

      expect(result.devices).toEqual([{ uuid: 'dev-1', libraryUuid: 'lib-1' }]);
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

    it('exposes native pinType when the bridge reports one', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      bridgeCall.mockResolvedValue({
        result: [
          {
            pinNumber: '1',
            pinName: 'VCC',
            x: 10,
            y: 20,
            rotation: 0,
            pinLength: 5,
            pinType: 'IN',
          },
        ],
      });

      const result = await tool?.handler(context, { primitiveId: 'comp-1' });

      expect(result?.pins[0]).toMatchObject({ pinNumber: '1', pinType: 'IN' });
    });

    it('exposes native pin primitive ID and no-connect state', async () => {
      const tool = registry.get('easyeda_schematic_component_pins');
      bridgeCall.mockResolvedValue({
        result: [
          {
            primitiveId: 'pin-1',
            pinNumber: '1',
            pinName: 'NC',
            x: 10,
            y: 20,
            rotation: 0,
            pinLength: 5,
            noConnected: true,
          },
          {
            state: {
              PrimitiveId: 'pin-2',
              PinNumber: '2',
              PinName: 'IO',
              X: 30,
              Y: 40,
              Rotation: 90,
              PinLength: 6,
              NoConnected: false,
            },
          },
        ],
      });

      const result = await tool?.handler(context, { primitiveId: 'comp-1' });

      expect(result?.pins).toEqual([
        expect.objectContaining({ primitiveId: 'pin-1', pinNumber: '1', noConnected: true }),
        expect.objectContaining({ primitiveId: 'pin-2', pinNumber: '2', noConnected: false }),
      ]);
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

  describe('easyeda_schematic_check_collisions', () => {
    function mockPinsByComponent(
      pinsByPrimitiveId: Record<string, Array<Record<string, unknown>>>,
    ) {
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'schematic.listComponents') {
          const ids = Object.keys(pinsByPrimitiveId);
          return { total: ids.length, items: ids.map((primitiveId) => ({ primitiveId })) };
        }
        if (
          method === 'api.call' &&
          params?.path === 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId'
        ) {
          const primitiveId = params.args?.[0];
          return { result: pinsByPrimitiveId[primitiveId] ?? [] };
        }
        return {};
      });
    }

    it('reports a collision when two different components share a pin coordinate', async () => {
      const tool = registry.get('easyeda_schematic_check_collisions');
      mockPinsByComponent({
        A: [{ pinNumber: '1', pinName: 'VCC', x: 10, y: 10 }],
        B: [{ pinNumber: '2', pinName: 'GND', x: 10, y: 10 }],
        C: [{ pinNumber: '1', pinName: 'OUT', x: 50, y: 50 }],
      });

      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;

      expect(result.success).toBe(true);
      expect(result.collision_count).toBe(1);
      expect(result.collisions[0]).toMatchObject({ x: 10, y: 10 });
      const primitiveIds = result.collisions[0].pins.map((p: any) => p.primitiveId).sort();
      expect(primitiveIds).toEqual(['A', 'B']);
    });

    it('reports no collisions when every pin coordinate is unique', async () => {
      const tool = registry.get('easyeda_schematic_check_collisions');
      mockPinsByComponent({
        A: [{ pinNumber: '1', pinName: 'VCC', x: 10, y: 10 }],
        B: [{ pinNumber: '2', pinName: 'GND', x: 20, y: 20 }],
      });

      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;

      expect(result.success).toBe(true);
      expect(result.collision_count).toBe(0);
      expect(result.collisions).toEqual([]);
    });

    it('returns partial collisions and actionable diagnostics when one pin lookup times out', async () => {
      const tool = registry.get('easyeda_schematic_check_collisions');
      bridgeCall.mockImplementation(
        async (method: string, params: any, opts?: { timeoutMs?: number }) => {
          if (method === 'schematic.listComponents') {
            return {
              total: 3,
              items: [{ primitiveId: 'A' }, { primitiveId: 'B' }, { primitiveId: 'C' }],
            };
          }
          if (method === 'api.call') {
            expect(opts?.timeoutMs).toBeGreaterThan(0);
            const primitiveId = params.args?.[0];
            if (primitiveId === 'B') {
              throw new Error('Bridge method "api.call" timed out after 5000ms');
            }
            return {
              result: [{ pinNumber: '1', pinName: primitiveId, x: 10, y: 10 }],
            };
          }
          return {};
        },
      );

      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;

      expect(result).toMatchObject({
        success: false,
        scan_complete: false,
        collision_count: 1,
        scan_diagnostics: {
          stage: 'pin_lookup',
          component_count: 3,
          components_scanned: 2,
          failed_component_count: 1,
          failed_components: [{ primitive_id: 'B' }],
          concurrency: 4,
        },
      });
      expect(result.error).toContain('incomplete');
    });

    it('returns success=false on bridge error', async () => {
      const tool = registry.get('easyeda_schematic_check_collisions');
      bridgeCall.mockRejectedValue(new Error('bridge down'));

      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;

      expect(result).toMatchObject({ success: false, collision_count: 0, error: 'bridge down' });
    });
  });

  describe('easyeda_schematic_audit_imported_design', () => {
    it('builds a read-only imported-design audit with normalization preview', async () => {
      const tool = registry.get('easyeda_schematic_audit_imported_design');
      expect(tool).toBeDefined();
      expect(tool?.confirmWrite).toBe(false);
      expect(tool?.annotations.readOnlyHint).toBe(true);

      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.listComponents') {
          return {
            total: 501,
            items: [
              {
                primitiveId: 'u1',
                componentType: 'part',
                reference: 'U?',
                value: 'RP2040',
                footprint: '',
                symbolSource: 'KiCad imported',
              },
              {
                primitiveId: 'r1a',
                componentType: 'part',
                reference: 'R1',
                value: '10k',
                footprint: 'R_0603',
              },
              {
                primitiveId: 'r1b',
                componentType: 'part',
                reference: 'R1',
                value: '1k',
                footprint: 'R_0603',
              },
            ],
          };
        }
        if (method === 'schematic.listNets') {
          return [
            { netName: 'SYMBOLS_GND', nodes: [{ component: 'U?', pin: '1' }] },
            { netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] },
            { netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U?', pin: '2' }] },
          ];
        }
        return null;
      });

      const result = await tool?.handler(context, {
        projectId: 'servo-module',
        includeInfo: true,
        componentLimit: 500,
      });

      expect(bridgeCall).toHaveBeenCalledWith('schematic.listComponents', {
        projectId: 'servo-module',
        limit: 500,
        offset: 0,
      });
      expect(bridgeCall).toHaveBeenCalledWith('schematic.listNets', {
        projectId: 'servo-module',
      });
      expect(result).toMatchObject({
        project_id: 'servo-module',
        audit_schema_version: 'imported-design-audit/v1',
        status: 'blocked',
        read_only: true,
        safe_to_normalize: false,
        source: {
          component_total: 501,
          component_items_read: 3,
          net_items_read: 3,
          source_truncated: true,
        },
        summary: {
          duplicate_reference_count: 1,
          unannotated_component_count: 1,
          missing_footprint_count: 1,
          imported_net_count: 2,
          aliased_net_count: 1,
        },
      });
      expect(result?.findings).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_COMPONENT_REFERENCE',
          severity: 'error',
          component_ref: 'R1',
        }),
      );
      expect(result?.normalization_preview.net_aliases).toContainEqual(
        expect.objectContaining({
          canonical_net_name: 'GND',
          raw_net_names: ['GND', 'SYMBOLS_GND'],
        }),
      );
    });

    it('returns a structured unavailable result when live readback fails', async () => {
      const tool = registry.get('easyeda_schematic_audit_imported_design');
      bridgeCall.mockRejectedValue(new Error('bridge unavailable'));

      const result = await tool?.handler(context, {
        projectId: 'servo-module',
        includeInfo: true,
        componentLimit: 500,
      });

      expect(result).toMatchObject({
        project_id: 'servo-module',
        status: 'blocked',
        read_only: true,
        safe_to_normalize: false,
        findings: [],
        not_available: true,
        error: 'bridge unavailable',
      });
    });
  });

  describe('easyeda_schematic_preview_imported_normalization', () => {
    it('returns a deterministic read-only plan using only component and net readback', async () => {
      const tool = registry.get('easyeda_schematic_preview_imported_normalization');
      expect(tool).toBeDefined();
      expect(tool?.confirmWrite).toBe(false);
      expect(tool?.annotations.readOnlyHint).toBe(true);

      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.listComponents') {
          return {
            total: 2,
            items: [
              {
                primitiveId: 'u1',
                componentType: 'part',
                reference: 'U1',
                value: 'NE555',
                footprint: 'DIP-8',
              },
              {
                primitiveId: 'u-imported',
                componentType: 'part',
                reference: 'U?',
                value: '={Value}',
                footprint: '={Footprint}',
                attributes: { Value: 'RP2040', Footprint: 'QFN-56' },
              },
            ],
          };
        }
        if (method === 'schematic.listNets') {
          return [
            { netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U?', pin: '1' }] },
            { netName: 'SYMBOLS_GND', nodes: [{ component: 'U?', pin: '2' }] },
          ];
        }
        throw new Error(`unexpected bridge method: ${method}`);
      });

      const input = {
        projectId: 'servo-module',
        componentLimit: 500,
        normalizeNetNames: true,
        annotateReferences: true,
        resolveMetadataExpressions: true,
        componentOverrides: [],
      };
      const first = await tool?.handler(context, input);
      const second = await tool?.handler(context, input);

      expect(bridgeCall).toHaveBeenCalledTimes(4);
      expect(new Set(bridgeCall.mock.calls.map((call: any[]) => call[0]))).toEqual(
        new Set(['schematic.listComponents', 'schematic.listNets']),
      );
      expect(first?.plan).toEqual(second?.plan);
      expect(first).toMatchObject({
        project_id: 'servo-module',
        source: {
          component_total: 2,
          component_items_read: 2,
          net_items_read: 2,
          source_truncated: false,
        },
        plan: {
          schemaVersion: 'imported-normalization-plan/v1',
          readOnly: true,
          status: 'ready',
          applicationReady: true,
          safeToAutoApply: true,
          summary: {
            operationCount: 5,
            netRenameCount: 2,
            referenceAnnotationCount: 1,
            valueUpdateCount: 1,
            footprintUpdateCount: 1,
            blockerCount: 0,
          },
        },
      });
      expect(first?.plan.operations).toContainEqual(
        expect.objectContaining({
          kind: 'annotate-reference',
          targetId: 'u-imported',
          after: { reference: 'U2' },
        }),
      );
    });

    it('uses explicit overrides and marks the resulting plan for confirmation', async () => {
      const tool = registry.get('easyeda_schematic_preview_imported_normalization');
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.listComponents') {
          return {
            total: 1,
            items: [
              {
                primitiveId: 'c1',
                componentType: 'part',
                reference: 'C1',
                value: '',
                footprint: '',
              },
            ],
          };
        }
        if (method === 'schematic.listNets') return [];
        return null;
      });

      const result = await tool?.handler(context, {
        projectId: 'servo-module',
        componentLimit: 500,
        normalizeNetNames: true,
        annotateReferences: true,
        resolveMetadataExpressions: true,
        componentOverrides: [{ componentId: 'c1', value: '100nF', footprint: 'C_0603' }],
      });

      expect(result?.plan).toMatchObject({
        status: 'review',
        applicationReady: true,
        safeToAutoApply: false,
        requiresConfirmation: true,
        summary: {
          operationCount: 2,
          confirmationOperationCount: 2,
          valueUpdateCount: 1,
          footprintUpdateCount: 1,
        },
      });
    });

    it('rejects duplicate overrides in the public input schema', () => {
      const tool = registry.get('easyeda_schematic_preview_imported_normalization');
      const parsed = tool?.inputSchema.safeParse({
        projectId: 'servo-module',
        componentOverrides: [
          { componentId: 'c1', value: '1nF' },
          { componentId: 'c1', value: '10nF' },
        ],
      });

      expect(parsed?.success).toBe(false);
    });

    it('returns a blocked truncated plan when live readback fails', async () => {
      const tool = registry.get('easyeda_schematic_preview_imported_normalization');
      bridgeCall.mockRejectedValue(new Error('bridge unavailable'));

      const result = await tool?.handler(context, {
        projectId: 'servo-module',
        componentLimit: 500,
        normalizeNetNames: true,
        annotateReferences: true,
        resolveMetadataExpressions: true,
        componentOverrides: [],
      });

      expect(result).toMatchObject({
        project_id: 'servo-module',
        source: {
          component_total: 0,
          component_items_read: 0,
          net_items_read: 0,
          source_truncated: true,
        },
        plan: {
          status: 'blocked',
          applicationReady: false,
          safeToAutoApply: false,
          summary: { blockerCount: 1 },
        },
        not_available: true,
        error: 'bridge unavailable',
      });
      expect(result?.plan.blockers).toContainEqual(
        expect.objectContaining({ code: 'SOURCE_COMPONENTS_TRUNCATED' }),
      );
    });
  });
});

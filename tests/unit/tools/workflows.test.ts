import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerWorkflowTools } from '../../../src/tools/L2_workflows.js';
import { EnvSchema } from '../../../src/config/env.js';

const deviceItem = { libraryUuid: 'lib-1', uuid: 'dev-1' };

describe('Workflow Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerWorkflowTools(registry, config);

    bridgeCall = vi.fn();
    context = {
      profile: 'pro',
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

  describe('easyeda_workflow_ne555_astable', () => {
    const devices = {
      timer: deviceItem,
      resistor: deviceItem,
      timingCapacitor: deviceItem,
      bypassCapacitor: deviceItem,
      led: deviceItem,
    };

    it('previews a safe NE555 astable plan without write operations', async () => {
      bridgeCall.mockResolvedValueOnce({ currentPage: { width: 1189, height: 841 } });
      const tool = registry.get('easyeda_workflow_ne555_astable');
      const result = (await tool?.handler(context, {
        projectId: 'proj-555',
        mode: 'preview',
        devices,
      })) as any;

      expect(result.applied).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.safe_region.blocked).toBe(false);
      expect(result.design.calculated.frequency_hz).toBeCloseTo(1.053, 3);
      expect(result.placements).toHaveLength(8);
      expect(result.operations.filter((op: any) => op.kind === 'connectPinToNet')).toHaveLength(22);
      expect(result.operations.filter((op: any) => op.kind === 'addWire')).toHaveLength(22);
      expect(result.operations.filter((op: any) => op.kind === 'createNetPort')).toHaveLength(0);
      expect(bridgeCall).toHaveBeenCalledTimes(1);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.getSheetInfo', { projectId: 'proj-555' });
    });

    it('runs post-write QA after a successful apply and keeps success true when QA passes', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.getSheetInfo')
          return { currentPage: { width: 1189, height: 841 } };
        if (method === 'schematic.placeComponent')
          return { primitiveId: `id-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.connectPinToNet') return { success: true };
        if (method === 'schematic.addWire')
          return { primitiveId: `wire-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.createNetPort')
          return { primitiveId: `net-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.listComponents') return { total: 8, items: [] };
        if (method === 'design.drc' || method === 'design.erc') {
          return { violations: [], totalViolations: 0, errorCount: 0, warningCount: 0 };
        }
        return { result: [] };
      });

      const tool = registry.get('easyeda_workflow_ne555_astable');
      const result = (await tool?.handler(context, {
        projectId: 'proj-555',
        mode: 'apply',
        confirmWrite: true,
        devices,
      })) as any;

      expect(result.applied).toBe(true);
      expect(result.success).toBe(true);
      expect(result.post_write_qa.status).toBe('pass');
      expect(bridgeCall).toHaveBeenCalledWith('design.drc', { projectId: 'proj-555' });
      expect(bridgeCall).toHaveBeenCalledWith('design.erc', { projectId: 'proj-555' });
    });

    it('gates successful writes as failed when post-write QA fails', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.getSheetInfo')
          return { currentPage: { width: 1189, height: 841 } };
        if (method === 'schematic.placeComponent')
          return { primitiveId: `id-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.connectPinToNet') return { success: true };
        if (method === 'schematic.addWire')
          return { primitiveId: `wire-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.createNetPort')
          return { primitiveId: `net-${bridgeCall.mock.calls.length}` };
        if (method === 'schematic.listComponents') return { total: 8, items: [] };
        if (method === 'design.drc') {
          return {
            violations: [
              {
                description: 'Wire $1N4 has multiple net names: +5V +5V',
                severity: 'warning',
                net: '+5V',
              },
            ],
            totalViolations: 1,
            warningCount: 1,
          };
        }
        if (method === 'design.erc') return { violations: [], totalViolations: 0, errorCount: 0 };
        return { result: [] };
      });

      const tool = registry.get('easyeda_workflow_ne555_astable');
      const result = (await tool?.handler(context, {
        projectId: 'proj-555',
        mode: 'apply',
        confirmWrite: true,
        devices,
      })) as any;

      expect(result.applied).toBe(true);
      expect(result.success).toBe(false);
      expect(result.post_write_qa.status).toBe('fail');
      expect(result.post_write_qa.categories.duplicate_net_names).toBe(1);
    });
  });

  describe('easyeda_workflow_power_rail', () => {
    const basePowerRailInput = () => ({
      projectId: 'proj-1',
      anchor: { x: 0, y: 0 },
      groundNetName: 'GND',
      inputNetName: 'VIN',
      outputNetName: 'VOUT',
      components: [
        {
          ref: 'U1',
          role: 'power-regulator',
          deviceItem,
          pinConnections: [
            { pin: '1', netName: 'VIN' },
            { pin: '2', netName: 'GND' },
            { pin: '3', netName: 'VOUT' },
          ],
        },
        {
          ref: 'C1',
          role: 'output-capacitor',
          deviceItem,
          pinConnections: [
            { pin: '1', netName: 'VOUT' },
            { pin: '2', netName: 'GND' },
          ],
        },
      ],
    });

    it('preview mode returns a plan without calling the bridge', async () => {
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'preview',
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.operations.length).toBeGreaterThan(0);
    });

    it('warns when no component role looks like a regulator', async () => {
      const tool = registry.get('easyeda_workflow_power_rail');
      const input = basePowerRailInput();
      input.components[0]!.role = 'mystery-part';
      const result = (await tool?.handler(context, { ...input, mode: 'preview' })) as any;
      expect(
        result.issues.some((issue: any) => issue.message.includes('No component role contains')),
      ).toBe(true);
    });

    it('blocks apply when confirmWrite is not true', async () => {
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'apply',
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
    });

    it('applies placements and resolves the placeholder primitiveId for pin connections', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.placeComponent') return { primitiveId: 'placed-1' };
        if (method === 'schematic.connectPinToNet') return { connected: true };
        return {};
      });
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'apply',
        confirmWrite: true,
      })) as any;

      expect(result.applied).toBe(true);
      expect(result.rolled_back).toBe(false);
      const connectCalls = bridgeCall.mock.calls.filter(
        ([method]) => method === 'schematic.connectPinToNet',
      );
      expect(connectCalls.length).toBeGreaterThan(0);
      for (const [, params] of connectCalls) {
        expect((params as any).primitiveId).toBe('placed-1');
      }
    });

    it('rolls back newly-placed primitives when a later operation fails', async () => {
      let placeCount = 0;
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.placeComponent') {
          placeCount += 1;
          return { primitiveId: `placed-${placeCount}` };
        }
        if (method === 'schematic.connectPinToNet') {
          throw new Error('bridge rejected connection');
        }
        if (method === 'schematic.deletePrimitive') {
          return { success: true };
        }
        return {};
      });
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'apply',
        confirmWrite: true,
      })) as any;

      expect(result.applied).toBe(false);
      expect(result.rolled_back).toBe(true);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
        primitiveIds: ['placed-1', 'placed-2'],
      });
    });

    it('surfaces (but does not crash on) a failed rollback attempt', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'schematic.placeComponent') return { primitiveId: 'placed-1' };
        if (method === 'schematic.connectPinToNet') throw new Error('connection failed');
        if (method === 'schematic.deletePrimitive') throw new Error('rollback also failed');
        return {};
      });
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'apply',
        confirmWrite: true,
      })) as any;

      expect(result.applied).toBe(false);
      expect(result.rolled_back).toBe(false);
      expect(result.summary).toMatch(/rollback also failed/);
    });

    it('omits verification when verifyRail is not provided', async () => {
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'preview',
      })) as any;
      expect(result.verification).toBeUndefined();
    });

    it('attaches a verification verdict when verifyRail is provided (ngspice unavailable in this env)', async () => {
      const tool = registry.get('easyeda_workflow_power_rail');
      const result = (await tool?.handler(context, {
        ...basePowerRailInput(),
        mode: 'preview',
        verifyRail: {
          inputVoltage: 5,
          outputVoltage: 3.3,
          loadCurrentA: 0.5,
        },
      })) as any;
      // No ngspice binary is installed in this test environment, so this exercises the
      // real graceful-degradation path rather than a mocked success.
      expect(result.verification).toBeDefined();
      expect(result.verification.available).toBe(false);
      expect(result.verification.error).toMatch(/not installed/);
      expect(result.verification.caveat).toMatch(/Simplified linear regulator model/);
    });
  });

  describe('easyeda_workflow_decouple_ic', () => {
    it('places one capacitor per declared IC power pin and includes decoupling guidance', async () => {
      const tool = registry.get('easyeda_workflow_decouple_ic');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'preview',
        anchor: { x: 0, y: 0 },
        groundNetName: 'GND',
        icPowerPins: [
          { pin: '8', netName: 'VDD' },
          { pin: '16', netName: 'VDDIO' },
        ],
        capacitor: deviceItem,
        decouplingCategory: 'mcu',
      })) as any;

      expect(result.placements).toHaveLength(2);
      expect(result.decoupling_guidance).toBeDefined();
      expect(result.decoupling_guidance.category).toBe('mcu');
      const netNames = result.operations
        .filter((op: any) => op.kind === 'connectPinToNet')
        .map((op: any) => op.params.netName);
      expect(netNames).toContain('VDD');
      expect(netNames).toContain('VDDIO');
      expect(netNames.filter((name: string) => name === 'GND')).toHaveLength(2);
    });

    it('blocks apply when confirmWrite is not true', async () => {
      const tool = registry.get('easyeda_workflow_decouple_ic');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        anchor: { x: 0, y: 0 },
        groundNetName: 'GND',
        icPowerPins: [{ pin: '8', netName: 'VDD' }],
        capacitor: deviceItem,
        decouplingCategory: 'mcu',
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
    });
  });

  describe('easyeda_workflow_place_block', () => {
    it('rejects an empty block as blocked', async () => {
      const tool = registry.get('easyeda_workflow_place_block');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'preview',
        anchor: { x: 0, y: 0 },
        components: [],
        existingComponents: [],
        netPorts: [],
      })) as any;
      expect(result.blocked).toBe(true);
    });

    it('wires pins on a pre-existing component without placing anything new', async () => {
      bridgeCall.mockResolvedValue({ connected: true });
      const tool = registry.get('easyeda_workflow_place_block');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        confirmWrite: true,
        anchor: { x: 0, y: 0 },
        components: [],
        existingComponents: [
          {
            ref: 'U_EXISTING',
            role: 'mcu',
            primitiveId: 'existing-id',
            pinConnections: [{ pin: '1', netName: 'VCC' }],
          },
        ],
        netPorts: [],
      })) as any;

      expect(result.applied).toBe(true);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.connectPinToNet', {
        projectId: 'proj-1',
        primitiveId: 'existing-id',
        pinNumber: '1',
        netName: 'VCC',
      });
      expect(
        result.rollback_notes.some((note: string) => note.includes('cannot be rolled back')),
      ).toBe(true);
    });

    it('blocks apply when confirmWrite is not true', async () => {
      const tool = registry.get('easyeda_workflow_place_block');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        anchor: { x: 0, y: 0 },
        components: [
          { ref: 'U1', role: 'mcu', deviceItem, pinConnections: [{ pin: '1', netName: 'VCC' }] },
        ],
        existingComponents: [],
        netPorts: [],
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
    });
  });

  describe('easyeda_workflow_connector_breakout', () => {
    it('places the connector, wires each pin, and creates a net port per pin', async () => {
      const tool = registry.get('easyeda_workflow_connector_breakout');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'preview',
        anchor: { x: 0, y: 0 },
        connectorRef: 'J1',
        connector: deviceItem,
        pins: [
          { pin: '1', netName: 'RS485_A' },
          { pin: '2', netName: 'RS485_B' },
        ],
      })) as any;

      expect(result.placements).toHaveLength(1);
      const kinds = result.operations.map((op: any) => op.kind);
      expect(kinds.filter((k: string) => k === 'createNetPort')).toHaveLength(2);
      expect(kinds.filter((k: string) => k === 'connectPinToNet')).toHaveLength(2);
    });

    it('blocks apply when confirmWrite is not true', async () => {
      const tool = registry.get('easyeda_workflow_connector_breakout');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        anchor: { x: 0, y: 0 },
        connectorRef: 'J1',
        connector: deviceItem,
        pins: [{ pin: '1', netName: 'RS485_A' }],
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
    });
  });

  describe('collision reconcile', () => {
    it('nudges a newly-placed component clear of a pin-coordinate collision and still applies', async () => {
      let placed1Pos = { x: 0, y: 0 };
      let modifyCalls = 0;
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'schematic.placeComponent') return { primitiveId: 'placed-1' };
        if (method === 'schematic.listComponents') {
          return {
            total: 2,
            items: [{ primitiveId: 'placed-1' }, { primitiveId: 'EXISTING-1' }],
          };
        }
        if (
          method === 'api.call' &&
          params?.path === 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId'
        ) {
          const id = params.args?.[0];
          if (id === 'placed-1') {
            return {
              result: [{ pinNumber: '1', pinName: 'P1', x: placed1Pos.x, y: placed1Pos.y }],
            };
          }
          if (id === 'EXISTING-1') {
            return { result: [{ pinNumber: '1', pinName: 'P1', x: 0, y: 0 }] };
          }
          return { result: [] };
        }
        if (method === 'schematic.modifyPrimitive') {
          modifyCalls += 1;
          placed1Pos = { x: (params.property as any).x, y: (params.property as any).y };
          return { success: true };
        }
        return {};
      });

      const tool = registry.get('easyeda_workflow_place_block');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        confirmWrite: true,
        anchor: { x: 0, y: 0 },
        components: [{ ref: 'C1', role: 'decoupling-capacitor', deviceItem, pinConnections: [] }],
        existingComponents: [],
        netPorts: [],
      })) as any;

      expect(result.applied).toBe(true);
      expect(modifyCalls).toBe(1);
      expect(placed1Pos).not.toEqual({ x: 0, y: 0 });
      expect(result.issues.some((i: any) => i.code === 'WORKFLOW_PIN_COLLISION')).toBe(false);
    });

    it('blocks and rolls back when a pin-coordinate collision cannot be resolved by nudging', async () => {
      let placed1Pos = { x: 0, y: 0 };
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (method === 'schematic.placeComponent') return { primitiveId: 'placed-1' };
        if (method === 'schematic.listComponents') {
          return {
            total: 2,
            items: [{ primitiveId: 'placed-1' }, { primitiveId: 'EXISTING-1' }],
          };
        }
        if (
          method === 'api.call' &&
          params?.path === 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId'
        ) {
          const id = params.args?.[0];
          // EXISTING-1 mirrors placed-1's position, so no amount of nudging escapes it.
          if (id === 'placed-1' || id === 'EXISTING-1') {
            return {
              result: [{ pinNumber: '1', pinName: 'P1', x: placed1Pos.x, y: placed1Pos.y }],
            };
          }
          return { result: [] };
        }
        if (method === 'schematic.modifyPrimitive') {
          placed1Pos = { x: (params.property as any).x, y: (params.property as any).y };
          return { success: true };
        }
        if (method === 'schematic.deletePrimitive') return { success: true };
        return {};
      });

      const tool = registry.get('easyeda_workflow_place_block');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        mode: 'apply',
        confirmWrite: true,
        anchor: { x: 0, y: 0 },
        components: [{ ref: 'C1', role: 'decoupling-capacitor', deviceItem, pinConnections: [] }],
        existingComponents: [],
        netPorts: [],
      })) as any;

      expect(result.applied).toBe(false);
      expect(result.rolled_back).toBe(true);
      expect(result.issues.some((i: any) => i.code === 'WORKFLOW_PIN_COLLISION')).toBe(true);
      expect(bridgeCall).toHaveBeenCalledWith('schematic.deletePrimitive', {
        primitiveIds: ['placed-1'],
      });
    });
  });

  describe('easyeda_workflow_layout_section', () => {
    function mockLayoutBridge(
      pinsByPrimitiveId: Record<string, Array<Record<string, unknown>>>,
      overrides: Record<string, (params: any) => any> = {},
    ) {
      bridgeCall.mockImplementation(async (method: string, params: any) => {
        if (overrides[method]) return overrides[method](params);
        if (
          method === 'api.call' &&
          params?.path === 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId'
        ) {
          const id = params.args?.[0];
          return { result: pinsByPrimitiveId[id] ?? [] };
        }
        if (method === 'schematic.listRectangles') return { total: 0, items: [] };
        if (method === 'schematic.getSheetInfo') return {};
        return {};
      });
    }

    const baseInput = (overrides: Record<string, unknown> = {}) => ({
      projectId: 'proj-1',
      componentPrimitiveIds: ['C1'],
      title: 'DECOUPLING',
      margin: 20,
      componentPadding: 15,
      titleGap: 15,
      titleFontSize: 20,
      color: '#000000',
      ...overrides,
    });

    it('preview mode computes bounds from component pin extents without writing anything', async () => {
      mockLayoutBridge({
        C1: [
          { pinNumber: '1', pinName: 'P1', x: 100, y: 100 },
          { pinNumber: '2', pinName: 'P2', x: 100, y: 120 },
        ],
        C2: [{ pinNumber: '1', pinName: 'P1', x: 200, y: 100 }],
      });
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({ mode: 'preview', componentPrimitiveIds: ['C1', 'C2'] }),
      )) as any;

      expect(result.success).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.bounds).toEqual({ x: 65, y: 65, width: 170, height: 90 });
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.addRectangle', expect.anything());
    });

    it('apply mode creates a rectangle and title sized to the computed bounds', async () => {
      mockLayoutBridge(
        { C1: [{ pinNumber: '1', pinName: 'P1', x: 0, y: 0 }] },
        {
          'schematic.addRectangle': () => ({ primitiveId: 'rect-1' }),
          'schematic.addText': () => ({ primitiveId: 'text-1' }),
        },
      );
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({ mode: 'apply', confirmWrite: true, title: 'MCU CORE' }),
      )) as any;

      expect(result.applied).toBe(true);
      expect(result.rectangle_primitive_id).toBe('rect-1');
      expect(result.title_primitive_id).toBe('text-1');
      expect(bridgeCall).toHaveBeenCalledWith(
        'schematic.addRectangle',
        expect.objectContaining({ x: -35, y: -35, width: 70, height: 70 }),
      );
      expect(bridgeCall).toHaveBeenCalledWith(
        'schematic.addText',
        expect.objectContaining({ content: 'MCU CORE', x: -35, y: -50 }),
      );
    });

    it('blocks apply when confirmWrite is not true', async () => {
      mockLayoutBridge({ C1: [{ pinNumber: '1', pinName: 'P1', x: 0, y: 0 }] });
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(context, baseInput({ mode: 'apply' }))) as any;

      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.addRectangle', expect.anything());
    });

    it('replace mode deletes the old rectangle/title before creating the resized ones', async () => {
      const deletedIds: string[] = [];
      mockLayoutBridge(
        { C1: [{ pinNumber: '1', pinName: 'P1', x: 0, y: 0 }] },
        {
          'schematic.deletePrimitive': (params: any) => {
            deletedIds.push(...(params.primitiveIds ?? []));
            return { success: true };
          },
          'schematic.addRectangle': () => ({ primitiveId: 'rect-new' }),
          'schematic.addText': () => ({ primitiveId: 'text-new' }),
        },
      );
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({
          mode: 'apply',
          confirmWrite: true,
          title: 'BOOT0 CONFIG',
          replaceRectanglePrimitiveId: 'rect-old',
          replaceTitlePrimitiveId: 'text-old',
        }),
      )) as any;

      expect(deletedIds).toEqual(['rect-old', 'text-old']);
      expect(result.deleted_primitive_ids).toEqual(['rect-old', 'text-old']);
      expect(result.rectangle_primitive_id).toBe('rect-new');
    });

    it('reports overlapping rectangles as an advisory warning without blocking', async () => {
      mockLayoutBridge(
        { C1: [{ pinNumber: '1', pinName: 'P1', x: 0, y: 0 }] },
        {
          'schematic.listRectangles': () => ({
            total: 1,
            items: [{ primitiveId: 'other-rect', x: -50, y: -50, width: 100, height: 100 }],
          }),
        },
      );
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({ mode: 'preview', title: 'SPI FLASH' }),
      )) as any;

      expect(result.success).toBe(true);
      expect(result.overlapping_rectangles).toEqual([
        { primitiveId: 'other-rect', x: -50, y: -50, width: 100, height: 100 },
      ]);
    });

    it('warns (without attempting a write) when the section would extend past the reported page size', async () => {
      mockLayoutBridge(
        { C1: [{ pinNumber: '1', pinName: 'P1', x: 900, y: 900 }] },
        { 'schematic.getSheetInfo': () => ({ width: 800, height: 800 }) },
      );
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({ mode: 'preview', title: 'USB TYPE-C' }),
      )) as any;

      expect(result.page_frame_warning).toMatch(/extend past the reported page size/);
      expect(bridgeCall).not.toHaveBeenCalledWith('schematic.setTitleBlock', expect.anything());
    });

    it('returns a clear error when no pin coordinates can be found for the given components', async () => {
      mockLayoutBridge({});
      const tool = registry.get('easyeda_workflow_layout_section');
      const result = (await tool?.handler(
        context,
        baseInput({ mode: 'preview', componentPrimitiveIds: ['ghost'] }),
      )) as any;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Could not determine pin coordinates/);
    });
  });
});

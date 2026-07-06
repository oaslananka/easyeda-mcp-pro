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
  });
});

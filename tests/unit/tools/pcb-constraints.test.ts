import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbConstraintTools } from '../../../src/tools/L1_pcb_constraints.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('PCB constraint tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<
    typeof vi.fn<(method: string, params?: unknown, opts?: unknown) => Promise<unknown>>
  >;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerPcbConstraintTools(registry, config);

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

  it('registers production review tool', () => {
    expect(registry.get('easyeda_pcb_constraint_check')).toBeDefined();
    expect(registry.get('easyeda_pcb_constraint_report')).toBeDefined();
    expect(registry.get('easyeda_pcb_production_review')).toBeDefined();
  });

  it('easyeda_pcb_production_review returns severity-ranked production findings', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'pcb-prod-1',
      gateMode: 'warn',
      boardData: {
        widthMm: 60,
        heightMm: 40,
        layerCount: 2,
        hasOutline: true,
        mountingHoleCount: 4,
        hasLayerStack: true,
        hasNetClasses: true,
        hasClearanceRules: true,
        hasKeepoutAreas: true,
        hasPlacementZones: true,
        hasFiducials: true,
        hasTestPads: true,
        hasHighVoltage: false,
        manufacturingProcess: 'standard',
        hasQuantity: true,
        hasDrillFile: false,
        minCopperToEdgeMm: 0.1,
        criticalNetNames: ['GND', '3V3', 'RESET'],
        testPointNets: ['GND'],
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.project_id).toBe('pcb-prod-1');
    expect(result?.passed).toBe(false);
    expect(result?.blocked).toBe(false);
    expect(result?.severity_counts.errors).toBeGreaterThanOrEqual(2);
    expect(result?.errors.map((e: { code: string }) => e.code)).toEqual(
      expect.arrayContaining(['PCB_DRILL_FILE_MISSING', 'PCB_COPPER_EDGE_CLEARANCE']),
    );
    expect(
      result?.warnings.some((w: { code: string }) => w.code === 'PCB_TESTPOINT_COVERAGE_LOW'),
    ).toBe(true);
  });

  it('easyeda_pcb_production_review blocks in block mode when errors exist', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    const result = await tool?.handler(context, {
      projectId: 'pcb-prod-2',
      gateMode: 'block',
      boardData: {
        hasOutline: true,
        hasLayerStack: true,
        hasNetClasses: true,
        hasClearanceRules: true,
        hasKeepoutAreas: true,
        hasPlacementZones: true,
        hasFiducials: true,
        mountingHoleCount: 4,
        manufacturingProcess: 'standard',
        hasQuantity: true,
        hasDrillFile: false,
      },
    });

    expect(result?.blocked).toBe(true);
    expect(result?.gate_mode).toBe('block');
  });

  it('easyeda_pcb_production_review fetches board data from the bridge when boardData is omitted', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { widthMm: 60, heightMm: 40, mountingHoleCount: 4 };
      if (method === 'board.listLayers') return [{ id: 1 }, { id: 2 }];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }, { id: 2 }] };
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-bridge-1', gateMode: 'warn' });

    expect(bridgeCall).toHaveBeenCalledWith('board.getDimensions', { projectId: 'pcb-bridge-1' });
    expect(bridgeCall).toHaveBeenCalledWith('board.listLayers', { projectId: 'pcb-bridge-1' });
    expect(bridgeCall).toHaveBeenCalledWith('board.getStackup', { projectId: 'pcb-bridge-1' });
    expect(result?.project_id).toBe('pcb-bridge-1');
    expect(result?.summary.totalChecks).toBeGreaterThan(0);
  });

  it('easyeda_pcb_production_review tolerates partial bridge failures via Promise.allSettled', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') throw new Error('dimensions unavailable');
      if (method === 'board.listLayers') return { layers: [{ id: 1 }] };
      if (method === 'board.getStackup') throw new Error('stackup unavailable');
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-bridge-2', gateMode: 'warn' });

    expect(result?.project_id).toBe('pcb-bridge-2');
    expect(result?.not_available).toBeUndefined();
  });

  it('easyeda_pcb_constraint_check validates explicit board data', async () => {
    const tool = registry.get('easyeda_pcb_constraint_check');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'pcb-check-1',
      boardData: {
        widthMm: 60,
        heightMm: 40,
        layerCount: 2,
        hasOutline: true,
        mountingHoleCount: 4,
        hasLayerStack: true,
        hasNetClasses: true,
        hasClearanceRules: true,
        hasKeepoutAreas: true,
        hasPlacementZones: true,
        hasFiducials: true,
        hasTestPads: true,
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.project_id).toBe('pcb-check-1');
    expect(typeof result?.valid).toBe('boolean');
    expect(result?.summary.totalChecks).toBeGreaterThan(0);
  });

  it('easyeda_pcb_constraint_check fetches board data from the bridge when boardData is omitted', async () => {
    const tool = registry.get('easyeda_pcb_constraint_check');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 60, heightMm: 40 };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return {};
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-check-2' });

    expect(bridgeCall).toHaveBeenCalledTimes(3);
    expect(result?.project_id).toBe('pcb-check-2');
  });

  it('easyeda_pcb_constraint_report builds a human-readable report from explicit board data', async () => {
    const tool = registry.get('easyeda_pcb_constraint_report');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'pcb-report-1',
      boardData: {
        widthMm: 60,
        heightMm: 40,
        layerCount: 2,
        hasOutline: true,
        mountingHoleCount: 4,
        hasLayerStack: true,
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.project_id).toBe('pcb-report-1');
    expect(typeof result?.verdict).toBe('string');
    expect(Array.isArray(result?.checked)).toBe(true);
    expect(Array.isArray(result?.manualReviewRequired)).toBe(true);
  });

  it('easyeda_pcb_constraint_report fetches board data from the bridge when boardData is omitted', async () => {
    const tool = registry.get('easyeda_pcb_constraint_report');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 60, heightMm: 40 };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return {};
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-report-2' });

    expect(bridgeCall).toHaveBeenCalledTimes(3);
    expect(result?.project_id).toBe('pcb-report-2');
  });
});

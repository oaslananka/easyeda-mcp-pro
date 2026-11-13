import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import {
  fetchBoardDataFromBridge,
  fetchBoardEvidenceFromBridge,
  registerPcbConstraintTools,
} from '../../../src/tools/L1_pcb_constraints.js';
import { EnvSchema } from '../../../src/config/env.js';

function setNativeFocus(context: ToolContext, projectId: string, pcbUuid = 'pcb-test') {
  const boardRead = context.bridge.call;
  context.bridge.call = (async (method: string, params?: unknown) => {
    if (method === 'api.call') {
      const path = (params as { path?: string } | undefined)?.path;
      if (path === 'DMT_Project.getCurrentProjectInfo') return { result: { uuid: projectId } };
      if (path === 'DMT_Pcb.getCurrentPcbInfo')
        return { result: { uuid: pcbUuid, parentProjectUuid: projectId } };
      throw new Error('unexpected native identity lookup');
    }
    return boardRead(method, params);
  }) as typeof context.bridge.call;
}

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

  it('uses independent caller-supplied stackup counts only to detect a real mismatch', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    const result = await tool?.handler(context, {
      projectId: 'explicit-stackup-evidence',
      boardData: {
        layerCount: 6,
        stackupCopperLayerCount: 4,
        hasLayerStack: true,
      },
    });
    expect(result?.errors).toContainEqual(
      expect.objectContaining({ code: 'PCB_LAYER_COUNT_MISMATCH', severity: 'error' }),
    );
    expect(result?.passed).toBe(false);
    expect(bridgeCall).not.toHaveBeenCalled();
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

  it('preserves per-finding process revision and missing measurement source in the public tool result', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    const result = await tool?.handler(context, {
      projectId: 'example-board',
      boardData: { widthMm: 100 },
      manufacturerProfile: {
        manufacturer: 'Example fab (hypothetical)',
        process: 'prototype',
        revision: 'rev-X',
        source: 'Caller-supplied test limits',
        limits: { maximumBoardWidthMm: 80, minimumAnnularRingMm: 0.15 },
      },
    });
    const findings = result?.manufacturing_profile_review?.findings;
    expect(findings).toEqual([
      expect.objectContaining({
        id: 'minimumAnnularRingMm',
        status: 'UNKNOWN',
        units: 'mm',
        profile_reference: 'Caller-supplied test limits',
        profile_revision: 'rev-X',
        measurement_evidence: 'unavailable',
      }),
      expect.objectContaining({
        id: 'maximumBoardWidthMm',
        status: 'WARNING',
        units: 'mm',
        actual: 100,
        profile_reference: 'Caller-supplied test limits',
        profile_revision: 'rev-X',
        measurement_evidence: 'caller_supplied_unverified',
      }),
    ]);
    expect(result?.manufacturing_approval).toBe(false);
    expect(result?.passed).toBe(false);
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('does not label a fully observed board with a known fabrication warning as passed', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    const complete = {
      widthMm: 60,
      heightMm: 40,
      hasOutline: true,
      layerCount: 2,
      mountingHoleCount: 2,
      hasLayerStack: true,
      hasNetClasses: true,
      hasClearanceRules: true,
      hasPlacementZones: true,
      hasKeepoutAreas: true,
      hasFiducials: true,
      hasHighVoltage: false,
      manufacturingProcess: 'standard',
      hasQuantity: true,
      hasDrillFile: true,
      minCopperToEdgeMm: 1,
      minDrillMm: 0.762,
      minAnnularRingMm: 0.4,
      minSolderMaskSliverMm: 0.3,
      silkscreenOverPadCount: 0,
      smtComponentCount: 0,
      polarizedComponentCount: 0,
      componentSpacingViolationCount: 0,
      criticalNetNames: [],
      requiresProgrammingHeader: false,
      hasFabricationNotes: true,
    };

    // All evidence is explicitly supplied: this must test a real warning,
    // not a result already withheld because another rule is UNKNOWN.
    const clean = await tool?.handler(context, {
      projectId: 'complete-known-fixture',
      boardData: complete,
      gateMode: 'warn',
    });
    expect(clean?.summary.unknown).toBe(0);
    expect(clean?.errors).toEqual([]);
    expect(clean?.warnings).toEqual([]);
    expect(clean?.passed).toBe(true);

    for (const mode of ['warn', 'block', 'off'] as const) {
      const result = await tool?.handler(context, {
        projectId: 'complete-known-fixture',
        boardData: { ...complete, hasFabricationNotes: false },
        gateMode: mode,
      });
      expect(result?.summary.unknown).toBe(0);
      expect(result?.errors).toEqual([]);
      expect(result?.warnings).toContainEqual(
        expect.objectContaining({ code: 'PCB_FAB_NOTES_MISSING', severity: 'warning' }),
      );
      expect(result?.summary.failed).toBe(1);
      expect(result?.passed).toBe(false);
      expect(result?.blocked).toBe(mode === 'block');
    }
    expect(bridgeCall).not.toHaveBeenCalled();
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
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      throw new Error(`unexpected method ${method}`);
    });

    setNativeFocus(context, 'pcb-bridge-1');
    const result = await tool?.handler(context, { projectId: 'pcb-bridge-1', gateMode: 'warn' });

    expect(bridgeCall).toHaveBeenCalledWith('board.getDimensions', { projectId: 'pcb-bridge-1' });
    expect(bridgeCall).toHaveBeenCalledWith('board.listLayers', { projectId: 'pcb-bridge-1' });
    expect(bridgeCall).toHaveBeenCalledWith('board.getStackup', { projectId: 'pcb-bridge-1' });
    expect(bridgeCall).toHaveBeenCalledWith('board.getDesignRules', { projectId: 'pcb-bridge-1' });
    expect(result?.project_id).toBe('pcb-bridge-1');
    expect(result?.native_focus_status).toBe('verified');
    expect(result?.summary.totalChecks).toBeGreaterThan(0);
  });

  it.each([
    ['board.getDimensions', null],
    ['board.getDimensions', []],
    ['board.getStackup', 'no stackup'],
    ['board.getDesignRules', 42],
    ['board.listLayers', {}],
  ])(
    'does not mark malformed fulfilled %s as an observed native source',
    async (method, invalid) => {
      bridgeCall.mockImplementation(async (name: string) => {
        if (name === method) return invalid;
        return name === 'board.listLayers' ? [] : {};
      });

      const result = await fetchBoardEvidenceFromBridge(context, 'pcb-invalid-evidence');
      expect(result.observations.find((entry) => entry.method === method)).toMatchObject({
        status: 'unavailable',
      });
      expect(result.observations.filter((entry) => entry.status === 'observed')).toHaveLength(3);
    },
  );

  it.each([
    ['board.getDimensions', { not_available: true, widthMm: 60, heightMm: 40, hasOutline: false }],
    ['board.getStackup', { not_available: true, totalLayers: 4, available: true }],
    ['board.getDesignRules', { not_available: true, hasClearanceRules: true }],
    ['board.listLayers', Object.assign([{ name: 'Top' }], { not_available: true })],
  ])('rejects unavailable sentinel evidence from %s', async (method, unavailable) => {
    bridgeCall.mockImplementation(async (name: string) => {
      if (name === method) return unavailable;
      return name === 'board.listLayers' ? [] : {};
    });

    const result = await fetchBoardEvidenceFromBridge(context, 'pcb-stale-evidence');
    expect(result.observations.find((entry) => entry.method === method)?.status).toBe(
      'unavailable',
    );
    if (method === 'board.getDimensions') {
      expect(result.data.widthMm).toBeUndefined();
      expect(result.data.hasOutline).toBeUndefined();
    }
    if (method === 'board.getStackup') expect(result.data.layerCount).toBeUndefined();
    if (method === 'board.getDesignRules') expect(result.data.hasClearanceRules).toBeUndefined();
  });

  it('uses the measured native minimum drill diameter without guessing mounting holes', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') {
        return {
          widthMm: 60,
          heightMm: 40,
          drilledPadCount: 2,
          platedDrillPadCount: 1,
          unplatedDrillPadCount: 1,
          minDrillMm: 0.762,
          unknownFields: ['mounting_hole_count'],
        };
      }
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [] };
      throw new Error(`unexpected method ${method}`);
    });

    const data = await fetchBoardDataFromBridge(context, 'pcb-drill-evidence');
    expect(data.minDrillMm).toBe(0.762);
    expect(data.mountingHoleCount).toBeUndefined();
  });

  it('does not publish zero native canvas extents as a measured PCB size', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 0, heightMm: 40, hasOutline: true };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }, { id: 2 }] };
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      throw new Error('unexpected native read');
    });
    const native = await fetchBoardDataFromBridge(context, 'pcb-zero-canvas-extent');
    expect(native.widthMm).toBeUndefined();
    expect(native.heightMm).toBe(40);
    const tool = registry.get('easyeda_pcb_production_review');
    setNativeFocus(context, 'pcb-zero-canvas-extent');
    const result = await tool?.handler(context, {
      projectId: 'pcb-zero-canvas-extent',
      gateMode: 'warn',
    });
    expect(result?.passed).toBe(false);
    expect(result?.unknown_checks).toContainEqual({
      area: 'Board dimensions',
      missingFields: ['widthMm'],
    });
    expect(result?.manufacturing_approval).toBeUndefined();
  });

  it('does not manufacture a too-small drill warning from a zero native diameter', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { widthMm: 60, heightMm: 40, hasOutline: true, minDrillMm: 0, drilledPadCount: 0 };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }, { id: 2 }] };
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      throw new Error(`unexpected method ${method}`);
    });

    const native = await fetchBoardDataFromBridge(context, 'pcb-zero-native-drill');
    expect(native.minDrillMm).toBeUndefined();
    const tool = registry.get('easyeda_pcb_production_review');
    setNativeFocus(context, 'pcb-zero-native-drill');
    const result = await tool?.handler(context, {
      projectId: 'pcb-zero-native-drill',
      manufacturerProfile: {
        manufacturer: 'Hypothetical Example',
        process: 'Two-layer prototype',
        revision: 'test-v1',
        source: 'Unverified example capability data',
        limits: { minimumFinishedDrillMm: 0.2 },
      },
    });
    expect(
      result?.warnings.some((item: { code: string }) => item.code === 'PCB_DRILL_TOO_SMALL'),
    ).toBe(false);
    expect(result?.manufacturing_profile_review?.findings[0]).toMatchObject({
      id: 'minimumFinishedDrillMm',
      comparison: 'UNKNOWN',
      status: 'UNKNOWN',
      measurement_evidence: 'unavailable',
    });
    expect(result?.manufacturing_approval).toBe(false);
  });

  it('easyeda_pcb_production_review tolerates partial bridge failures via Promise.allSettled', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') throw new Error('dimensions unavailable');
      if (method === 'board.listLayers') return { layers: [{ id: 1 }] };
      if (method === 'board.getStackup') throw new Error('stackup unavailable');
      if (method === 'board.getDesignRules') throw new Error('design rules unavailable');
      throw new Error(`unexpected method ${method}`);
    });

    setNativeFocus(context, 'pcb-bridge-2');
    const result = await tool?.handler(context, { projectId: 'pcb-bridge-2', gateMode: 'warn' });

    expect(result?.project_id).toBe('pcb-bridge-2');
    expect(result?.not_available).toBeUndefined();
  });

  it('reports UNKNOWN for unavailable native properties and never fabricates missing rules', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { widthMm: 60, heightMm: 40, hasOutline: true, mountingHoleCount: 0 };
      if (method === 'board.listLayers')
        return Array.from({ length: 230 }, (_, id) => ({ id, name: `Custom${id}` }));
      if (method === 'board.getStackup') return { totalLayers: 0, layers: [], available: false };
      throw new Error(`unexpected ${method}`);
    });
    setNativeFocus(context, 'pcb-incomplete');
    const result = await tool?.handler(context, { projectId: 'pcb-incomplete', gateMode: 'block' });
    expect(result?.blocked).toBe(true);
    expect(result?.passed).toBe(false);
    expect(result?.summary.unknown).toBeGreaterThan(10);
    expect(result?.unknown_checks).toEqual(
      expect.arrayContaining([
        { area: 'Layer count', missingFields: ['layerCount'] },
        { area: 'Net classes', missingFields: ['hasNetClasses'] },
        { area: 'High-voltage clearance', missingFields: ['hasHighVoltage'] },
      ]),
    );
    expect(
      result?.warnings.some((issue: { code: string }) => issue.code === 'PCB_MISSING_NET_CLASSES'),
    ).toBe(false);
    expect(
      result?.errors.some((issue: { code: string }) => issue.code === 'PCB_MISSING_OUTLINE'),
    ).toBe(false);
    expect(
      result?.warnings.some((issue: { code: string }) => issue.code === 'PCB_MISSING_STACKUP'),
    ).toBe(true);
  });

  it('keeps partial API failures unknown and does not claim production success in warn mode', async () => {
    const tool = registry.get('easyeda_pcb_production_review');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') throw new Error('no active PCB');
      if (method === 'board.getStackup') throw new Error('no active PCB');
      if (method === 'board.listLayers') return [{ name: 'TopLayer' }, { name: 'BottomLayer' }];
      throw new Error(`unexpected ${method}`);
    });
    setNativeFocus(context, 'pcb-offline');
    const result = await tool?.handler(context, { projectId: 'pcb-offline', gateMode: 'warn' });
    expect(result?.not_available).toBeUndefined();
    expect(result?.passed).toBe(false);
    expect(result?.blocked).toBe(false);
    expect(result?.summary.passed).toBe(0);
    expect(result?.summary.unknown).toBeGreaterThan(15);
    expect(result?.errors).toEqual([]);
    expect(result?.warnings).toEqual([]);
  });

  it('preserves explicit negative board evidence as an actual error', async () => {
    const tool = registry.get('easyeda_pcb_constraint_check');
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 0, heightMm: 0, hasOutline: false };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [], available: false };
      throw new Error(`unexpected ${method}`);
    });
    const result = await tool?.handler(context, { projectId: 'pcb-no-outline' });
    expect(result?.valid).toBe(false);
    expect(
      result?.errors.some((issue: { code: string }) => issue.code === 'PCB_MISSING_OUTLINE'),
    ).toBe(true);
    expect(
      result?.unknown_checks.some((issue: { area: string }) => issue.area === 'Board outline'),
    ).toBe(false);
  });

  it('exposes unknown areas in the human-readable report', async () => {
    const tool = registry.get('easyeda_pcb_constraint_report');
    const result = await tool?.handler(context, { projectId: 'pcb-partial', boardData: {} });
    expect(result?.verdict).toBe('needs-review');
    expect(
      result?.checked.some(
        (item: { area: string; status: string }) =>
          item.area === 'Net classes' && item.status === 'unknown',
      ),
    ).toBe(true);
    expect(
      result?.manualReviewRequired.some((item: { area: string }) => item.area === 'Net classes'),
    ).toBe(true);
  });

  it('does not pass ambiguous case-colliding testpoint nets via MCP', async () => {
    const tool = registry.get('easyeda_pcb_constraint_check');
    const result = await tool?.handler(context, {
      projectId: 'pcb-net-identity-collision',
      boardData: { criticalNetNames: ['IO', 'GND'], testPointNets: ['IO', 'io', 'GND'] },
    });
    expect(result?.valid).toBe(false);
    expect(result?.unknown_checks).toContainEqual({
      area: 'Testpoint coverage',
      missingFields: ['criticalNetNames', 'testPointNets'],
    });
    expect(result?.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'PCB_TESTPOINT_COVERAGE_LOW' }),
    );
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
      if (method === 'board.getDesignRules') return {};
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-check-2' });

    expect(bridgeCall).toHaveBeenCalledTimes(4);
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
      if (method === 'board.getDesignRules') return {};
      throw new Error(`unexpected method ${method}`);
    });

    const result = await tool?.handler(context, { projectId: 'pcb-report-2' });

    expect(bridgeCall).toHaveBeenCalledTimes(4);
    expect(result?.project_id).toBe('pcb-report-2');
  });
});

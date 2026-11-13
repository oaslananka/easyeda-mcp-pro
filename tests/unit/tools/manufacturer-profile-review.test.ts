import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerPcbConstraintTools } from '../../../src/tools/L1_pcb_constraints.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const manufacturerProfile = {
  manufacturer: 'EXAMPLE fab (unverified)',
  process: 'Two-layer fabrication plus assembly',
  revision: 'hypothetical-v3',
  source: 'Caller-declared example process profile, not verified factory capability',
  limits: {
    minimumFinishedDrillMm: 0.3,
    maximumBoardWidthMm: 100,
    minimumToolingHoleCount: 2,
    minimumCriticalNetTestpointRatio: 0.75,
    requireProgrammingHeader: true,
  },
};

function setup() {
  const registry = new ToolRegistry();
  registerPcbConstraintTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const tool = registry.get('easyeda_pcb_production_review');
  if (!tool) throw new Error('missing production review');
  const bridge = vi.fn();
  const ctx = {
    profile: 'core',
    bridge: { connected: false, call: bridge },
    config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as ToolContext;
  return { tool, bridge, ctx };
}

function setNativeFocus(ctx: ToolContext, projectId: string, pcbUuid = 'test-pcb') {
  const read = ctx.bridge.call;
  ctx.bridge.call = (async (method: string, params?: unknown) => {
    if (method === 'api.call') {
      const path = (params as { path?: string } | undefined)?.path;
      if (path === 'DMT_Project.getCurrentProjectInfo') return { result: { uuid: projectId } };
      if (path === 'DMT_SelectControl.getCurrentDocumentInfo')
        return {
          result: { uuid: pcbUuid, parentProjectUuid: projectId, documentType: 3 },
        };
      throw new Error('unexpected native identity lookup');
    }
    return read(method, params);
  }) as typeof ctx.bridge.call;
}

describe('optional source-aware manufacturing profile on existing production review', () => {
  it('is read-only, compares declared constraints, and never returns fabrication approval', async () => {
    const { tool, ctx, bridge } = setup();
    expect(tool).toMatchObject({
      name: 'easyeda_pcb_production_review',
      confirmWrite: false,
      annotations: { readOnlyHint: true },
    });
    const response = await tool.handler(ctx, {
      projectId: 'pcb-example',
      gateMode: 'block',
      manufacturerProfile,
      boardData: {
        widthMm: 50,
        minDrillMm: 0.2,
        toolingHoleCount: 0,
        criticalNetNames: ['GND', '3V3'],
        testPointNets: ['GND'],
        hasProgrammingHeader: false,
      },
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      project_id: 'pcb-example',
      passed: false,
      blocked: true,
      gate_mode: 'block',
      manufacturing_approval: false,
      manufacturing_profile_review: {
        status: 'WARNING',
        manual_review_required: true,
        fabrication_approval: false,
        input_evidence: 'caller_supplied_unverified',
      },
    });
    expect(response.manufacturing_profile_review.findings).toContainEqual(
      expect.objectContaining({
        id: 'minimumFinishedDrillMm',
        actual: 0.2,
        declared_limit: 0.3,
        status: 'WARNING',
      }),
    );
    expect(response.manufacturing_profile_review.findings).toContainEqual(
      expect.objectContaining({
        id: 'maximumBoardWidthMm',
        status: 'UNKNOWN',
        comparison: 'WITHIN_DECLARED_LIMIT',
      }),
    );
    expect(tool.outputSchema.parse(response)).toEqual(response);
  });

  it('does not call native bridge or manufacture a pass from an empty caller board summary', async () => {
    const { tool, ctx, bridge } = setup();
    const result = await tool.handler(ctx, {
      projectId: 'pcb-empty',
      manufacturerProfile,
      boardData: {},
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.manufacturing_profile_review.status).toBe('UNKNOWN');
    expect(
      result.manufacturing_profile_review.findings.every(
        (entry: { comparison: string }) => entry.comparison === 'UNKNOWN',
      ),
    ).toBe(true);
    expect(result.manufacturing_profile_review.unknown_workflows.join(' ')).toMatch(
      /mounting-hole semantics/i,
    );
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('validates source-bound trace/space limits, signed overlap and output provenance', async () => {
    const { tool, ctx, bridge } = setup();
    const params = {
      projectId: 'hypothetical-traces',
      gateMode: 'block',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { minimumTraceWidthMm: 0.15, minimumTrackGapMm: 0.12 },
      },
      boardData: {
        minObservedTraceWidthMm: 0.1,
        minObservedCopperGapMm: -0.04,
      },
    };
    expect(tool.inputSchema.safeParse(params).success).toBe(true);
    const result = await tool.handler(ctx, params);
    expect(bridge).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.manufacturing_profile_review).toMatchObject({
      status: 'WARNING',
      fabrication_approval: false,
      input_evidence: 'caller_supplied_unverified',
      findings: [
        {
          id: 'minimumTraceWidthMm',
          actual: 0.1,
          comparison: 'BELOW_DECLARED_LIMIT',
          measurement_evidence: 'caller_supplied_unverified',
        },
        {
          id: 'minimumTrackGapMm',
          actual: -0.04,
          comparison: 'BELOW_DECLARED_LIMIT',
          measurement_evidence: 'caller_supplied_unverified',
        },
      ],
    });
    expect(tool.outputSchema.parse(result)).toEqual(result);

    for (const invalid of [
      { ...params, boardData: { minObservedCopperGapMm: Number.NEGATIVE_INFINITY } },
      { ...params, boardData: { minObservedCopperGapMm: -10001 } },
      {
        ...params,
        manufacturerProfile: {
          ...params.manufacturerProfile,
          limits: { minimumTrackGapMm: -0.1 },
        },
      },
      {
        ...params,
        manufacturerProfile: {
          ...params.manufacturerProfile,
          limits: { minimumTraceWidthMm: Number.NaN },
        },
      },
    ]) {
      expect(tool.inputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('does not invent native trace/space minima from a sparse board summary', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    bridge.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { hasOutline: true, widthMm: 30, minObservedTraceWidthMm: 0.03 };
      if (method === 'board.listLayers') return [];
      return {};
    });
    setNativeFocus(ctx, 'native-traces-not-proven');
    const result = await tool.handler(ctx, {
      projectId: 'native-traces-not-proven',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { minimumTraceWidthMm: 0.1, minimumTrackGapMm: 0.1 },
      },
    });
    expect(bridge).toHaveBeenCalledTimes(4);
    expect(result.manufacturing_profile_review.findings).toEqual([
      expect.objectContaining({
        id: 'minimumTraceWidthMm',
        measurement_evidence: 'unavailable',
        comparison: 'UNKNOWN',
        status: 'UNKNOWN',
      }),
      expect.objectContaining({
        id: 'minimumTrackGapMm',
        measurement_evidence: 'unavailable',
        comparison: 'UNKNOWN',
        status: 'UNKNOWN',
      }),
    ]);
    expect(
      result.manufacturing_profile_review.findings.every(
        (finding: { actual?: number }) => finding.actual === undefined,
      ),
    ).toBe(true);
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('uses only sparse native board summary and does not infer holes/assembly completeness', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    bridge.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return {
          widthMm: 50,
          heightMm: 40,
          minDrillMm: 0.762,
          drilledPadCount: 5,
          unknownFields: ['mounting_hole_count'],
        };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [] };
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected method ' + method);
    });
    setNativeFocus(ctx, 'focused-native');
    const result = await tool.handler(ctx, {
      projectId: 'focused-native',
      manufacturerProfile,
    });
    expect(bridge).toHaveBeenCalledTimes(4);
    expect(result.manufacturing_profile_review.input_evidence).toBe('native_partial_unverified');
    expect(
      result.manufacturing_profile_review.findings.find(
        (entry: { id: string }) => entry.id === 'minimumToolingHoleCount',
      ),
    ).toMatchObject({ status: 'UNKNOWN', comparison: 'UNKNOWN' });
    expect(
      result.manufacturing_profile_review.findings.find(
        (entry: { id: string }) => entry.id === 'minimumFinishedDrillMm',
      ),
    ).toMatchObject({ status: 'UNKNOWN', comparison: 'WITHIN_DECLARED_LIMIT' });
    expect(result.passed).toBe(false);
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('keeps existing output shape and legacy gate behavior when no profile is requested', async () => {
    const { tool, ctx } = setup();
    const result = await tool.handler(ctx, {
      projectId: 'legacy',
      gateMode: 'warn',
      boardData: { hasOutline: false },
    });
    expect(result.manufacturing_profile_review).toBeUndefined();
    expect(result.manufacturing_approval).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(false);
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('refuses a different focused project before reading any manufacturing measurements', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    setNativeFocus(ctx, 'some-other-project');
    const response = await tool.handler(ctx, {
      projectId: 'user-requested-project',
      gateMode: 'block',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { maximumBoardWidthMm: 100, minimumFinishedDrillMm: 0.3 },
      },
    });
    expect(response.native_focus_status).toBe('wrong_project');
    expect(bridge).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      passed: false,
      blocked: true,
      manufacturing_approval: false,
      manufacturing_profile_review: { status: 'UNKNOWN', fabrication_approval: false },
    });
    expect(response.manufacturing_profile_review.findings).toEqual([
      expect.objectContaining({ id: 'minimumFinishedDrillMm', status: 'UNKNOWN' }),
      expect.objectContaining({ id: 'maximumBoardWidthMm', status: 'UNKNOWN' }),
    ]);
    expect(tool.outputSchema.parse(response)).toEqual(response);
  });

  it('fails closed when native project or document identity is unavailable', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    bridge.mockResolvedValue(undefined);
    const response = await tool.handler(ctx, {
      projectId: 'unknown-focus',
      gateMode: 'block',
      manufacturerProfile,
    });
    expect(response.native_focus_status).toBe('unavailable');
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(response.passed).toBe(false);
    expect(response.blocked).toBe(true);
    expect(
      response.manufacturing_profile_review.findings.every(
        (finding: { actual?: number }) => finding.actual === undefined,
      ),
    ).toBe(true);
  });

  it('refuses a schematic tab or a PCB belonging to a different project', async () => {
    for (const document of [
      { uuid: 'schematic-tab', parentProjectUuid: 'requested', documentType: 1 },
      { uuid: 'foreign-pcb', parentProjectUuid: 'foreign', documentType: 3 },
    ]) {
      const { tool, ctx, bridge } = setup();
      ctx.bridge.connected = true;
      ctx.bridge.call = (async (method: string, params?: unknown) => {
        if (method !== 'api.call') return bridge(method, params);
        const path = (params as { path: string }).path;
        if (path === 'DMT_Project.getCurrentProjectInfo') return { result: { uuid: 'requested' } };
        if (path === 'DMT_SelectControl.getCurrentDocumentInfo') return { result: document };
        throw new Error('unexpected native method');
      }) as typeof ctx.bridge.call;
      const result = await tool.handler(ctx, {
        projectId: 'requested',
        manufacturerProfile,
        gateMode: 'block',
      });
      expect(result.native_focus_status).toBe('unavailable');
      expect(result.passed).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.manufacturing_approval).toBe(false);
      expect(bridge).not.toHaveBeenCalled();
      expect(
        result.manufacturing_profile_review.findings.every(
          (finding: { actual?: number }) => finding.actual === undefined,
        ),
      ).toBe(true);
      expect(tool.outputSchema.parse(result)).toEqual(result);
    }
  });

  it('fails closed when a required beta native focus API rejects the request', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    ctx.bridge.call = (async (method: string, params?: unknown) => {
      if (method === 'api.call') throw new Error('unsupported native focus getter');
      return bridge(method, params);
    }) as typeof ctx.bridge.call;
    const result = await tool.handler(ctx, {
      projectId: 'native-method-unavailable',
      gateMode: 'block',
      manufacturerProfile,
    });
    expect(result.native_focus_status).toBe('unavailable');
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.manufacturing_approval).toBe(false);
    expect(bridge).not.toHaveBeenCalled();
    expect(
      result.manufacturing_profile_review.findings.every(
        (finding: { measurement_evidence: string }) =>
          finding.measurement_evidence === 'unavailable',
      ),
    ).toBe(true);
  });

  it('discards native metrics if the focused project changes between measurements', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    let currentProject = 'initial-project';
    ctx.bridge.call = (async (method: string, params?: unknown) => {
      if (method === 'api.call') {
        const nativePath = (params as { path: string }).path;
        if (nativePath === 'DMT_Project.getCurrentProjectInfo')
          return { result: { uuid: currentProject } };
        if (nativePath === 'DMT_SelectControl.getCurrentDocumentInfo')
          return {
            result: {
              uuid: 'unchanged-pcb-name',
              parentProjectUuid: currentProject,
              documentType: 3,
            },
          };
      }
      return bridge(method, params);
    }) as typeof ctx.bridge.call;
    bridge.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') {
        currentProject = 'other-project';
        return { hasOutline: true, widthMm: 150, heightMm: 45 };
      }
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return {};
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected board read');
    });
    const result = await tool.handler(ctx, {
      projectId: 'initial-project',
      gateMode: 'block',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { maximumBoardWidthMm: 100 },
      },
    });
    expect(result.native_focus_status).toBe('changed');
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.manufacturing_profile_review.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      comparison: 'UNKNOWN',
      measurement_evidence: 'unavailable',
    });
    expect(result.manufacturing_profile_review.findings[0].actual).toBeUndefined();
    expect(bridge).toHaveBeenCalledTimes(4);
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('throws away measured dimensions if the focused PCB changes while reads are pending', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    let focusedPcbUuid = 'pcb-original';
    const requestProject = 'requested-native-project';
    ctx.bridge.call = (async (method: string, params?: unknown) => {
      if (method === 'api.call') {
        const path = (params as { path?: string }).path;
        if (path === 'DMT_Project.getCurrentProjectInfo')
          return { result: { uuid: requestProject } };
        if (path === 'DMT_SelectControl.getCurrentDocumentInfo')
          return {
            result: {
              uuid: focusedPcbUuid,
              parentProjectUuid: requestProject,
              documentType: 3,
            },
          };
      }
      return bridge(method, params);
    }) as typeof ctx.bridge.call;
    bridge.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') {
        // The old PCB reports an apparent width violation; focus shifts after this read.
        focusedPcbUuid = 'pcb-replaced';
        return { hasOutline: true, widthMm: 150, heightMm: 40 };
      }
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { available: false, totalLayers: 2 };
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected native method');
    });
    const response = await tool.handler(ctx, {
      projectId: requestProject,
      gateMode: 'block',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { maximumBoardWidthMm: 100 },
      },
    });
    expect(response.native_focus_status).toBe('changed');
    expect(bridge).toHaveBeenCalledTimes(4);
    expect(response).toMatchObject({
      passed: false,
      blocked: true,
      manufacturing_approval: false,
      manufacturing_profile_review: { status: 'UNKNOWN' },
    });
    expect(response.manufacturing_profile_review.findings[0]).toMatchObject({
      id: 'maximumBoardWidthMm',
      status: 'UNKNOWN',
      comparison: 'UNKNOWN',
      measurement_evidence: 'unavailable',
    });
    expect(response.manufacturing_profile_review.findings[0].actual).toBeUndefined();
    expect(response.warnings).toEqual([]);
    expect(tool.outputSchema.parse(response)).toEqual(response);
  });

  it('reports stable focused source measurements and continues requiring factory review', async () => {
    const { tool, ctx, bridge } = setup();
    ctx.bridge.connected = true;
    setNativeFocus(ctx, 'correct-project', 'pcb-unchanged');
    bridge.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { hasOutline: true, widthMm: 112.014, heightMm: 67.31 };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, available: false };
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected native method');
    });
    const response = await tool.handler(ctx, {
      projectId: 'correct-project',
      gateMode: 'block',
      manufacturerProfile: {
        ...manufacturerProfile,
        limits: { maximumBoardWidthMm: 100, minimumFinishedDrillMm: 0.3 },
      },
    });
    expect(response.native_focus_status).toBe('verified');
    expect(bridge).toHaveBeenCalledTimes(4);
    expect(response.manufacturing_profile_review.findings).toEqual([
      expect.objectContaining({ id: 'minimumFinishedDrillMm', status: 'UNKNOWN' }),
      expect.objectContaining({
        id: 'maximumBoardWidthMm',
        status: 'WARNING',
        comparison: 'ABOVE_DECLARED_LIMIT',
        actual: 112.014,
      }),
    ]);
    expect(response.passed).toBe(false);
    expect(response.manufacturing_approval).toBe(false);
    expect(tool.outputSchema.parse(response)).toEqual(response);
  });

  it('validates source identity, finite limits, normalized bounds, and refuses empty profiles', () => {
    const { tool } = setup();
    const invalid = [
      { ...manufacturerProfile, manufacturer: '' },
      { ...manufacturerProfile, revision: '' },
      { ...manufacturerProfile, source: '' },
      { ...manufacturerProfile, limits: {} },
      { ...manufacturerProfile, limits: { minimumFinishedDrillMm: 0 } },
      { ...manufacturerProfile, limits: { maximumBoardWidthMm: Infinity } },
      { ...manufacturerProfile, limits: { minimumFiducialCount: 1.5 } },
      { ...manufacturerProfile, limits: { minimumCriticalNetTestpointRatio: 1.1 } },
      { ...manufacturerProfile, limits: { requireProgrammingHeader: false } },
    ];
    for (const manufacturerProfile of invalid) {
      expect(
        tool.inputSchema.safeParse({
          projectId: 'test',
          manufacturerProfile,
        }).success,
      ).toBe(false);
    }
    expect(
      tool.inputSchema.safeParse({
        projectId: 'test',
        manufacturerProfile,
      }).success,
    ).toBe(true);
  });
});

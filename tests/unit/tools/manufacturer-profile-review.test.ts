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

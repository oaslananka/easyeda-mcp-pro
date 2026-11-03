import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerDesignRulesTools } from '../../../src/tools/L1_design_rules.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

type Fixture = {
  id: string;
  review: Record<string, unknown>;
  expected: { status: 'WARNING' | 'UNKNOWN' };
};
const cases = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/isolation-emc-cases.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];

function create() {
  const registry = new ToolRegistry();
  registerDesignRulesTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const tool = registry.get('easyeda_design_rules_lookup');
  if (!tool) throw new Error('Design rule lookup unavailable');
  const bridge = vi.fn();
  const context = {
    profile: 'core',
    bridge: { connected: false, call: bridge },
    config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as ToolContext;
  return { tool, context, bridge };
}

describe('source-declared insulation and EMC MCP lookup', () => {
  it('uses the existing read-only lookup tool, not a new tool or native editor mutation', async () => {
    const { tool, context, bridge } = create();
    expect(tool).toMatchObject({
      name: 'easyeda_design_rules_lookup',
      risk: 'low',
      confirmWrite: false,
    });
    expect(tool.annotations.readOnlyHint).toBe(true);
    const response = await tool.handler(context, {
      topic: 'isolation-emc-review',
      review: cases[1]!.review,
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      topic: 'isolation-emc-review',
      isolationEmcReview: {
        status: 'WARNING',
        safety_certification: false,
        qualified_review_required: true,
        engineering_sign_off: false,
      },
    });
    expect(tool.outputSchema.parse(response)).toEqual(response);
    const findings = response.isolationEmcReview.findings;
    expect(findings).toContainEqual(
      expect.objectContaining({
        id: 'AIR_CLEARANCE',
        status: 'WARNING',
        reported_mm: 2,
        declared_min_mm: 3,
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        id: 'SURFACE_CREEPAGE',
        status: 'UNKNOWN',
      }),
    );
  });

  it.each(cases)(
    '$id supports source-declared observations in the MCP contract',
    async ({ review, expected }) => {
      const { tool, context, bridge } = create();
      const input = { topic: 'isolation-emc-review', review };
      expect(tool.inputSchema.safeParse(input).success).toBe(true);
      const result = await tool.handler(context, input);
      expect(result.isolationEmcReview.status).toBe(expected.status);
      expect(result.isolationEmcReview.safety_certification).toBe(false);
      expect(tool.outputSchema.parse(result)).toEqual(result);
      expect(bridge).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid voltages, distances and incomplete standard/provenance references', async () => {
    const { tool, context } = create();
    const ref = {
      identifier: 'IEC 60664-1',
      edition: '2020+AMD1:2025',
      clause: 'example only',
      source: 'caller-specified hypothetical design requirement',
    };
    const invalid = [
      { workingVoltageV: -1 },
      { transientVoltageV: Infinity },
      { altitudeM: -20 },
      { altitudeM: 30000 },
      { pollutionDegree: 5 },
      { overvoltageCategory: 'V' },
      {
        airClearance: {
          distanceMm: -1,
          evidenceRef: 'test observation',
          evidenceKind: 'measured_air_gap',
        },
      },
      { creepageRequirement: { minimumMm: 0, reference: ref } },
      { creepageRequirement: { minimumMm: 1, reference: { ...ref, edition: '' } } },
      { creepageRequirement: { minimumMm: 1, reference: { ...ref, source: '' } } },
      { esdEntry: { connectorRef: '' } },
    ];
    for (const review of invalid) {
      const input = { topic: 'isolation-emc-review', review };
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
      const result = await tool.handler(context, input);
      expect(result).toHaveProperty('error');
      expect(result).not.toHaveProperty('isolationEmcReview');
    }
    expect(tool.inputSchema.safeParse({ topic: 'isolation-emc-review' }).success).toBe(false);
  });

  it('does not change the existing clearance lookup contract', async () => {
    const { tool, context } = create();
    const result = await tool.handler(context, {
      topic: 'clearance',
      voltageV: 12,
      location: 'external',
    });
    expect(result.topic).toBe('clearance');
    expect(result.clearance.minClearanceMm).toBeGreaterThan(0);
    expect(result.isolationEmcReview).toBeUndefined();
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });
});

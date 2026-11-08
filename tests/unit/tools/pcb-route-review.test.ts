import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerPcbRouteReviewTools } from '../../../src/tools/L1_pcb_route_review.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

describe('native PCB route geometry review MCP contract', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPcbRouteReviewTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn(async (method: string) => {
      if (method === 'pcb.listTracks') {
        return {
          total: 2,
          items: [
            {
              primitiveId: 'track-a',
              net: 'CLK',
              layer: 1,
              startX: 0,
              startY: 0,
              endX: 100,
              endY: 0,
              width: 4,
            },
            {
              primitiveId: 'track-b',
              net: 'CLK',
              layer: 1,
              startX: 100,
              startY: 0,
              endX: 100,
              endY: 100,
              width: 8,
            },
          ],
        };
      }
      if (method === 'pcb.listVias') {
        return {
          total: 1,
          items: [
            { primitiveId: 'via-1', net: 'CLK', x: 100, y: 100, holeDiameter: 10, diameter: 30 },
          ],
        };
      }
      throw new Error('unexpected bridge method: ' + method);
    });
    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
        easyedaVersion: '3.2.209',
        extensionVersion: '1.8.1',
        registryMismatch: false,
        extensionVersionMismatch: false,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
        bridgeHost: '127.0.0.1',
        bridgePort: 49620,
      },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  async function run(options: Record<string, unknown> = {}) {
    const tool = registry.get('easyeda_pcb_route_geometry_review');
    if (!tool) throw Error('missing route tool');
    const result = await tool.handler(context, { projectId: 'project-1', ...options });
    expect(tool.outputSchema.parse(result)).toEqual(result);
    return result as any;
  }

  it('is core and strictly read-only with no mutation approval bypass', () => {
    const tool = registry.get('easyeda_pcb_route_geometry_review');
    expect(tool).toMatchObject({
      profile: 'core',
      risk: 'low',
      sideEffect: 'read-only',
      confirmWrite: false,
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(tool?.inputSchema.safeParse({ projectId: ' project-1 ' }).success).toBe(false);
    expect(tool?.inputSchema.safeParse({ projectId: '' }).success).toBe(false);
    expect(tool?.inputSchema.safeParse({ projectId: 'project-1', minWidthMm: -1 }).success).toBe(
      false,
    );
  });

  it('validates and evaluates a caller-declared minimum copper clearance without extra reads', async () => {
    const tool = registry.get('easyeda_pcb_route_geometry_review');
    for (const value of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, '0.1']) {
      expect(
        tool?.inputSchema.safeParse({ projectId: 'project-1', minClearanceMm: value }).success,
      ).toBe(false);
    }
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 2,
            items: [
              {
                primitiveId: 'a',
                net: 'CLK',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 100,
                endY: 0,
                width: 10,
              },
              {
                primitiveId: 'b',
                net: 'GND',
                layer: 1,
                startX: 0,
                startY: 13,
                endX: 100,
                endY: 13,
                width: 10,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run({ minClearanceMm: 0.1 });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'TRACE_CLEARANCE_BELOW_CONTEXT_MINIMUM',
        status: 'WARNING',
        primitive_ids: ['a', 'b'],
        net: 'CLK',
        other_net: 'GND',
        threshold_mm: 0.1,
      }),
    );
    expect(result.overall_status).toBe('WARNING');
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule_id: 'COPPER_CLEARANCE_UNVERIFIED', status: 'UNKNOWN' }),
    );
    expect(result.engineering_sign_off).toBe(false);
    expect(bridgeCall.mock.calls).toEqual([
      ['pcb.listTracks', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listVias', { projectId: 'project-1', limit: 200, offset: 0 }],
    ]);
  });

  it('reads only a bounded active-project list of tracks and vias', async () => {
    const result = await run({ intent: 'high-speed', minWidthMm: 0.2 });
    expect(bridgeCall.mock.calls).toEqual([
      ['pcb.listTracks', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listVias', { projectId: 'project-1', limit: 200, offset: 0 }],
    ]);
    expect(result.project_id).toBe('project-1');
    expect(result.runtime).toMatchObject({ bridge_connected: true, registry_mismatch: false });
    expect(result.coordinate_unit).toBe('mil');
    expect(result.coverage).toMatchObject({
      requested_track_count: 2,
      returned_track_count: 2,
      requested_via_count: 1,
      returned_via_count: 1,
      findings_truncated: false,
    });
    expect(result.input_evidence).toMatchObject({
      tracks: 'observed',
      vias: 'observed',
      collection_complete: true,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM',
        status: 'WARNING',
        primitive_ids: ['track-a'],
        net: 'CLK',
        width_mm: 0.1016,
        threshold_mm: 0.2,
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'RIGHT_ANGLE_STYLE_REVIEW',
        status: 'ADVISORY',
        net: 'CLK',
        primitive_ids: ['track-a', 'track-b'],
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'REFERENCE_PLANE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });

  it('reads all tracks and vias across native 200-row pages when within a bounded budget', async () => {
    const tracks = Array.from({ length: 435 }, (_, i) => ({
      primitiveId: `track-${i}`,
      net: 'N',
      layer: 1,
      startX: i * 100,
      startY: 0,
      endX: i * 100 + 40,
      endY: 0,
      width: 10,
    }));
    const vias = Array.from({ length: 215 }, (_, i) => ({
      primitiveId: `via-${i}`,
      net: 'N',
      x: i * 100,
      y: 50,
      holeDiameter: 10,
      diameter: 30,
    }));
    bridgeCall.mockImplementation(
      async (method: string, params: { limit: number; offset: number }) => {
        const rows = method === 'pcb.listTracks' ? tracks : vias;
        return {
          total: rows.length,
          items: rows.slice(params.offset, params.offset + params.limit),
        };
      },
    );

    const result = await run();
    expect(result.input_evidence.collection_complete).toBe(true);
    expect(result.coverage).toMatchObject({
      requested_track_count: 435,
      returned_track_count: 435,
      requested_via_count: 215,
      returned_via_count: 215,
      findings_truncated: false,
    });
    expect(
      result.findings.some(
        (finding: { rule_id: string }) => finding.rule_id === 'NATIVE_COLLECTION_INCOMPLETE',
      ),
    ).toBe(false);
    expect(result.engineering_sign_off).toBe(false);
    expect(
      bridgeCall.mock.calls
        .filter(([method]) => method === 'pcb.listTracks')
        .map(([, args]) => args.offset),
    ).toEqual([0, 200, 400]);
    expect(
      bridgeCall.mock.calls
        .filter(([method]) => method === 'pcb.listVias')
        .map(([, args]) => args.offset),
    ).toEqual([0, 200]);
  });

  it('does not trust changing native totals between route pages', async () => {
    bridgeCall.mockImplementation(
      async (method: string, params: { limit: number; offset: number }) => {
        if (method === 'pcb.listVias') return { total: 0, items: [] };
        return {
          total: params.offset === 0 ? 201 : 202,
          items: Array.from({ length: params.offset === 0 ? 200 : 1 }, (_, i) => ({
            primitiveId: `t-${params.offset + i}`,
            net: 'GND',
            layer: 1,
            startX: i * 100,
            startY: 0,
            endX: i * 100 + 50,
            endY: 0,
            width: 8,
          })),
        };
      },
    );
    const result = await run();
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.input_evidence.tracks).toBe('unavailable');
    expect(result.errors).toEqual([expect.stringContaining('total changed across native pages')]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule_id: 'NATIVE_COLLECTION_INCOMPLETE', status: 'UNKNOWN' }),
    );
  });

  it('rejects native pages reporting fewer primitives than they actually return', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 1,
            items: [
              {
                primitiveId: 't1',
                net: 'N',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 30,
                endY: 0,
                width: 8,
              },
              {
                primitiveId: 't2',
                net: 'N',
                layer: 1,
                startX: 40,
                startY: 0,
                endX: 70,
                endY: 0,
                width: 8,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run();
    expect(result.input_evidence).toMatchObject({
      tracks: 'unavailable',
      collection_complete: false,
    });
    expect(result.errors).toEqual([
      expect.stringContaining('native total is smaller than returned item count'),
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule_id: 'NATIVE_COLLECTION_INCOMPLETE', status: 'UNKNOWN' }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });

  it('stops at the route source budget without claiming the remainder was checked', async () => {
    bridgeCall.mockImplementation(
      async (method: string, params: { limit: number; offset: number }) => {
        if (method === 'pcb.listVias') return { total: 0, items: [] };
        return {
          total: 1201,
          items: Array.from({ length: params.limit }, (_, i) => ({
            primitiveId: `t-${params.offset + i}`,
            net: 'N',
            layer: 1,
            startX: (params.offset + i) * 100,
            startY: 0,
            endX: (params.offset + i) * 100 + 50,
            endY: 0,
            width: 10,
          })),
        };
      },
    );
    const result = await run();
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.coverage).toMatchObject({
      requested_track_count: 1201,
      returned_track_count: 1200,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule_id: 'NATIVE_COLLECTION_INCOMPLETE', status: 'UNKNOWN' }),
    );
    expect(bridgeCall.mock.calls.filter(([method]) => method === 'pcb.listTracks')).toHaveLength(6);
  });

  it('treats invalid native layer identifiers as unavailable through the MCP tool', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 2,
            items: [
              {
                primitiveId: 'valid',
                net: 'DATA+',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 100,
                endY: 0,
                width: 10,
              },
              {
                primitiveId: 'bad',
                net: 'GND',
                layer: -1,
                startX: 50,
                startY: -50,
                endX: 50,
                endY: 50,
                width: 2,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run({ minWidthMm: 0.2, intent: 'high-speed' });
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:bad:missing-geometry',
        rule_id: 'TRACK_GEOMETRY_UNAVAILABLE',
        status: 'UNKNOWN',
        primitive_ids: ['bad'],
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule_id: 'NATIVE_COLLECTION_INCOMPLETE', status: 'UNKNOWN' }),
    );
    expect(
      result.findings.some(
        (item: { primitive_ids: string[]; status: string }) =>
          item.primitive_ids.includes('bad') &&
          (item.status === 'WARNING' || item.status === 'ADVISORY'),
      ),
    ).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
    expect(bridgeCall).toHaveBeenCalledTimes(2);
  });

  it('reports actual different-net same-layer copper overlap from the existing read-only bridge', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 2,
            items: [
              {
                primitiveId: 'clk-1',
                net: 'CLK',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 100,
                endY: 0,
                width: 10,
              },
              {
                primitiveId: 'gnd-1',
                net: 'GND',
                layer: 1,
                startX: 50,
                startY: -50,
                endX: 50,
                endY: 50,
                width: 10,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run();
    expect(bridgeCall).toHaveBeenCalledTimes(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'OBSERVED_TRACK_COPPER_OVERLAP',
        status: 'WARNING',
        primitive_ids: ['clk-1', 'gnd-1'],
        net: 'CLK',
        other_net: 'GND',
        observed_edge_gap_mm: -0.254,
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'COPPER_CLEARANCE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });

  it('reports a bounded unverified multi-layer via endpoint candidate using existing native reads', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listTracks') {
        return {
          total: 2,
          items: [
            {
              primitiveId: 'a',
              net: 'CLK',
              layer: 1,
              startX: 0,
              startY: 0,
              endX: 100,
              endY: 0,
              width: 8,
            },
            {
              primitiveId: 'b',
              net: 'CLK',
              layer: 2,
              startX: 100,
              startY: 0,
              endX: 100,
              endY: 100,
              width: 8,
            },
          ],
        };
      }
      return {
        total: 1,
        items: [{ primitiveId: 'via', net: 'CLK', x: 100, y: 0, holeDiameter: 10, diameter: 30 }],
      };
    });
    const result = await run();
    expect(bridgeCall.mock.calls).toEqual([
      ['pcb.listTracks', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listVias', { projectId: 'project-1', limit: 200, offset: 0 }],
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_LAYER_TRANSITION_CANDIDATE',
        status: 'UNKNOWN',
        net: 'CLK',
        primitive_ids: ['a', 'b', 'via'],
        native_layers: [1, 2],
        position_mil: { x: 100, y: 0 },
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
  });

  it('does not invent a geometry PASS or warn on 90 degrees in general context', async () => {
    const result = await run();
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ rule_id: 'RIGHT_ANGLE_STYLE_REVIEW' }),
    );
    expect(result.findings.every((f: { status: string }) => f.status !== 'PASS')).toBe(true);
  });

  it('does not query native methods while disconnected', async () => {
    context.bridge.connected = false;
    const result = await run();
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result.errors).toEqual([expect.stringContaining('disconnected')]);
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
  });

  it('rejects incompatible extension identity before attempting any native reads', async () => {
    context.bridge.registryMismatch = true;
    context.bridge.extensionVersionMismatch = true;
    const result = await run({ minWidthMm: 0.2 });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result.errors).toEqual([expect.stringContaining('mismatches')]);
    expect(result.input_evidence.tracks).toBe('unavailable');
    expect(result.findings).toContainEqual(
      expect.objectContaining({ id: 'coverage:pagination', status: 'UNKNOWN' }),
    );
  });

  it('marks a focus/project-identity failure as unknown, not an empty healthy board', async () => {
    bridgeCall.mockRejectedValue(
      new Error('PCB project identity mismatch: requested UUID not focused'),
    );
    const result = await run();
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.input_evidence).toMatchObject({ tracks: 'unavailable', vias: 'unavailable' });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('project identity mismatch');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('preserves partial evidence when one native reader fails', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listTracks') throw new Error('unsupported native line getter');
      return {
        total: 1,
        items: [{ primitiveId: 'via-1', net: 'CLK', x: 10, y: 20, holeDiameter: 10, diameter: 8 }],
      };
    });
    const result = await run();
    expect(result.input_evidence).toMatchObject({
      tracks: 'unavailable',
      vias: 'observed',
      collection_complete: false,
    });
    expect(result.overall_status).toBe('WARNING');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_ANNULAR_GEOMETRY',
        status: 'WARNING',
      }),
    );
    expect(result.errors).toEqual([expect.stringContaining('unsupported native')]);
  });

  it('prevents a 201st native item from being represented as fully reviewed', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? { total: 201, items: [{ primitiveId: 't', width: 8 }] }
        : { total: 0, items: [] },
    );
    const result = await run();
    expect(result.coverage).toMatchObject({
      requested_track_count: 201,
      returned_track_count: 1,
    });
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'NATIVE_COLLECTION_INCOMPLETE',
        status: 'UNKNOWN',
      }),
    );
  });

  it('treats an invalid/oversized bridge response as unavailable evidence', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks' ? { total: -1, items: [] } : { total: 0, items: [] },
    );
    const result = await run();
    expect(result.input_evidence.tracks).toBe('unavailable');
    expect(result.errors).toHaveLength(1);
    expect(result.overall_status).toBe('UNKNOWN');
  });

  it('does not treat empty native getters as verified geometry', async () => {
    bridgeCall.mockResolvedValue({ total: 0, items: [] });
    const result = await run();
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'coverage:tracks',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'coverage:planes',
        status: 'UNKNOWN',
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });
  const pairDeclaration = {
    positiveNet: 'USB_D+',
    negativeNet: 'USB_D-',
    protocol: 'usb2',
    maxSkewMm: 0.6,
    minEdgeGapMm: 0.2,
    maxEdgeGapMm: 0.3,
  } as const;

  it('validates distinct explicitly named pairs and device-specific numerical constraints', () => {
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    expect(
      schema?.safeParse({ projectId: 'project-1', differentialPair: pairDeclaration }).success,
    ).toBe(true);
    for (const pair of [
      { ...pairDeclaration, negativeNet: pairDeclaration.positiveNet },
      { ...pairDeclaration, maxSkewMm: -0.1 },
      { ...pairDeclaration, minEdgeGapMm: 3, maxEdgeGapMm: 2 },
      { ...pairDeclaration, targetImpedanceOhms: 0 },
      { ...pairDeclaration, protocol: 'i2c' },
      { ...pairDeclaration, positiveNet: '' },
      { ...pairDeclaration, positiveNet: ' USB_D+ ' },
    ]) {
      expect(schema?.safeParse({ projectId: 'project-1', differentialPair: pair }).success).toBe(
        false,
      );
    }
  });

  it('carries optional datasheet provenance without mistaking a protocol reference for a device limit', async () => {
    const source = 'Hypothetical part Rev B, Section 3 - example only';
    const params = {
      ...pairDeclaration,
      constraintSource: source,
    };
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    expect(schema?.safeParse({ projectId: 'project-1', differentialPair: params }).success).toBe(
      true,
    );
    for (const invalid of ['', ' ', 'x'.repeat(201)]) {
      expect(
        schema?.safeParse({
          projectId: 'project-1',
          differentialPair: { ...params, constraintSource: invalid },
        }).success,
      ).toBe(false);
    }
    const result = await run({ differentialPair: params });
    expect(result.differential_pair.constraint_source).toBe(source);
    expect(result.differential_pair.protocol_guidance.source).not.toEqual(source);
    const oldClient = await run({ differentialPair: pairDeclaration });
    expect(oldClient.differential_pair.constraint_source).toBeNull();
  });

  it('checks observed parallel differential pair without imposing USB reference thresholds', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listTracks') {
        return {
          total: 2,
          items: [
            {
              primitiveId: 'p1',
              net: 'USB_D+',
              layer: 1,
              startX: 0,
              startY: 0,
              endX: 1000,
              endY: 0,
              width: 10,
            },
            {
              primitiveId: 'n1',
              net: 'USB_D-',
              layer: 1,
              startX: 0,
              startY: 20,
              endX: 1020,
              endY: 20,
              width: 10,
            },
          ],
        };
      }
      return { total: 0, items: [] };
    });
    const result = await run({ differentialPair: pairDeclaration });
    expect(bridgeCall.mock.calls).toEqual([
      ['pcb.listTracks', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listVias', { projectId: 'project-1', limit: 200, offset: 0 }],
    ]);
    expect(result.differential_pair.paths.positive.coverage).toBe('OBSERVED_SINGLE_CHAIN');
    expect(result.differential_pair.skew).toMatchObject({
      status: 'WITHIN_DECLARED_LIMIT_REFERENCE',
      declared_limit_mm: 0.6,
    });
    expect(result.differential_pair.spacing).toMatchObject({
      status: 'WITHIN_DECLARED_LIMIT_REFERENCE',
      sample_count: 1,
    });
    expect(result.differential_pair.impedance_status).toBe('UNKNOWN');
    expect(result.differential_pair.protocol_guidance.differential_impedance_reference_ohms).toBe(
      90,
    );
    expect(result.differential_pair.engineering_sign_off).toBe(false);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
  });

  it('surfaces a geometry-warning for skew above explicit per-device limit', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 2,
            items: [
              {
                primitiveId: 'p1',
                net: 'USB_D+',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 1000,
                endY: 0,
                width: 10,
              },
              {
                primitiveId: 'n1',
                net: 'USB_D-',
                layer: 1,
                startX: 0,
                startY: 20,
                endX: 1100,
                endY: 20,
                width: 10,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run({
      differentialPair: { ...pairDeclaration, maxSkewMm: 1 },
    });
    expect(result.overall_status).toBe('WARNING');
    expect(result.differential_pair.skew.status).toBe('WARNING');
    expect(result.differential_pair.findings).toContainEqual(
      expect.objectContaining({
        id: 'pair:skew',
        status: 'WARNING',
        primitive_ids: ['p1', 'n1'],
      }),
    );
    expect(result.differential_pair.impedance_status).toBe('UNKNOWN');
  });

  it('does not compute a skew verdict when one declared net is missing', async () => {
    const result = await run({ differentialPair: pairDeclaration });
    expect(result.differential_pair.paths.positive.coverage).toBe('MISSING');
    expect(result.differential_pair.paths.negative.coverage).toBe('MISSING');
    expect(result.differential_pair.skew.status).toBe('UNKNOWN');
    expect(result.differential_pair.status).toBe('WARNING');
  });

  it('fails closed for disconnected or mismatched native sources without additional reads', async () => {
    context.bridge.connected = false;
    const disconnected = await run({ differentialPair: pairDeclaration });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(disconnected.differential_pair.paths.positive.coverage).toBe('UNAVAILABLE');
    expect(disconnected.differential_pair.status).toBe('UNKNOWN');
    context.bridge.connected = true;
    context.bridge.registryMismatch = true;
    const mismatch = await run({ differentialPair: pairDeclaration });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(mismatch.differential_pair.paths.negative.coverage).toBe('UNAVAILABLE');
    expect(mismatch.differential_pair.impedance_status).toBe('UNKNOWN');
  });

  it('does not mistake a paginated partial project for a missing negative pair', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listTracks'
        ? {
            total: 201,
            items: [
              {
                primitiveId: 'p1',
                net: 'USB_D+',
                layer: 1,
                startX: 0,
                startY: 0,
                endX: 100,
                endY: 0,
                width: 10,
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const result = await run({ differentialPair: pairDeclaration });
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.differential_pair.paths.positive.coverage).toBe('UNAVAILABLE');
    expect(result.differential_pair.paths.negative.coverage).toBe('UNAVAILABLE');
    expect(result.differential_pair.status).toBe('UNKNOWN');
  });

  it('supports custom differential pairs without inventing LVDS or Ethernet impedance', async () => {
    const result = await run({
      differentialPair: {
        positiveNet: 'LVDS_P',
        negativeNet: 'LVDS_N',
        protocol: 'custom',
        targetImpedanceOhms: 100,
      },
    });
    expect(result.differential_pair.protocol_guidance).toBeNull();
    expect(result.differential_pair.target_impedance_ohms).toBe(100);
    expect(result.differential_pair.impedance_status).toBe('UNKNOWN');
  });
  const placement = {
    first: 'U1',
    second: 'C1',
    kind: 'decoupling',
    maxCenterDistanceMm: 2,
    constraintSource: 'Hypothetical device-specific datasheet layout note',
  } as const;

  it('accepts only bounded, explicitly sourced placement constraints', () => {
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    expect(
      schema?.safeParse({ projectId: 'project-1', placementRelations: [placement] }).success,
    ).toBe(true);
    for (const relation of [
      { ...placement, second: 'U1' },
      { ...placement, maxCenterDistanceMm: -1 },
      { ...placement, constraintSource: undefined },
      { ...placement, first: ' U1 ' },
      { ...placement, rotationToleranceDeg: 10 },
      { ...placement, kind: 'fictional-rule' },
    ]) {
      expect(
        schema?.safeParse({ projectId: 'project-1', placementRelations: [relation] }).success,
      ).toBe(false);
    }
    expect(schema?.safeParse({ projectId: 'project-1', placementRelations: [] }).success).toBe(
      false,
    );
    expect(
      schema?.safeParse({
        projectId: 'project-1',
        placementRelations: Array.from({ length: 9 }, () => placement),
      }).success,
    ).toBe(false);
  });

  const placementPadPair = {
    first: 'U3',
    second: 'C5',
    kind: 'decoupling',
    constraintSource: 'Real Z480 schematic supply-net declaration, no generic distance limit',
    padPairs: [{ firstPin: '8', secondPin: '1', expectedNet: 'VCC' }],
  } as const;

  function mockNativePlacementPads(
    overrides: {
      projectId?: string;
      secondNet?: string;
      firstParent?: string;
      failPad?: string;
      switchFocusAfterPads?: boolean;
      throwOnFocusRecheck?: boolean;
      extraUnrelatedComponent?: boolean;
      tracks?: Array<Record<string, unknown>>;
      nativeContacts?: boolean;
      switchPcbDuringContacts?: boolean;
    } = {},
  ) {
    const components = [
      { primitiveId: 'native-u3', designator: 'U3', x: 100, y: 0, layer: 1 },
      { primitiveId: 'native-c5', designator: 'C5', x: 0, y: 0, layer: 1 },
      ...(overrides.extraUnrelatedComponent
        ? [{ primitiveId: 'native-z9', designator: 'Z9', x: 200, y: 200, layer: 1 }]
        : []),
    ];
    let focusChecks = 0;
    let nativeContactReads = 0;
    bridgeCall.mockImplementation(async (method: string, args: any) => {
      if (method === 'pcb.listVias') return { total: 0, items: [] };
      if (method === 'pcb.listTracks') {
        const tracks = overrides.tracks ?? [];
        return { total: tracks.length, items: tracks };
      }
      if (method === 'pcb.listComponents') return { total: components.length, items: components };
      if (method === 'pcb.listComponentPadConnections') {
        nativeContactReads += 1;
        if (!overrides.nativeContacts) throw new Error('native getter unavailable');
        const first = args.componentPrimitiveId === 'native-u3';
        return {
          evidence: 'native_reported',
          componentPrimitiveId: args.componentPrimitiveId,
          padPrimitiveId: first ? 'native-u3/pad8' : 'native-c5/pad1',
          padNumber: args.padNumber,
          net: 'VCC',
          connected: [
            {
              primitiveId: 'shared-trace',
              net: 'VCC',
              nativeType: 3,
              layer: 1,
            },
          ],
        };
      }
      if (method === 'api.read') {
        if (args.path === 'DMT_Project.getCurrentProjectInfo') {
          focusChecks++;
          if (overrides.throwOnFocusRecheck && focusChecks === 2)
            throw new Error('native project focus no longer available');
          return {
            result: {
              uuid:
                overrides.switchFocusAfterPads && focusChecks === 2
                  ? 'unrelated-project'
                  : (overrides.projectId ?? 'project-1'),
            },
          };
        }
        if (args.path === 'DMT_SelectControl.getCurrentDocumentInfo')
          return {
            result: {
              uuid:
                overrides.switchPcbDuringContacts && nativeContactReads > 0
                  ? 'other-pcb'
                  : 'focused-pcb',
              parentProjectUuid: 'project-1',
              documentType: 3,
            },
          };
        if (args.path === 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId') {
          if (args.args[0] === overrides.failPad) throw new Error('beta pad getter unavailable');
          const first = args.args[0] === 'native-u3';
          return {
            result: [
              {
                primitiveId: first ? 'native-u3/pad8' : 'native-c5/pad1',
                parentComponentPrimitiveId: first
                  ? (overrides.firstParent ?? 'native-u3')
                  : 'native-c5',
                padNumber: first ? '8' : '1',
                net: first ? 'VCC' : (overrides.secondNet ?? 'VCC'),
                x: first ? 100 : 0,
                y: 0,
                layer: 12,
              },
            ],
          };
        }
      }
      throw new Error('unexpected bridge call: ' + method);
    });
  }

  it('requires source-bound exact pad-pair declarations and rejects implicit limits', () => {
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    expect(
      schema?.safeParse({
        projectId: 'project-1',
        placementRelations: [placementPadPair],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...placementPadPair, constraintSource: undefined },
      { ...placementPadPair, padPairs: [] },
      { ...placementPadPair, padPairs: [{ firstPin: '', secondPin: '1', expectedNet: 'VCC' }] },
      { ...placementPadPair, padPairs: [{ firstPin: '8', secondPin: '1', expectedNet: ' VCC' }] },
      {
        ...placementPadPair,
        padPairs: [{ firstPin: '8', secondPin: '1', expectedNet: 'VCC', maxCenterDistanceMm: -1 }],
      },
      {
        ...placementPadPair,
        padPairs: Array.from({ length: 3 }, () => placementPadPair.padPairs[0]),
      },
    ]) {
      expect(
        schema?.safeParse({
          projectId: 'project-1',
          placementRelations: [invalid],
        }).success,
      ).toBe(false);
    }
  });

  it('uses real source-guarded native component pads only when specifically requested', async () => {
    mockNativePlacementPads();
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      electrical_loop_status: 'UNKNOWN',
      pad_pairs: [
        {
          first_pin: '8',
          second_pin: '1',
          native_first_net: 'VCC',
          native_second_net: 'VCC',
          measured_pad_center_distance_mm: 2.54,
          native_pad_layer_codes: [12, 12],
          evidence: 'native_component_pads',
          status: 'UNKNOWN',
          electrical_loop_status: 'UNKNOWN',
        },
      ],
    });
    expect(result.engineering_sign_off).toBe(false);
    expect(bridgeCall).toHaveBeenCalledWith(
      'api.read',
      expect.objectContaining({
        path: 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId',
        args: ['native-u3'],
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it('includes bounded exact same-layer route endpoint chain evidence without electrical PASS', async () => {
    mockNativePlacementPads({
      tracks: [
        {
          primitiveId: 'trace-1',
          net: 'VCC',
          layer: 1,
          startX: 100,
          startY: 0,
          endX: 50,
          endY: 0,
          width: 10,
        },
        {
          primitiveId: 'trace-2',
          net: 'VCC',
          layer: 1,
          startX: 50,
          startY: 0,
          endX: 0,
          endY: 0,
          width: 10,
        },
      ],
    });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.findings[0].pad_pairs[0].route_chain).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      primitive_ids: ['trace-1', 'trace-2'],
      selection: 'fewest_segments',
      native_layer: 1,
      observed_centerline_length_mm: 2.54,
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(result.placement_review.findings[0].pad_pairs[0].electrical_loop_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
  });

  it('does not infer copper contact when one route primitive is invalid or changes net', async () => {
    for (const tracks of [
      [
        {
          primitiveId: 'wrong-net',
          net: 'GND',
          layer: 1,
          startX: 100,
          startY: 0,
          endX: 0,
          endY: 0,
          width: 10,
        },
      ],
      [
        {
          primitiveId: 'invalid-width',
          net: 'VCC',
          layer: 1,
          startX: 100,
          startY: 0,
          endX: 0,
          endY: 0,
          width: 0,
        },
      ],
    ]) {
      mockNativePlacementPads({ tracks });
      const result = await run({ placementRelations: [placementPadPair] });
      expect(result.placement_review.findings[0].pad_pairs[0].route_chain).toMatchObject({
        evidence: 'unavailable',
        electrical_continuity_status: 'UNKNOWN',
      });
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('opts into source-bound native reported pad associations with UNKNOWN electrical sign-off', async () => {
    mockNativePlacementPads({ nativeContacts: true });
    const without = await run({ placementRelations: [placementPadPair] });
    expect(
      without.placement_review.findings[0].pad_pairs[0].native_pad_associations,
    ).toBeUndefined();
    expect(bridgeCall.mock.calls.some(([m]) => m === 'pcb.listComponentPadConnections')).toBe(
      false,
    );

    mockNativePlacementPads({ nativeContacts: true });
    const result = await run({
      placementRelations: [placementPadPair],
      includeNativePadContacts: true,
    });
    expect(result.placement_review.findings[0].pad_pairs[0].native_pad_associations).toMatchObject({
      evidence: 'native_reported',
      shared_primitive_ids: ['shared-trace'],
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(result.placement_review.findings[0].pad_pairs[0].electrical_loop_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
    expect(
      bridgeCall.mock.calls.filter(([m]) => m === 'pcb.listComponentPadConnections'),
    ).toHaveLength(2);
  });

  it('fails closed on beta getter errors and focus changes during native association reads', async () => {
    for (const flags of [{}, { nativeContacts: true, switchPcbDuringContacts: true }]) {
      mockNativePlacementPads(flags);
      const result = await run({
        placementRelations: [placementPadPair],
        includeNativePadContacts: true,
      });
      expect(
        result.placement_review.findings[0].pad_pairs[0].native_pad_associations,
      ).toMatchObject({
        evidence: 'unavailable',
        electrical_continuity_status: 'UNKNOWN',
      });
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('bounds opt-in native contact reads and does not query them above four requested pairs', async () => {
    mockNativePlacementPads({ nativeContacts: true });
    const result = await run({
      placementRelations: Array.from({ length: 5 }, () => placementPadPair),
      includeNativePadContacts: true,
    });
    expect(result.engineering_sign_off).toBe(false);
    expect(
      result.placement_review.findings.every((relation: any) =>
        relation.pad_pairs?.every(
          (pair: any) => pair.native_pad_associations?.evidence === 'unavailable',
        ),
      ),
    ).toBe(true);
    expect(
      bridgeCall.mock.calls.some(([method]) => method === 'pcb.listComponentPadConnections'),
    ).toBe(false);
  });

  it('warns on native pad net mismatch, not a blanket distance default', async () => {
    mockNativePlacementPads({ secondNet: 'GND' });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.overall_status).toBe('WARNING');
    expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
      status: 'WARNING',
      native_second_net: 'GND',
      electrical_loop_status: 'UNKNOWN',
    });
  });

  it('fails closed for native project identity mismatch without reading component pads', async () => {
    mockNativePlacementPads({ projectId: 'other-project' });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'unavailable',
    });
    expect(result.errors.join(' ')).toContain('does not match');
    expect(
      bridgeCall.mock.calls.some(
        ([method, args]) =>
          method === 'api.read' && args.path === 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId',
      ),
    ).toBe(false);
  });

  it('fails closed when a beta pad getter is unavailable or has a different parent', async () => {
    for (const bad of [{ failPad: 'native-u3' }, { firstParent: 'different-component' }]) {
      mockNativePlacementPads(bad);
      const result = await run({ placementRelations: [placementPadPair] });
      expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'unavailable',
      });
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('reads only requested components in a complete inventory with unrelated placements', async () => {
    mockNativePlacementPads({ extraUnrelatedComponent: true });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.input_evidence).toMatchObject({
      native_total: 3,
      returned_count: 3,
      collection_complete: true,
    });
    expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'native_component_pads',
      measured_pad_center_distance_mm: 2.54,
    });
    expect(
      bridgeCall.mock.calls.filter(
        ([method, args]) =>
          method === 'api.read' && args.path === 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId',
      ),
    ).toHaveLength(2);
  });

  it('discards all native pad evidence if the focused PCB changes after pad reads', async () => {
    mockNativePlacementPads({ switchFocusAfterPads: true });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'unavailable',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.errors.join(' ')).toContain('changed during pad inventory');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('fails closed when native focus becomes unreadable during the post-read recheck', async () => {
    mockNativePlacementPads({ throwOnFocusRecheck: true });
    const result = await run({ placementRelations: [placementPadPair] });
    expect(result.placement_review.findings[0].pad_pairs[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'unavailable',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.errors.join(' ')).toContain('identity could not be verified');
    expect(result.errors.join(' ')).toContain('native project focus no longer available');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('validates second-component rotation provenance and reports native differences', async () => {
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    const relation = {
      first: 'J1',
      second: 'D1',
      kind: 'esd-entry',
      secondRotationDeg: 350,
      secondRotationToleranceDeg: 2,
      constraintSource: 'Example mechanical datasheet Rev B',
    };
    expect(
      schema?.safeParse({
        projectId: 'project-1',
        placementRelations: [relation],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...relation, secondRotationDeg: undefined },
      { ...relation, secondRotationToleranceDeg: 181 },
      { ...relation, constraintSource: undefined },
    ]) {
      expect(
        schema?.safeParse({
          projectId: 'project-1',
          placementRelations: [invalid],
        }).success,
      ).toBe(false);
    }
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents')
        return {
          total: 2,
          items: [
            { primitiveId: 'j1', designator: 'J1', x: 0, y: 0, layer: 1, rotation: 0 },
            { primitiveId: 'd1', designator: 'D1', x: 20, y: 0, layer: 1, rotation: 90 },
          ],
        };
      return { total: 0, items: [] };
    });
    const result = await run({ placementRelations: [relation] });
    expect(result.placement_review.findings[0]).toMatchObject({
      status: 'WARNING',
      relation: 'esd-entry',
      declared_second_rotation_deg: 350,
      second_rotation_deg: 90,
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.engineering_sign_off).toBe(false);
    expect(bridgeCall).toHaveBeenCalledTimes(3);
  });

  it('checks exact source-declared native footprint names in the existing read-only response', async () => {
    const relation = {
      first: 'U1',
      second: 'C1',
      kind: 'decoupling',
      firstFootprintName: 'QFN-32',
      secondFootprintName: 'C_0603',
      constraintSource: 'Example component placement specification Rev B',
    };
    const tool = registry.get('easyeda_pcb_route_geometry_review');
    expect(
      tool?.inputSchema.safeParse({ projectId: 'project-1', placementRelations: [relation] })
        .success,
    ).toBe(true);
    for (const invalid of [
      { ...relation, firstFootprintName: ' QFN-32' },
      { ...relation, firstFootprintName: '' },
      { ...relation, secondFootprintName: 'C_0603 ' },
      { ...relation, constraintSource: undefined },
    ]) {
      expect(
        tool?.inputSchema.safeParse({
          projectId: 'project-1',
          placementRelations: [invalid],
        }).success,
      ).toBe(false);
    }
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listComponents'
        ? {
            total: 2,
            items: [
              {
                primitiveId: 'u1',
                designator: 'U1',
                x: 0,
                y: 0,
                layer: 1,
                footprintName: 'QFN-32',
              },
              {
                primitiveId: 'c1',
                designator: 'C1',
                x: 50,
                y: 0,
                layer: 1,
                footprintName: 'C_0805',
              },
            ],
          }
        : { total: 0, items: [] },
    );
    const mismatch = await run({ placementRelations: [relation] });
    expect(mismatch.placement_review.findings[0]).toMatchObject({
      status: 'WARNING',
      first_footprint_name: 'QFN-32',
      second_footprint_name: 'C_0805',
      declared_second_footprint_name: 'C_0603',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(mismatch.engineering_sign_off).toBe(false);
    expect(bridgeCall.mock.calls.map(([method]) => method)).toEqual([
      'pcb.listTracks',
      'pcb.listVias',
      'pcb.listComponents',
    ]);
    const inRange = await run({
      placementRelations: [
        {
          ...relation,
          secondFootprintName: 'C_0805',
        },
      ],
    });
    expect(inRange.placement_review.findings[0]?.status).toBe('UNKNOWN');
    expect(inRange.placement_review.engineering_sign_off).toBe(false);
  });

  it('reads native component origins once only when relations are requested', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents')
        return {
          total: 2,
          items: [
            { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, rotation: 0, layer: 1 },
            { primitiveId: 'c1', designator: 'C1', x: 200, y: 0, rotation: 90, layer: 1 },
          ],
        };
      return { total: 0, items: [] };
    });
    const without = await run();
    expect(without.placement_review).toBeUndefined();
    expect(bridgeCall.mock.calls.map(([method]) => method)).not.toContain('pcb.listComponents');
    bridgeCall.mockClear();
    const result = await run({ placementRelations: [placement] });
    expect(bridgeCall.mock.calls).toEqual([
      ['pcb.listTracks', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listVias', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listComponents', { projectId: 'project-1', limit: 200, offset: 0 }],
    ]);
    expect(result.placement_review.status).toBe('WARNING');
    expect(result.overall_status).toBe('WARNING');
    expect(result.placement_review.findings).toContainEqual(
      expect.objectContaining({
        status: 'WARNING',
        relation: 'decoupling',
        components: ['U1', 'C1'],
        primitive_ids: ['u1', 'c1'],
        measured_center_distance_mm: 5.08,
        declared_max_center_distance_mm: 2,
        electrical_loop_status: 'UNKNOWN',
      }),
    );
    expect(result.placement_review.engineering_sign_off).toBe(false);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.placement_review.input_evidence.collection_complete).toBe(true);
  });

  it('does not convert close component origins to electrical decoupling PASS', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents')
        return {
          total: 2,
          items: [
            { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, rotation: 0, layer: 1 },
            { primitiveId: 'c1', designator: 'C1', x: 20, y: 20, rotation: 90, layer: 1 },
          ],
        };
      return { total: 0, items: [] };
    });
    const result = await run({ placementRelations: [placement] });
    expect(result.placement_review.status).toBe('UNKNOWN');
    expect(result.placement_review.findings[0].status).toBe('UNKNOWN');
    expect(result.placement_review.findings[0].measured_center_distance_mm).toBeCloseTo(0.71842, 4);
    expect(result.placement_review.findings[0].electrical_loop_status).toBe('UNKNOWN');
  });

  it('rejects partial native component enumeration as incomplete', async () => {
    bridgeCall.mockImplementation(async (method: string) =>
      method === 'pcb.listComponents'
        ? { total: 201, items: [{ primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1 }] }
        : { total: 0, items: [] },
    );
    const result = await run({ placementRelations: [placement] });
    expect(result.placement_review.input_evidence.collection_complete).toBe(false);
    expect(result.placement_review.status).toBe('UNKNOWN');
    expect(result.placement_review.findings[0].measured_center_distance_mm).toBeUndefined();
  });

  it('paginates a 202-component board and finds both declared parts beyond the first page', async () => {
    const items = Array.from({ length: 202 }, (_, index) => ({
      primitiveId: 'part-' + index,
      designator: index === 0 ? 'U1' : index === 201 ? 'C1' : 'R' + index,
      x: index === 201 ? 200 : 0,
      y: 0,
      layer: 1,
      rotation: 0,
    }));
    bridgeCall.mockImplementation(
      async (method: string, params?: { limit?: number; offset?: number }) =>
        method === 'pcb.listComponents'
          ? {
              total: items.length,
              items: items.slice(
                params?.offset ?? 0,
                (params?.offset ?? 0) + (params?.limit ?? 200),
              ),
            }
          : { total: 0, items: [] },
    );
    const result = await run({ placementRelations: [placement] });
    expect(result.placement_review.input_evidence).toMatchObject({
      components: 'observed',
      native_total: 202,
      returned_count: 202,
      collection_complete: true,
    });
    expect(result.placement_review.findings[0]).toMatchObject({
      evidence: 'native_component_origins',
      primitive_ids: ['part-0', 'part-201'],
      measured_center_distance_mm: 5.08,
      electrical_loop_status: 'UNKNOWN',
    });
    expect(bridgeCall.mock.calls.filter(([method]) => method === 'pcb.listComponents')).toEqual([
      ['pcb.listComponents', { projectId: 'project-1', limit: 200, offset: 0 }],
      ['pcb.listComponents', { projectId: 'project-1', limit: 200, offset: 200 }],
    ]);
    expect(result.placement_review.engineering_sign_off).toBe(false);
  });

  it('fails closed when the native component total changes between pages', async () => {
    const page = Array.from({ length: 200 }, (_, index) => ({
      primitiveId: 'part-' + index,
      designator: index === 0 ? 'U1' : 'R' + index,
      x: index,
      y: 0,
      layer: 1,
    }));
    bridgeCall.mockImplementation(async (method: string, params?: { offset?: number }) =>
      method === 'pcb.listComponents'
        ? params?.offset === 0
          ? { total: 201, items: page }
          : { total: 202, items: [{ primitiveId: 'c1', designator: 'C1', x: 0, y: 0, layer: 1 }] }
        : { total: 0, items: [] },
    );
    const result = await run({ placementRelations: [placement] });
    expect(result.errors.join(' ')).toContain('native total changed across pages');
    expect(result.placement_review.input_evidence).toMatchObject({
      components: 'unavailable',
      collection_complete: false,
    });
    expect(result.placement_review.findings[0]?.measured_center_distance_mm).toBeUndefined();
  });

  it('does not treat a duplicated boundary row as a complete native inventory', async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      primitiveId: index === 200 ? 'part-0' : 'part-' + index,
      designator: index === 0 ? 'U1' : index === 200 ? 'C1' : 'R' + index,
      x: index,
      y: 0,
      layer: 1,
    }));
    bridgeCall.mockImplementation(
      async (method: string, params?: { limit?: number; offset?: number }) =>
        method === 'pcb.listComponents'
          ? {
              total: 201,
              items: items.slice(
                params?.offset ?? 0,
                (params?.offset ?? 0) + (params?.limit ?? 200),
              ),
            }
          : { total: 0, items: [] },
    );
    const result = await run({ placementRelations: [placement] });
    expect(result.placement_review.input_evidence).toMatchObject({
      returned_count: 201,
      collection_complete: false,
    });
    expect(result.placement_review.status).toBe('UNKNOWN');
    expect(result.placement_review.findings[0]?.measured_center_distance_mm).toBeUndefined();
  });

  it('stops at the 1200-component budget without falsely completing a larger board', async () => {
    const all = Array.from({ length: 1_201 }, (_, index) => ({
      primitiveId: 'part-' + index,
      designator: index === 0 ? 'U1' : index === 1 ? 'C1' : 'R' + index,
      x: index,
      y: 0,
      layer: 1,
    }));
    bridgeCall.mockImplementation(
      async (method: string, params?: { limit?: number; offset?: number }) =>
        method === 'pcb.listComponents'
          ? {
              total: all.length,
              items: all.slice(params?.offset ?? 0, (params?.offset ?? 0) + (params?.limit ?? 200)),
            }
          : { total: 0, items: [] },
    );
    const result = await run({ placementRelations: [placement] });
    expect(result.placement_review.input_evidence).toMatchObject({
      native_total: 1201,
      returned_count: 1200,
      collection_complete: false,
    });
    expect(result.placement_review.findings[0]?.status).toBe('UNKNOWN');
    expect(result.placement_review.findings[0]?.measured_center_distance_mm).toBeUndefined();
    const pages = bridgeCall.mock.calls.filter(([method]) => method === 'pcb.listComponents');
    expect(pages).toHaveLength(6);
    expect(pages.at(-1)?.[1]).toEqual({ projectId: 'project-1', limit: 200, offset: 1000 });
  });

  it('fails closed when wrong PCB identity or unavailable native component getter prevents read', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents') throw new Error('focused PCB project UUID mismatch');
      return { total: 0, items: [] };
    });
    const result = await run({ placementRelations: [placement] });
    expect(result.errors).toEqual([expect.stringContaining('focused PCB project UUID mismatch')]);
    expect(result.placement_review.input_evidence.components).toBe('unavailable');
    expect(result.placement_review.status).toBe('UNKNOWN');
  });

  it('does not query component primitives while disconnected or extension mismatched', async () => {
    context.bridge.connected = false;
    const offline = await run({ placementRelations: [placement] });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(offline.placement_review.status).toBe('UNKNOWN');
    context.bridge.connected = true;
    context.bridge.registryMismatch = true;
    const mismatch = await run({ placementRelations: [placement] });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(mismatch.placement_review.input_evidence.components).toBe('unavailable');
  });

  it('keeps route geometry and differential-pair outputs backward compatible', async () => {
    const result = await run({ placementRelations: [placement] });
    expect(result.method).toBe('NATIVE_TRACK_SEGMENT_GEOMETRY');
    expect(result.placement_review).toBeDefined();
    expect(result.differential_pair).toBeUndefined();
    expect(result.input_evidence).toBeDefined();
    expect(result.engineering_sign_off).toBe(false);
  });

  it('binds an optional trace-current warning to versioned native track widths without adding bridge calls', async () => {
    const r = await run({
      traceCurrent: {
        net: 'CLK',
        currentA: 1,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
        environment: 'still-air',
        manufacturerMinWidthMm: 0.2,
      },
    });
    expect(bridgeCall).toHaveBeenCalledTimes(2);
    expect(r.trace_current_review).toMatchObject({
      net: 'CLK',
      geometry_evidence: 'observed_bounded_segments',
      observed_narrowest_segment_width_mm: 0.1016,
      observed_primitive_ids: ['track-a', 'track-b'],
      status: 'WARNING',
      engineering_sign_off: false,
    });
    expect(r.trace_current_review.findings).toContainEqual(
      expect.objectContaining({ id: 'THERMAL_REFERENCE_SHORTFALL', status: 'WARNING' }),
    );
    expect(r.overall_status).toBe('WARNING');
  });

  it('requires exact source versions for a native current-width verdict', async () => {
    context.bridge.easyedaVersion = undefined;
    const r = await run({
      traceCurrent: {
        net: 'CLK',
        currentA: 1,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      },
    });
    expect(r.trace_current_review).toMatchObject({
      status: 'UNKNOWN',
      geometry_evidence: 'unavailable',
      source_versions: { easyeda: null, extension: '1.8.1' },
    });
    expect(r.trace_current_review.observed_narrowest_segment_width_mm).toBeUndefined();
    expect(r.engineering_sign_off).toBe(false);
  });

  it('rejects invalid trace-current assumptions without reading the native bridge', () => {
    const schema = registry.get('easyeda_pcb_route_geometry_review')?.inputSchema;
    expect(
      schema?.safeParse({
        projectId: 'project-1',
        traceCurrent: {
          net: 'CLK',
          currentA: -1,
          temperatureRiseC: 10,
          layer: 'external',
          copperWeightOz: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({
        projectId: 'project-1',
        traceCurrent: {
          net: ' CLK ',
          currentA: 1,
          temperatureRiseC: 10,
          layer: 'external',
          copperWeightOz: 1,
        },
      }).success,
    ).toBe(false);
  });
});

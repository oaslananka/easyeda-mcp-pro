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
});

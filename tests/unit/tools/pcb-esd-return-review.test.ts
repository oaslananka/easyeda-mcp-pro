import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerPcbRouteReviewTools } from '../../../src/tools/L1_pcb_route_review.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const vias = [
  { primitiveId: 'ie634', net: 'GND', x: 100, y: 150, diameter: 30, holeDiameter: 10 },
  { primitiveId: 'ie638', net: 'GND', x: 200, y: 150, diameter: 30, holeDiameter: 10 },
];
const components = [
  { primitiveId: 'ie59', designator: 'U3', x: 100, y: 100, layer: 1 },
  { primitiveId: 'ie251', designator: 'J1', x: 200, y: 100, layer: 1 },
];
const pads = components.map((c, i) => ({
  primitiveId: i === 0 ? 'ie59ie20' : 'ie251ie42',
  parentComponentPrimitiveId: c.primitiveId,
  padNumber: i === 0 ? '2' : '5',
  net: 'GND',
  x: c.x,
  y: c.y,
  layer: 1,
}));
const tracks = components.map((c, i) => ({
  primitiveId: i === 0 ? 'ie526' : 'ie549',
  net: 'GND',
  layer: 1,
  startX: c.x,
  startY: c.y,
  endX: c.x,
  endY: 149.5,
  width: 10,
}));
const selection = {
  pourPrimitiveId: 'ie1258',
  fillId: 'copper11',
  expectedLayer: 15,
  transform: { scale: 0.1, invertY: false, source: 'Fixture calibration' },
  vias: vias.map((v) => ({
    viaPrimitiveId: v.primitiveId,
    diameterMm: 0.762,
    drillDiameterMm: 0.254,
    source: 'Fixture via dimensions',
  })),
};
const legacy = {
  first: 'U3',
  second: 'J1',
  kind: 'esd-entry',
  constraintSource: 'Fixture schematic and pad map',
  padPairs: [{ firstPin: '2', secondPin: '5', expectedNet: 'GND' }],
};
const relation = { ...legacy, esdReturnViaPair: selection };
const input = {
  projectId: 'pcb-project',
  nativePadContactMode: 'centre-only',
  placementPriorityContext: {},
  placementRelations: [relation],
};

function setup(mode = '') {
  const registry = new ToolRegistry();
  registerPcbRouteReviewTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  let contourReads = 0;
  const call = vi.fn(async (method: string, args: any) => {
    if (method === 'pcb.listTracks') {
      const items = mode === 'duplicate-track' ? [tracks[0], tracks[0]] : tracks;
      return { total: 2 + Number(mode === 'incomplete'), items };
    }
    if (method === 'pcb.listVias') {
      const items =
        mode === 'alias-via'
          ? [vias[0], { ...vias[1], primitiveId: pads[0].primitiveId }]
          : mode === 'duplicate-via'
            ? [vias[0], vias[0]]
            : vias;
      return { total: 2, items };
    }
    if (method === 'pcb.listComponents')
      return {
        total: 2,
        items:
          mode === 'alias-component'
            ? [components[0], { ...components[1], primitiveId: components[0].primitiveId }]
            : components,
      };
    if (method === 'api.read') {
      if (args.path === 'DMT_Project.getCurrentProjectInfo')
        return { result: { uuid: 'pcb-project' } };
      if (args.path === 'DMT_SelectControl.getCurrentDocumentInfo')
        return {
          result: {
            uuid: mode === 'focus' && contourReads >= 2 ? 'other' : 'pcb',
            parentProjectUuid: 'pcb-project',
            documentType: 3,
          },
        };
      if (args.path === 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId') {
        return {
          result: pads
            .filter((p) => p.parentComponentPrimitiveId === args.args[0])
            .map((p) => ({
              ...p,
              ...(mode === 'wrong-net' && p.padNumber === '5' ? { net: 'OTHER' } : {}),
              ...(mode === 'alias-pad' && p.padNumber === '5'
                ? { primitiveId: pads[0].primitiveId }
                : {}),
            })),
        };
      }
    }
    if (method === 'pcb.listComponentPadConnections') {
      const i = components.findIndex((c) => c.primitiveId === args.componentPrimitiveId);
      const p = pads[i],
        t = tracks[i];
      return {
        evidence: 'native_reported_centre',
        componentPrimitiveId: p.parentComponentPrimitiveId,
        padPrimitiveId: p.primitiveId,
        padNumber: p.padNumber,
        net: p.net,
        connected: [
          {
            primitiveId: t.primitiveId,
            net: t.net,
            layer: t.layer,
            nativeType: mode === 'wrong-contact-type' && i === 1 ? 'Via' : 'Line',
          },
        ],
      };
    }
    const i = vias.findIndex((v) => v.primitiveId === args.viaPrimitiveId);
    if (method === 'pcb.listViaLineAdjacency') {
      const t = tracks[mode === 'wrong-anchor' && i === 1 ? 0 : i];
      return {
        evidence: 'native_reciprocal_line_associations',
        viaPrimitiveId: mode === 'wrong-via' && i === 1 ? 'other' : args.viaPrimitiveId,
        net: 'GND',
        electricalContinuity: 'UNKNOWN',
        lines: [
          { primitiveId: t.primitiveId, layer: mode === 'wrong-layer' && i === 1 ? 2 : t.layer },
        ],
      };
    }
    if (method === 'pcb.listPourAnnulusGeometry') {
      contourReads++;
      const missing = mode === 'no-witness' && i === 1;
      return {
        evidence: 'native_source_linked_via_contour',
        pourPrimitiveId: mode === 'wrong-pour' && i === 1 ? 'other' : 'ie1258',
        net: mode === 'wrong-contour-net' && i === 1 ? 'OTHER' : 'GND',
        layer: mode === 'wrong-contour-layer' && i === 1 ? 16 : 15,
        fill: {
          id: mode === 'wrong-fill' && i === 1 ? 'other' : 'copper11',
          fill: true,
          lineWidth: 0,
          path: {
            complexPolygon: [
              missing
                ? [200, 200, 'L', 300, 200, 300, 300, 200, 300, 200, 200]
                : [0, 0, 'L', 100, 0, 100, 100, 0, 100, 0, 0],
            ],
          },
        },
        availableFillIds: ['copper11'],
        via: { ...vias[i], viaType: mode === 'blind-via' && i === 1 ? 1 : 0 },
        electricalContinuity: 'UNKNOWN',
      };
    }
    throw Error('Unexpected bridge call ' + method);
  });
  const ctx: ToolContext = {
    profile: 'core',
    bridge: {
      connected: true,
      call,
      easyedaVersion: '4.1.105',
      extensionVersion: '1.22.0',
      registryMismatch: mode === 'registry',
      extensionVersionMismatch: mode === 'version',
    },
    config: {
      bridgeTimeoutMs: 1000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      bridgeHost: '127.0.0.1',
      bridgePort: 49620,
    },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  };
  const tool = registry.get('easyeda_pcb_route_geometry_review')!;
  async function run(args: Record<string, unknown> = input) {
    const result = await tool.handler(ctx, args);
    expect(tool.outputSchema.parse(result)).toEqual(result);
    return result as any;
  }
  return { tool, run, call };
}
describe('explicit ESD return via evidence', () => {
  it('correlates two exact direct pad-line-via identities and selected contour witnesses without changing legacy findings', async () => {
    const { run, call } = setup();
    const previous = await run({ ...input, placementRelations: [legacy] });
    call.mockClear();
    const result = await run();
    expect(result.placement_review.findings).toEqual(previous.placement_review.findings);
    expect(result.placement_review.review_priorities).toEqual(
      previous.placement_review.review_priorities,
    );
    expect(result.overall_status).toBe(previous.overall_status);
    expect(previous.placement_review.esd_return_via_evidence).toBeUndefined();
    expect(result.placement_review.esd_return_via_evidence).toMatchObject({
      evidence: 'both_selected_contour_candidates',
      expected_net: 'GND',
      pour_primitive_id: 'ie1258',
      fill_id: 'copper11',
      native_layer: 15,
      electrical_continuity_status: 'UNKNOWN',
      physical_span_status: 'UNKNOWN',
      engineering_sign_off: false,
      endpoints: [
        {
          component: 'U3',
          pin: '2',
          native_pad_primitive_id: 'ie59ie20',
          line_primitive_id: 'ie526',
          via_primitive_id: 'ie634',
          line_native_layer: 1,
          evidence: 'selected_contour_candidate',
        },
        {
          component: 'J1',
          pin: '5',
          native_pad_primitive_id: 'ie251ie42',
          line_primitive_id: 'ie549',
          via_primitive_id: 'ie638',
          line_native_layer: 1,
          evidence: 'selected_contour_candidate',
        },
      ],
    });
    expect(call.mock.calls.filter(([m]) => m === 'pcb.listViaLineAdjacency')).toHaveLength(2);
    expect(call.mock.calls.filter(([m]) => m === 'pcb.listPourAnnulusGeometry')).toHaveLength(2);
    expect(call.mock.calls.filter(([m]) => m === 'pcb.listComponentPadConnections')).toHaveLength(
      2,
    );
  });
  it.each([
    'wrong-anchor',
    'wrong-layer',
    'wrong-contact-type',
    'wrong-via',
    'wrong-fill',
    'wrong-pour',
    'wrong-contour-net',
    'wrong-contour-layer',
    'blind-via',
    'no-witness',
  ])('retains partial evidence for %s', async (mode) => {
    const result = await setup(mode).run();
    expect(result.placement_review.esd_return_via_evidence).toMatchObject({
      evidence: 'partial_selected_contour_candidates',
      electrical_continuity_status: 'UNKNOWN',
      endpoints: [{ evidence: 'selected_contour_candidate' }, { evidence: 'unavailable' }],
    });
  });
  it.each([
    'wrong-net',
    'alias-pad',
    'alias-component',
    'alias-via',
    'duplicate-via',
    'duplicate-track',
    'incomplete',
    'focus',
    'registry',
    'version',
  ])('withholds correlated evidence for %s', async (mode) => {
    const result = await setup(mode).run();
    expect(result.placement_review.esd_return_via_evidence).toMatchObject({
      evidence: 'unavailable',
      endpoints: [{ evidence: 'unavailable' }, { evidence: 'unavailable' }],
    });
  });
  it('does not infer a return from swapped via identities or incorrect dimensions', async () => {
    const { run } = setup();
    const swapped = await run({
      ...input,
      placementRelations: [
        {
          ...relation,
          esdReturnViaPair: { ...selection, vias: [...selection.vias].reverse() },
        },
      ],
    });
    expect(swapped.placement_review.esd_return_via_evidence.evidence).toBe('unavailable');
    const wrong = await run({
      ...input,
      placementRelations: [
        {
          ...relation,
          esdReturnViaPair: {
            ...selection,
            vias: [selection.vias[0], { ...selection.vias[1], diameterMm: 1.5 }],
          },
        },
      ],
    });
    expect(wrong.placement_review.esd_return_via_evidence).toMatchObject({
      evidence: 'partial_selected_contour_candidates',
      endpoints: [
        { evidence: 'selected_contour_candidate' },
        { evidence: 'unavailable', reason: 'contour-candidate-unavailable' },
      ],
    });
  });
  it('rejects ambiguous or conflicting declarations before native reads', () => {
    const { tool, call } = setup();
    expect(tool.inputSchema.safeParse(input).success).toBe(true);
    for (const bad of [
      { ...input, nativePadContactMode: undefined },
      { ...input, nativeViaAdjacency: [{ viaPrimitiveId: 'ie634', expectedNet: 'GND' }] },
      { ...input, placementRelations: [relation, relation] },
      { ...input, placementRelations: [relation, legacy, legacy, legacy, legacy] },
      { ...input, placementRelations: [{ ...relation, second: relation.first }] },
      {
        ...input,
        nativeViaPourAnnulus: { ...selection, ...selection.vias[0], expectedNet: 'GND' },
      },
      {
        ...input,
        placementRelations: [{ ...relation, esdReturnViaPair: { ...selection, expectedLayer: 3 } }],
      },
      {
        ...input,
        placementRelations: [
          {
            ...relation,
            esdReturnViaPair: {
              ...selection,
              vias: [selection.vias[0], { ...selection.vias[1], drillDiameterMm: 2 }],
            },
          },
        ],
      },
      { ...input, placementRelations: [{ ...relation, kind: 'crystal' }] },
      { ...input, placementRelations: [{ ...relation, constraintSource: undefined }] },
      {
        ...input,
        placementRelations: [{ ...relation, padPairs: [...legacy.padPairs, ...legacy.padPairs] }],
      },
      {
        ...input,
        placementRelations: [
          {
            ...relation,
            esdReturnViaPair: { ...selection, vias: [selection.vias[0], selection.vias[0]] },
          },
        ],
      },
    ])
      expect(tool.inputSchema.safeParse(bad).success).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerPcbRouteReviewTools } from '../../../src/tools/L1_pcb_route_review.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const relations = [
  ['oscillator-in', 'U1', 'Y1', '5', '1', '/HSE_IN'],
  ['oscillator-out', 'U1', 'Y1', '6', '3', '/HSE_OUT'],
  ['load-in', 'Y1', 'C11', '1', '1', '/HSE_IN'],
  ['load-out', 'Y1', 'C10', '3', '1', '/HSE_OUT'],
].map(([crystalNetworkLeg, first, second, firstPin, secondPin, expectedNet]) => ({
  crystalNetworkLeg,
  first,
  second,
  kind: 'crystal',
  constraintSource: 'Fixture schematic and exact pad map',
  padPairs: [{ firstPin, secondPin, expectedNet }],
}));
const roles = relations.map((r) => r.crystalNetworkLeg);
const input = {
  projectId: 'pcb-project',
  nativePadContactMode: 'centre-only',
  placementRelations: relations,
};
const components = [
  { primitiveId: 'u', designator: 'U1', x: 0, y: 0, layer: 1 },
  { primitiveId: 'y', designator: 'Y1', x: 100, y: 0, layer: 1 },
  { primitiveId: 'ci', designator: 'C11', x: 200, y: 0, layer: 1 },
  { primitiveId: 'co', designator: 'C10', x: 200, y: 100, layer: 1 },
];
const pad = (parent: string, number: string, net: string, x: number, y: number) => ({
  primitiveId: parent + '/' + number,
  parentComponentPrimitiveId: parent,
  padNumber: number,
  net,
  x,
  y,
  layer: 1,
});
const pads = [
  pad('u', '5', '/HSE_IN', 0, 0),
  pad('y', '1', '/HSE_IN', 100, 0),
  pad('ci', '1', '/HSE_IN', 200, 0),
  pad('u', '6', '/HSE_OUT', 0, 100),
  pad('y', '3', '/HSE_OUT', 100, 100),
  pad('co', '1', '/HSE_OUT', 200, 100),
];
const line = (primitiveId: string, net: string, startX: number, endX: number, y: number) => ({
  primitiveId,
  net,
  layer: 1,
  startX,
  endX,
  startY: y,
  endY: y,
  width: 10,
});
const tracks = [
  line('in-a', '/HSE_IN', 0, 100, 0),
  line('in-b', '/HSE_IN', 100, 200, 0),
  line('out-a', '/HSE_OUT', 0, 100, 100),
  line('out-b', '/HSE_OUT', 100, 200, 100),
];

function setup(mode = 'normal') {
  const registry = new ToolRegistry();
  registerPcbRouteReviewTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const activeTracks =
    mode === 'missing-load'
      ? tracks.slice(0, 3)
      : mode === 'shared-line'
        ? [line('in-common', '/HSE_IN', 0, 200, 0), ...tracks.slice(2)]
        : tracks;
  const activePads = pads.map((p) =>
    p.primitiveId === 'co/1'
      ? {
          ...p,
          ...(mode === 'wrong-net' ? { net: 'OTHER' } : {}),
          ...(mode === 'alias-pad' ? { primitiveId: 'ci/1' } : {}),
        }
      : p,
  );
  const activeComponents = components.map((c) =>
    c.designator === 'C10' && mode === 'alias-component' ? { ...c, primitiveId: 'ci' } : c,
  );
  let contacts = 0;
  const call = vi.fn(async (method: string, args: any) => {
    if (method === 'pcb.listTracks')
      return { total: activeTracks.length + Number(mode === 'incomplete'), items: activeTracks };
    if (method === 'pcb.listVias') return { total: 0, items: [] };
    if (method === 'pcb.listComponents')
      return { total: activeComponents.length, items: activeComponents };
    if (method === 'api.read') {
      if (args.path === 'DMT_Project.getCurrentProjectInfo')
        return { result: { uuid: 'pcb-project' } };
      if (args.path === 'DMT_SelectControl.getCurrentDocumentInfo')
        return {
          result: {
            uuid: mode === 'focus' && contacts >= 8 ? 'other-pcb' : 'pcb',
            parentProjectUuid: 'pcb-project',
            documentType: 3,
          },
        };
      if (args.path === 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId')
        return { result: activePads.filter((p) => p.parentComponentPrimitiveId === args.args[0]) };
    }
    if (method === 'pcb.listComponentPadConnections') {
      contacts++;
      const p = activePads.find(
        (p) =>
          p.parentComponentPrimitiveId === args.componentPrimitiveId &&
          p.padNumber === args.padNumber,
      );
      if (!p) throw Error('missing pad');
      return {
        evidence: args.onlyCentreConnection ? 'native_reported_centre' : 'native_reported',
        componentPrimitiveId: p.parentComponentPrimitiveId,
        padPrimitiveId: p.primitiveId,
        padNumber: p.padNumber,
        net: p.net,
        connected: activeTracks
          .filter(
            (t) =>
              t.net === p.net &&
              t.startY === p.y &&
              (t.startX === p.x ||
                t.endX === p.x ||
                (mode === 'shared-line' &&
                  t.primitiveId === 'in-common' &&
                  p.primitiveId === 'y/1')),
          )
          .map((t) => ({
            primitiveId: t.primitiveId,
            net: t.net,
            layer: t.layer,
            nativeType: 'Line',
          })),
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
      extensionVersion: '1.21.0',
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
  const tool = registry.get('easyeda_pcb_route_geometry_review')!;
  async function run(args: Record<string, unknown> = input) {
    const result = await tool.handler(ctx, args);
    expect(tool.outputSchema.parse(result)).toEqual(result);
    return result as any;
  }
  return { tool, run, call };
}

describe('caller-declared crystal support network', () => {
  it('groups the four roles with shared crystal pad identities in canonical order', async () => {
    const { run, call } = setup();
    const legacy = await run({
      ...input,
      placementRelations: relations.map(({ crystalNetworkLeg: _, ...r }) => r),
    });
    expect(legacy.placement_review.crystal_network_topology).toBeUndefined();
    const reads = call.mock.calls.filter(([m]) => m !== 'api.read');
    call.mockClear();
    const result = await run();
    expect(call.mock.calls.filter(([m]) => m !== 'api.read')).toEqual(reads);
    expect(result.placement_review.findings).toEqual(legacy.placement_review.findings);
    expect(result.overall_status).toBe(legacy.overall_status);
    const group = result.placement_review.crystal_network_topology;
    expect(group).toMatchObject({
      evidence: 'all_line_chains_observed',
      missing_roles: [],
      electrical_continuity_status: 'UNKNOWN',
      engineering_sign_off: false,
      legs: [
        {
          role: 'oscillator-in',
          native_pad_primitive_ids: ['u/5', 'y/1'],
          primitive_ids: ['in-a'],
          native_layer: 1,
        },
        {
          role: 'oscillator-out',
          native_pad_primitive_ids: ['u/6', 'y/3'],
          primitive_ids: ['out-a'],
          native_layer: 1,
        },
        {
          role: 'load-in',
          native_pad_primitive_ids: ['y/1', 'ci/1'],
          primitive_ids: ['in-b'],
          native_layer: 1,
        },
        {
          role: 'load-out',
          native_pad_primitive_ids: ['y/3', 'co/1'],
          primitive_ids: ['out-b'],
          native_layer: 1,
        },
      ],
    });
    const shuffled = await run({
      ...input,
      placementRelations: [relations[3], relations[1], relations[2], relations[0]],
    });
    expect(shuffled.placement_review.crystal_network_topology).toEqual(group);
  });
  it('retains shared line evidence on both legs without summing the segment', async () => {
    const group = (await setup('shared-line').run()).placement_review.crystal_network_topology;
    expect(group.evidence).toBe('all_line_chains_observed');
    expect(group.legs[0]).toMatchObject({
      evidence: 'native_reported_centre',
      primitive_ids: ['in-common'],
    });
    expect(group.legs[2]).toMatchObject({
      evidence: 'native_reported_centre',
      primitive_ids: ['in-common'],
    });
    expect(group).not.toHaveProperty('total_length_mm');
  });
  it('reports a missing load chain without a disconnection claim', async () => {
    const result = await setup('missing-load').run();
    expect(result.placement_review.crystal_network_topology).toMatchObject({
      evidence: 'partial_line_chains_observed',
      missing_roles: ['load-out'],
      electrical_continuity_status: 'UNKNOWN',
    });
  });
  it('names an observed wrong net instead of presenting it as a valid path', async () => {
    const result = await setup('wrong-net').run();
    expect(result.placement_review.crystal_network_topology.legs[3]).toMatchObject({
      role: 'load-out',
      evidence: 'unavailable',
      next_action: 'verify-declared-net',
      primitive_ids: [],
    });
    expect(result.overall_status).toBe('WARNING');
  });
  it.each(['alias-pad', 'alias-component', 'incomplete', 'focus'])(
    'withholds the entire group for untrustworthy source: %s',
    async (mode) => {
      const result = await setup(mode).run();
      expect(result.placement_review.crystal_network_topology).toMatchObject({
        evidence: 'unavailable',
        missing_roles: roles,
        electrical_continuity_status: 'UNKNOWN',
      });
      expect(
        result.placement_review.crystal_network_topology.legs.every(
          (l: any) => l.primitive_ids.length === 0,
        ),
      ).toBe(true);
    },
  );
  it('rejects incompatible declarations before reads', () => {
    const { tool, call } = setup();
    expect(tool.inputSchema.safeParse(input).success).toBe(true);
    for (const placementRelations of [
      relations.slice(0, 3),
      [...relations.slice(0, 3), { ...relations[3], crystalNetworkLeg: 'load-in' }],
      [...relations.slice(0, 3), { ...relations[3], second: 'C11' }],
      [
        ...relations.slice(0, 3),
        { ...relations[3], padPairs: [{ firstPin: '1', secondPin: '1', expectedNet: '/HSE_OUT' }] },
      ],
      [
        ...relations.slice(0, 3),
        { ...relations[3], padPairs: [{ firstPin: '3', secondPin: '1', expectedNet: '/HSE_IN' }] },
      ],
      [...relations.slice(0, 3), { ...relations[3], constraintSource: undefined }],
      [...relations.slice(0, 3), { ...relations[3], kind: 'esd-entry' }],
      [...relations, { ...relations[0], crystalNetworkLeg: undefined }],
    ])
      expect(tool.inputSchema.safeParse({ ...input, placementRelations }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...input, nativePadContactMode: undefined }).success).toBe(
      false,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerPcbRouteReviewTools } from '../../../src/tools/L1_pcb_route_review.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const relations = [
  {
    first: 'C1',
    second: 'U1',
    switchingLoopLeg: 'input',
    padPairs: [{ firstPin: '1', secondPin: '1', expectedNet: 'VIN' }],
  },
  {
    first: 'U1',
    second: 'D2',
    switchingLoopLeg: 'switch',
    padPairs: [{ firstPin: '2', secondPin: '1', expectedNet: 'SW' }],
  },
  {
    first: 'D2',
    second: 'C1',
    switchingLoopLeg: 'return',
    padPairs: [{ firstPin: '2', secondPin: '2', expectedNet: 'GND' }],
  },
].map((r) => ({ ...r, kind: 'switching-loop', constraintSource: 'Fixture schematic and pad map' }));

const input = {
  projectId: 'pcb-project',
  includeNativePadContacts: true,
  placementRelations: relations,
};
const components = [
  { primitiveId: 'c', designator: 'C1', x: 0, y: 0, layer: 1 },
  { primitiveId: 'u', designator: 'U1', x: 100, y: 0, layer: 1 },
  { primitiveId: 'd', designator: 'D2', x: 100, y: 100, layer: 2 },
];
const pad = (component: string, number: string, net: string, x: number, y: number) => ({
  primitiveId: component + '/' + number,
  parentComponentPrimitiveId: component,
  padNumber: number,
  net,
  x,
  y,
  layer: 12,
});
const pads = [
  pad('c', '1', 'VIN', 0, 0),
  pad('u', '1', 'VIN', 100, 0),
  pad('u', '2', 'SW', 100, 20),
  pad('d', '1', 'SW', 100, 80),
  pad('d', '2', 'GND', 100, 100),
  pad('c', '2', 'GND', 0, 100),
];
const tracks = [
  { primitiveId: 'in', net: 'VIN', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, width: 10 },
  {
    primitiveId: 'sw',
    net: 'SW',
    layer: 1,
    startX: 100,
    startY: 25,
    endX: 100,
    endY: 75,
    width: 10,
  },
  {
    primitiveId: 'ret',
    net: 'GND',
    layer: 2,
    startX: 100,
    startY: 100,
    endX: 0,
    endY: 100,
    width: 10,
  },
];
function setup(
  options: {
    missingReturn?: boolean;
    wrongNet?: boolean;
    focusChanged?: boolean;
    incomplete?: boolean;
    duplicatePad?: boolean;
    missingComponent?: boolean;
  } = {},
) {
  const registry = new ToolRegistry();
  registerPcbRouteReviewTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const activePads = pads.map((p) =>
    p.primitiveId === 'c/2'
      ? {
          ...p,
          ...(options.wrongNet ? { net: 'OTHER' } : {}),
          ...(options.duplicatePad ? { primitiveId: 'd/2' } : {}),
        }
      : p,
  );
  const activeTracks = options.missingReturn ? tracks.slice(0, 2) : tracks;
  const activeComponents = options.missingComponent ? components.slice(0, 2) : components;
  let contacts = 0;
  let afterContacts = 0;
  const call = vi.fn(async (method: string, args: any) => {
    if (method === 'pcb.listTracks')
      return { total: activeTracks.length + Number(!!options.incomplete), items: activeTracks };
    if (method === 'pcb.listVias') return { total: 0, items: [] };
    if (method === 'pcb.listComponents')
      return { total: activeComponents.length, items: activeComponents };
    if (method === 'api.read') {
      if (args.path === 'DMT_Project.getCurrentProjectInfo')
        return { result: { uuid: 'pcb-project' } };
      if (args.path === 'DMT_SelectControl.getCurrentDocumentInfo') {
        if (contacts >= 6) afterContacts++;
        return {
          result: {
            uuid: options.focusChanged && afterContacts >= 2 ? 'other-pcb' : 'pcb',
            parentProjectUuid: 'pcb-project',
            documentType: 3,
          },
        };
      }
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
          .filter((t) => t.net === p.net)
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
      extensionVersion: '1.20.0',
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

describe('caller-declared nonsynchronous buck loop review', () => {
  it('groups shuffled explicit legs and preserves the exact selected line evidence', async () => {
    const { run, call } = setup();
    const legacy = await run({
      ...input,
      placementRelations: relations.map(({ switchingLoopLeg: _, ...r }) => r),
    });
    const legacyCalls = call.mock.calls.filter(([m]) => m !== 'api.read');
    expect(legacy.placement_review.switching_loop_topology).toBeUndefined();
    call.mockClear();
    const result = await run({
      ...input,
      placementRelations: [relations[2], relations[0], relations[1]],
    });
    expect(call.mock.calls.filter(([m]) => m !== 'api.read')).toHaveLength(legacyCalls.length);
    const group = result.placement_review.switching_loop_topology;
    expect(group).toMatchObject({
      evidence: 'all_line_chains_observed',
      missing_roles: [],
      electrical_loop_status: 'UNKNOWN',
      engineering_sign_off: false,
      legs: [
        {
          role: 'input',
          components: ['C1', 'U1'],
          first_pin: '1',
          second_pin: '1',
          expected_net: 'VIN',
          evidence: 'observed_exact_endpoint_chain',
          primitive_ids: ['in'],
          native_layer: 1,
        },
        {
          role: 'switch',
          components: ['U1', 'D2'],
          first_pin: '2',
          second_pin: '1',
          expected_net: 'SW',
          evidence: 'native_reported',
          primitive_ids: ['sw'],
          native_layer: 1,
        },
        {
          role: 'return',
          components: ['D2', 'C1'],
          first_pin: '2',
          second_pin: '2',
          expected_net: 'GND',
          evidence: 'observed_exact_endpoint_chain',
          primitive_ids: ['ret'],
          native_layer: 2,
        },
      ],
    });
    const sameOrder = await run();
    expect(sameOrder.placement_review.findings).toEqual(legacy.placement_review.findings);
    expect(sameOrder.overall_status).toBe(legacy.overall_status);
  });
  it('names the missing return leg without calling it disconnected', async () => {
    const { run } = setup({ missingReturn: true });
    const result = await run();
    expect(result.placement_review.switching_loop_topology).toMatchObject({
      evidence: 'partial_line_chains_observed',
      missing_roles: ['return'],
      legs: [
        { role: 'input', primitive_ids: ['in'] },
        { role: 'switch', primitive_ids: ['sw'] },
        {
          role: 'return',
          evidence: 'unavailable',
          primitive_ids: [],
          electrical_continuity_status: 'UNKNOWN',
        },
      ],
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.engineering_sign_off).toBe(false);
  });
  it('distinguishes a wrong declared net from missing evidence', async () => {
    const { run } = setup({ wrongNet: true });
    const result = await run();
    expect(result.placement_review.switching_loop_topology.legs[2]).toMatchObject({
      role: 'return',
      evidence: 'unavailable',
      next_action: 'verify-declared-net',
    });
    expect(result.overall_status).toBe('WARNING');
  });
  it.each([{ focusChanged: true }, { incomplete: true }, { duplicatePad: true }])(
    'withholds the entire group when shared identity is not trustworthy (%j)',
    async (flags) => {
      const { run } = setup(flags);
      const result = await run();
      expect(result.placement_review.switching_loop_topology).toMatchObject({
        evidence: 'unavailable',
        missing_roles: ['input', 'switch', 'return'],
        electrical_loop_status: 'UNKNOWN',
      });
      expect(
        result.placement_review.switching_loop_topology.legs.every(
          (leg: any) => leg.primitive_ids.length === 0,
        ),
      ).toBe(true);
    },
  );
  it('retains the independently observed input when another component is missing', async () => {
    const { run } = setup({ missingComponent: true });
    const result = await run();
    expect(result.placement_review.switching_loop_topology).toMatchObject({
      evidence: 'partial_line_chains_observed',
      missing_roles: ['switch', 'return'],
    });
  });
  it('rejects missing, conflicting, and wrongly sourced role declarations before native reads', () => {
    const { tool } = setup();
    expect(tool.inputSchema.safeParse(input).success).toBe(true);
    for (const placementRelations of [
      relations.slice(0, 2),
      [relations[0], relations[1], { ...relations[2], switchingLoopLeg: 'input' }],
      [relations[0], relations[1], { ...relations[2], second: 'C9' }],
      [
        relations[0],
        relations[1],
        { ...relations[2], padPairs: [{ firstPin: '1', secondPin: '2', expectedNet: 'GND' }] },
      ],
      [
        relations[0],
        relations[1],
        { ...relations[2], padPairs: [{ firstPin: '2', secondPin: '2', expectedNet: 'VIN' }] },
      ],
      [relations[0], relations[1], { ...relations[2], kind: 'crystal' }],
      [relations[0], relations[1], { ...relations[2], constraintSource: undefined }],
      [
        ...relations,
        {
          ...relations[0],
          switchingLoopLeg: undefined,
          padPairs: [...relations[0].padPairs, ...relations[1].padPairs],
        },
      ],
    ])
      expect(tool.inputSchema.safeParse({ ...input, placementRelations }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...input, includeNativePadContacts: false }).success).toBe(
      false,
    );
  });
});

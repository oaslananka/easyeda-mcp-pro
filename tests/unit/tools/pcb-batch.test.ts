import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { resetGlobalTransactionManagerForTests } from '../../../src/transactions/manager.js';
import { registerPcbWriteTools } from '../../../src/tools/L1_pcb_write.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const initial = [
  { primitiveId: 'comp-1', x: 10, y: 20, rotation: 0, layer: 1, locked: false },
  { primitiveId: 'comp-2', x: 30, y: 40, rotation: 0, layer: 1, locked: false },
  { primitiveId: 'comp-3', x: 50, y: 60, rotation: 0, layer: 1, locked: false },
];

describe('verified PCB component batch placement', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;
  let state: typeof initial;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
    registry = new ToolRegistry();
    registerPcbWriteTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    state = initial.map((item) => ({ ...item }));
    bridgeCall = vi.fn(async (method: string, params: any) => {
      if (method === 'api.call') return { result: { uuid: 'project-uuid-1' } };
      if (method === 'pcb.listComponents')
        return { total: state.length, items: state.map((item) => ({ ...item })) };
      if (method === 'pcb.modifyComponent') {
        const component = state.find((item) => item.primitiveId === params.primitiveId);
        if (!component) throw new Error('component missing');
        Object.assign(component, params.property);
        return { primitiveId: component.primitiveId };
      }
      throw new Error('unexpected method ' + method);
    });
    context = {
      profile: 'full',
      bridge: { connected: true, call: bridgeCall as ToolContext['bridge']['call'] },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    } as unknown as ToolContext;
  });

  const placements = [
    { primitiveId: 'comp-1', x: 15, y: 25 },
    { primitiveId: 'comp-2', x: 35, y: 45, rotation: 90 },
  ];

  it('registers a high-risk confirm-write component mutation in the full profile', () => {
    const tool = registry.get('easyeda_pcb_place_batch');
    expect(tool).toMatchObject({
      profile: 'full',
      risk: 'high',
      confirmWrite: true,
      confirmationPolicy: 'apply-mode',
      sideEffect: 'design-mutation',
    });
    expect(tool?.inputSchema.safeParse({ placements, mode: 'preview' }).success).toBe(true);
    expect(
      tool?.inputSchema.safeParse({ placements: [placements[0], placements[0]] }).success,
    ).toBe(false);
    expect(
      tool?.inputSchema.safeParse({
        placements: Array.from({ length: 65 }, (_, i) => ({
          primitiveId: 'component-' + i,
          x: 10,
          y: 20,
        })),
      }).success,
    ).toBe(false);
    expect(
      tool?.inputSchema.safeParse({ placements: [{ primitiveId: 'a', x: Infinity, y: 1 }] })
        .success,
    ).toBe(false);
  });

  it('previews multiple transforms with compact results and no writes', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const result = await tool.handler(context, { placements, mode: 'preview' });
    expect(result).toMatchObject({
      success: true,
      mode: 'preview',
      total: 2,
      processed: 2,
      moved: 0,
      unchanged: 0,
      remaining: 0,
      partial_apply: false,
      atomic: false,
      results: [
        { primitive_id: 'comp-1', status: 'planned' },
        { primitive_id: 'comp-2', status: 'planned' },
      ],
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(bridgeCall).not.toHaveBeenCalledWith('pcb.modifyComponent', expect.anything());
    expect(state).toEqual(initial);
  });

  it('denies apply without confirmation before contacting the bridge', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const result = await tool.handler(context, { placements, mode: 'apply' });
    expect(result).toMatchObject({
      success: false,
      mode: 'apply',
      processed: 0,
      moved: 0,
      remaining: 2,
      results: [],
      error: 'Apply mode requires confirmWrite=true.',
    });
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });

  it('applies each component only with native read-back and compact receipt', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const result = await tool.handler(context, { placements, mode: 'apply', confirmWrite: true });
    expect(result).toMatchObject({
      success: true,
      processed: 2,
      moved: 2,
      remaining: 0,
      partial_apply: false,
      atomic: false,
      results: [
        { primitive_id: 'comp-1', status: 'applied', transaction_state: 'committed' },
        { primitive_id: 'comp-2', status: 'applied', transaction_state: 'committed' },
      ],
    });
    expect(state[0]).toMatchObject({ x: 15, y: 25 });
    expect(state[1]).toMatchObject({ x: 35, y: 45, rotation: 90 });
    expect(
      bridgeCall.mock.calls.filter(([method]) => method === 'pcb.modifyComponent'),
    ).toHaveLength(2);
    expect(
      bridgeCall.mock.calls.filter(([method]) => method === 'pcb.listComponents'),
    ).toHaveLength(8);
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });

  it('reports no-op components without writing to the native bridge', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const result = await tool.handler(context, {
      mode: 'apply',
      confirmWrite: true,
      placements: [{ primitiveId: 'comp-1', x: 10, y: 20 }],
    });
    expect(result).toMatchObject({
      success: true,
      moved: 0,
      unchanged: 1,
      results: [{ primitive_id: 'comp-1', status: 'unchanged' }],
    });
    expect(bridgeCall).not.toHaveBeenCalledWith('pcb.modifyComponent', expect.anything());
  });

  it('stops at first failed item and reports previously committed placements as partial', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const original = bridgeCall.getMockImplementation()!;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'pcb.modifyComponent' && params.primitiveId === 'comp-2') {
        throw new Error('native modification failed');
      }
      return original(method, params);
    });
    const result = await tool.handler(context, {
      mode: 'apply',
      confirmWrite: true,
      placements: [...placements, { primitiveId: 'comp-3', x: 55, y: 65 }],
    });
    expect(result).toMatchObject({
      success: false,
      processed: 2,
      moved: 1,
      remaining: 1,
      partial_apply: true,
      results: [
        { primitive_id: 'comp-1', status: 'applied', transaction_state: 'committed' },
        { primitive_id: 'comp-2', status: 'failed' },
      ],
    });
    expect(result.error).toContain('native modification failed');
    expect(state[0].x).toBe(15);
    expect(state[2].x).toBe(50);
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });

  it('does not report success if the bridge accepts but does not persist changes', async () => {
    const tool = registry.get('easyeda_pcb_place_batch')!;
    const original = bridgeCall.getMockImplementation()!;
    bridgeCall.mockImplementation(async (method: string, params: any) =>
      method === 'pcb.modifyComponent'
        ? { primitiveId: params.primitiveId }
        : original(method, params),
    );
    const result = await tool.handler(context, { mode: 'apply', confirmWrite: true, placements });
    expect(result).toMatchObject({
      success: false,
      processed: 1,
      moved: 0,
      remaining: 1,
      partial_apply: false,
      results: [{ primitive_id: 'comp-1', status: 'failed' }],
    });
    expect(state).toEqual(initial);
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });
});

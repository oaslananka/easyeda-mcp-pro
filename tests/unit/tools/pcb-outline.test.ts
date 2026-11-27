import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, getRequiredToolScopes } from '../../../src/tools/registry.js';
import { registerPcbOutlineTools } from '../../../src/tools/L1_pcb_outline.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('easyeda_pcb_set_board_outline', () => {
  const registry = new ToolRegistry();
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  const context: ToolContext = {
    profile: 'pro',
    bridge: { connected: true, call },
    config: EnvSchema.parse({ NODE_ENV: 'test' }),
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as ToolContext;
  registerPcbOutlineTools(registry);
  const tool = registry.get('easyeda_pcb_set_board_outline')!;
  const input = {
    projectId: 'proj1',
    expectedPcbUuid: 'pcb1',
    widthMm: 50,
    heightMm: 30,
    confirmWrite: true,
  };

  beforeEach(() => {
    call.mockReset();
  });

  function scripted(responses: Record<string, Array<unknown | Error>>) {
    responses['system.getStatus'] ??= [{ documentTargetGuard: true, documentProjectGuard: true }];
    responses['pcb.listTracks'] ??= [{ items: [] }];
    call.mockImplementation(async (method: string) => {
      const queue = responses[method];
      if (!queue || queue.length === 0) throw new Error(`unexpected ${method}`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    });
  }

  it('is a confirmed pro write tool', () => {
    expect(tool.profile).toBe('pro');
    expect(tool.confirmWrite).toBe(true);
    expect(getRequiredToolScopes(tool)).not.toContain('project:read');
    expect(() => tool.inputSchema.parse({ ...input, confirmWrite: false })).toThrow();
  });

  it('requires the expected PCB UUID even though the registry marks it optional', async () => {
    await expect(tool.handler(context, { ...input, expectedPcbUuid: undefined })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  const created = (id: string) => ({ ok: true, result: { state: { PrimitiveId: id } } });

  it('draws one guarded outline polyline and verifies the measured size', async () => {
    scripted({
      'board.getDimensions': [
        { hasOutline: false },
        { hasOutline: true, widthMm: 50.2, heightMm: 30.2 },
      ],
      'api.call': [created('o1')],
    });
    const result = await tool.handler(context, input);
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      success: true,
      status: 'outline_created',
      primitiveIds: ['o1'],
      measuredWidthMm: 50.2,
    });
    expect(call).toHaveBeenCalledWith('api.call', {
      expectedPcbUuid: 'pcb1',
      expectedProjectUuid: 'proj1',
      path: 'PCB_PrimitivePolyline.create',
      args: ['', 11, { $polygon: ['R', 0, 0, 1968.504, 1181.102, 0, 0] }, 10, false],
    });
    expect(call).not.toHaveBeenCalledWith('pcb.deleteComponent', expect.anything());
  });

  it('refuses before reading when another PCB is focused', async () => {
    scripted({
      'pcb.listTracks': [
        Object.assign(new Error('Refusing pcb.listTracks: expected pcb1'), {
          code: 'TARGET_DOCUMENT_MISMATCH',
        }),
      ],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'target_mismatch' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledWith('pcb.listTracks', {
      projectId: 'proj1',
      expectedPcbUuid: 'pcb1',
      expectedProjectUuid: 'proj1',
      limit: 1,
      offset: 0,
    });
  });

  it('refuses to add a second outline', async () => {
    scripted({ 'board.getDimensions': [{ hasOutline: true, widthMm: 80, heightMm: 60 }] });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'outline_exists', measuredWidthMm: 80 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('refuses when the extension cannot guard the project', async () => {
    scripted({ 'system.getStatus': [{ documentTargetGuard: true }] });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'guard_unavailable' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports a guard refusal at create time as target_mismatch', async () => {
    scripted({
      'board.getDimensions': [{ hasOutline: false }],
      'api.call': [
        Object.assign(new Error('Refusing api.call'), { code: 'TARGET_DOCUMENT_MISMATCH' }),
      ],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'target_mismatch' });
    expect(result).not.toHaveProperty('rolledBack');
  });

  it('never claims a rollback when the create outcome is unknown', async () => {
    scripted({
      'board.getDimensions': [{ hasOutline: false }],
      'api.call': [new Error('Bridge method "api.call" timed out')],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'create_unverified' });
    expect(result).not.toHaveProperty('rolledBack');
    expect(call).not.toHaveBeenCalledWith('pcb.deleteComponent', expect.anything());
  });

  it('does not claim success when the native create returns no primitive id', async () => {
    scripted({
      'board.getDimensions': [{ hasOutline: false }],
      'api.call': [{ ok: true, result: null }],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({ success: false, status: 'create_unverified' });
  });

  it('confirms a rollback by re-reading the board', async () => {
    scripted({
      'board.getDimensions': [
        { hasOutline: false },
        { hasOutline: true, widthMm: 80, heightMm: 60 },
        { hasOutline: false },
      ],
      'api.call': [created('o1')],
      'pcb.deleteComponent': [{ deleted: ['o1'] }],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({
      success: false,
      status: 'readback_mismatch_rolled_back',
      rolledBack: true,
    });
  });

  it('reports leftovers when the outline is still there after the delete', async () => {
    scripted({
      'board.getDimensions': [
        { hasOutline: false },
        { hasOutline: true, widthMm: 80, heightMm: 60 },
        { hasOutline: true, widthMm: 80, heightMm: 60 },
      ],
      'api.call': [created('o1')],
      'pcb.deleteComponent': [{ deleted: ['o1'] }],
    });
    const result = await tool.handler(context, input);
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      success: false,
      status: 'readback_mismatch_rollback_incomplete',
      rolledBack: false,
      leftoverPrimitiveIds: ['o1'],
    });
    expect(call).toHaveBeenCalledWith('pcb.deleteComponent', { primitiveIds: ['o1'] });
  });

  it('keeps an unverified outline and says so when read-back is unavailable', async () => {
    scripted({
      'board.getDimensions': [{ hasOutline: false }, new Error('bridge lost')],
      'api.call': [created('o1')],
    });
    const result = await tool.handler(context, input);
    expect(result).toMatchObject({
      success: false,
      status: 'readback_unavailable',
      primitiveIds: ['o1'],
    });
  });
});

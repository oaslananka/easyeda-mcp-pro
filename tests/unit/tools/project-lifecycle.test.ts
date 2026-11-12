import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ToolRegistry,
  getRequiredToolScopes,
  remoteRiskForTool,
} from '../../../src/tools/registry.js';
import { registerProjectLifecycleTools } from '../../../src/tools/L1_project_lifecycle.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('safe project lifecycle tools', () => {
  const registry = new ToolRegistry();
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  const context: ToolContext = {
    profile: 'core',
    bridge: { connected: true, call },
    config: EnvSchema.parse({ NODE_ENV: 'test' }),
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as ToolContext;

  beforeEach(() => {
    call.mockReset();
  });
  registerProjectLifecycleTools(registry);

  it('registers exactly three scoped user-first lifecycle tools', () => {
    const list = registry.get('easyeda_project_list')!;
    const open = registry.get('easyeda_project_open')!;
    const close = registry.get('easyeda_project_close')!;
    expect([list, open, close].map((x) => x.profile)).toEqual(['core', 'core', 'core']);
    expect([list, open, close].map((x) => getRequiredToolScopes(x))).toEqual([
      ['project:read'],
      ['project:write'],
      ['project:write'],
    ]);
    expect([remoteRiskForTool(list), remoteRiskForTool(open), remoteRiskForTool(close)]).toEqual([
      'read',
      'write',
      'destructive',
    ]);
    expect(list.confirmWrite).toBe(false);
    expect(open.confirmWrite).toBe(true);
    expect(close.confirmWrite).toBe(true);
  });

  it('lists team-scoped projects without exposing unverified open state', async () => {
    const tool = registry.get('easyeda_project_list')!;
    call.mockResolvedValue({
      status: 'ok',
      complete: true,
      activeProjectId: 'a',
      projects: [
        { projectId: 'a', name: 'Alpha', active: true, open: true },
        { projectId: 'b', name: 'Beta', active: false, open: null },
      ],
    });
    const result = await tool.handler(context, {});
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ complete: true, projects: [{ open: true }, { open: null }] });
    expect(call).toHaveBeenCalledExactlyOnceWith('project.list', {});
  });

  it('never guesses a complete project list on a bridge/contract failure', async () => {
    const tool = registry.get('easyeda_project_list')!;
    call.mockRejectedValue(new Error('internal /home/user/private.eprj2'));
    const output = await tool.handler(context, {});
    expect(output).toMatchObject({
      complete: false,
      projects: [],
      status: 'native_listing_unavailable',
    });
    expect(JSON.stringify(output)).not.toContain('private.eprj2');
    call.mockResolvedValue({ status: 'ok', projects: [], complete: true, private: 'x' });
    expect(tool.outputSchema.safeParse(await tool.handler(context, {})).success).toBe(true);
  });

  it('requires explicit confirmation in schemas for open and close', () => {
    const open = registry.get('easyeda_project_open')!;
    const close = registry.get('easyeda_project_close')!;
    expect(open.inputSchema.safeParse({ projectId: 'p' }).success).toBe(false);
    expect(open.inputSchema.safeParse({ projectId: 'p', confirmWrite: 'true' }).success).toBe(
      false,
    );
    expect(close.inputSchema.safeParse({ projectId: 'p' }).success).toBe(false);
    expect(
      close.inputSchema.safeParse({ projectId: 'p', confirmWrite: true, mode: 'discard' }).success,
    ).toBe(true);
    expect(
      close.inputSchema.safeParse({ projectId: 'p', confirmWrite: true, mode: 'unexpected' })
        .success,
    ).toBe(false);
  });

  it('preserves blocked switch and exact confirmation without hiding it', async () => {
    const tool = registry.get('easyeda_project_open')!;
    call.mockResolvedValue({
      success: false,
      status: 'open_documents_may_be_dirty',
      projectId: 'p2',
    });
    const input = { projectId: 'p2', confirmWrite: true };
    const output = await tool.handler(context, input);
    expect(output).toMatchObject({ success: false, status: 'open_documents_may_be_dirty' });
    expect(call).toHaveBeenCalledWith('project.open', input);
    expect(tool.outputSchema.safeParse(output).success).toBe(true);
  });

  it('never reports a successful open or close for a lost native reply', async () => {
    call.mockRejectedValue(new Error('private /home/user/confidential-board.eprj2'));
    for (const name of ['easyeda_project_open', 'easyeda_project_close']) {
      const tool = registry.get(name)!;
      const output = await tool.handler(context, {
        projectId: 'p1',
        confirmWrite: true,
        mode: 'save',
      });
      expect(output).toMatchObject({ success: false, status: 'native_outcome_unknown' });
      expect(tool.outputSchema.safeParse(output).success).toBe(true);
      expect(JSON.stringify(output)).not.toContain('confidential-board.eprj2');
    }
  });

  it('refuses an unverified native response without pretending it succeeded', async () => {
    const tool = registry.get('easyeda_project_close')!;
    call.mockResolvedValue({ success: true, status: 'closed', closedTabs: 3 });
    const output = await tool.handler(context, {
      projectId: 'p1',
      mode: 'save',
      confirmWrite: true,
    });
    expect(output).toMatchObject({ success: false, status: 'native_outcome_unverified' });
    expect(tool.outputSchema.safeParse(output).success).toBe(true);
  });
});

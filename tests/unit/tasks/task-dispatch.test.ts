import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import type { ToolContext } from '../../../src/tools/types.js';
import {
  deriveTrustedReadOnlyTaskPrincipal,
  type TaskAuthorizationPolicy,
  type VerifiedOAuthTaskIdentity,
} from '../../../src/tasks/task-authorization.js';
import { dispatchAuthorizedReadOnlyTask } from '../../../src/tasks/task-dispatch.js';

const identity: VerifiedOAuthTaskIdentity = {
  kind: 'verified-oauth',
  issuer: 'https://verified.example.test',
  subject: 'user-one',
  clientId: 'client-one',
  scopes: ['bom:read', 'pcb:read'],
  expiresAtEpochSeconds: 3000,
};
const validArgs = { projectId: 'fixture-project', format: 'json' };

function fixture() {
  let now = 1000;
  const registry = new ToolRegistry();
  registry.setProfile('core');
  registerBuiltinTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const bridgeCall = vi.fn(async (method: string) => {
    if (method === 'bom.generate') {
      return [{ reference: 'R1', value: '10k', footprint: '0402', quantity: 1 }];
    }
    return [];
  });
  const context = {
    profile: 'core',
    bridge: { connected: true, call: bridgeCall },
    config: {
      bridgeTimeoutMs: 1000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      TOOL_SCOPES: '*',
      MCP_BRIDGE_BACKEND: 'local_bridge',
      bridgeHost: '127.0.0.1',
      bridgePort: 49620,
    },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as unknown as ToolContext;
  const policy: TaskAuthorizationPolicy = {
    registry,
    configuredScopes: '*',
    bridgeBackend: 'local',
    nowEpochSeconds: () => now,
  };
  const ownerId = deriveTrustedReadOnlyTaskPrincipal(identity, policy)!.ownerId;
  const dispatch = (
    options: {
      user?: VerifiedOAuthTaskIdentity;
      owner?: string;
      operation?: 'easyeda_bom_generate' | 'easyeda_pcb_components';
      args?: unknown;
      signal?: AbortSignal;
    } = {},
  ) =>
    dispatchAuthorizedReadOnlyTask(
      { registry, context, policy },
      options.user === undefined ? identity : options.user,
      options.owner ?? ownerId,
      options.operation ?? 'easyeda_bom_generate',
      options.args === undefined ? validArgs : options.args,
      options.signal ?? new AbortController().signal,
    );
  return {
    registry,
    bridgeCall,
    context,
    policy,
    ownerId,
    dispatch,
    clock: (value: number) => {
      now = value;
    },
  };
}

describe('staged Tasks dispatch through existing ToolRegistry guards', () => {
  it('uses registered Zod input/output and BOM handler with validated structured result', async () => {
    const test = fixture();
    const result = await test.dispatch();
    expect(test.bridgeCall).toHaveBeenCalledTimes(1);
    expect(test.bridgeCall).toHaveBeenCalledWith('bom.generate', {
      projectId: 'fixture-project',
      format: 'json',
      groupBy: 'value',
    });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('R1') }]);
    expect(result).toMatchObject({
      structuredContent: {
        project_id: 'fixture-project',
        format: 'json',
        total_entries: 1,
      },
    });
  });

  it('rejects forged owner, wrong OAuth subject and expired token before any tool call', async () => {
    const test = fixture();
    await expect(test.dispatch({ owner: 'different-tenant' })).rejects.toThrow('not authorized');
    await expect(test.dispatch({ user: { ...identity, subject: 'another-user' } })).rejects.toThrow(
      'not authorized',
    );
    test.clock(3000);
    await expect(test.dispatch()).rejects.toThrow('not authorized');
    expect(test.bridgeCall).not.toHaveBeenCalled();
  });

  it('fails closed on active backend/registry/scope mismatches and Relay backend', async () => {
    const test = fixture();
    test.context.config.TOOL_SCOPES = 'bom:read';
    await expect(test.dispatch()).rejects.toThrow('does not match');
    test.context.config.TOOL_SCOPES = '*';
    test.context.config.MCP_BRIDGE_BACKEND = 'remote_relay';
    await expect(test.dispatch()).rejects.toThrow('does not match');
    test.context.config.MCP_BRIDGE_BACKEND = 'local_bridge';
    test.policy.bridgeBackend = 'remote_relay';
    await expect(test.dispatch()).rejects.toThrow('does not match');
    expect(test.bridgeCall).not.toHaveBeenCalled();
  });

  it('rejects write operations and unexpected task controls before invocation', async () => {
    const test = fixture();
    await expect(
      test.dispatch({ operation: 'easyeda_pcb_add_track' as 'easyeda_bom_generate' }),
    ).rejects.toThrow('not authorized');
    await expect(
      test.dispatch({ args: { projectId: 'fixture-project', confirmWrite: true } }),
    ).rejects.toThrow('Unsafe task arguments');
    await expect(
      test.dispatch({ args: { projectId: 'fixture-project', format: 'bad-format' } }),
    ).rejects.toThrow();
    expect(test.bridgeCall).not.toHaveBeenCalled();
  });

  it('denies before execution when the abort signal has already fired', async () => {
    const test = fixture();
    const cancel = new AbortController();
    cancel.abort();
    await expect(test.dispatch({ signal: cancel.signal })).rejects.toThrow('not authorized');
    expect(test.bridgeCall).not.toHaveBeenCalled();
  });

  it('prevents a late result after the client has cancelled', async () => {
    const test = fixture();
    let finish!: (value: unknown) => void;
    const deferred = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    test.bridgeCall.mockImplementationOnce(async () => await deferred);
    const cancel = new AbortController();
    const running = test.dispatch({ signal: cancel.signal });
    await vi.waitFor(() => expect(test.bridgeCall).toHaveBeenCalledTimes(1));
    cancel.abort();
    finish([{ reference: 'R1', value: '10k', footprint: '0402', quantity: 1 }]);
    await expect(running).rejects.toThrow('cancelled');
  });

  it('rechecks expiry after the bridge returns and withholds stale results', async () => {
    const test = fixture();
    let finish!: (value: unknown) => void;
    const deferred = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    test.bridgeCall.mockImplementationOnce(async () => await deferred);
    const running = test.dispatch();
    await vi.waitFor(() => expect(test.bridgeCall).toHaveBeenCalledTimes(1));
    test.clock(3000);
    finish([{ reference: 'R1', value: '10k', footprint: '0402', quantity: 1 }]);
    await expect(running).rejects.toThrow('not authorized');
  });

  it('rechecks changed tool metadata and current scopes before accepting a result', async () => {
    const test = fixture();
    let finish!: (value: unknown) => void;
    const deferred = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    test.bridgeCall.mockImplementationOnce(async () => await deferred);
    const running = test.dispatch();
    await vi.waitFor(() => expect(test.bridgeCall).toHaveBeenCalledTimes(1));
    test.registry.get('easyeda_bom_generate')!.sideEffect = 'design-mutation';
    finish([{ reference: 'R1', value: '10k', footprint: '0402', quantity: 1 }]);
    await expect(running).rejects.toThrow('not authorized');
  });

  it('never returns raw native error details as task result', async () => {
    const test = fixture();
    test.bridgeCall.mockImplementationOnce(async () => {
      throw new Error('secret bearer=internal-token-here');
    });
    await expect(test.dispatch()).rejects.toThrow('Read-only tool invocation was unsuccessful');
  });

  it('fails closed when the native tool violates its registered output schema', async () => {
    const test = fixture();
    test.registry.get('easyeda_bom_generate')!.handler = async () => ({ malformed: true }) as never;
    await expect(test.dispatch()).rejects.toThrow('Read-only tool invocation was unsuccessful');
  });
});

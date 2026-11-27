import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import {
  isExtensionRpcTopicAllowed,
  parseExtensionRpcTopics,
  registerExtensionRpcTools,
} from '../../../src/tools/L1_extension_rpc.js';
import {
  getRequiredToolScopes,
  isToolScopeAllowedByServer,
  remoteRiskForTool,
  ToolRegistry,
} from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

describe('easyeda_extension_call', () => {
  let registry: ToolRegistry;
  let bridgeCall: ReturnType<typeof vi.fn>;

  const contextWith = (topics: string) =>
    ({
      profile: 'experimental',
      bridge: { connected: true, call: bridgeCall },
      config: { BRIDGE_EXTENSION_RPC_TOPICS: topics, artifactDir: '/tmp' },
    }) as unknown as ToolContext;

  const run = (input: Record<string, unknown>, topics = 'mcp.rcp.*') => {
    const tool = registry.get('easyeda_extension_call')!;
    return tool.handler(
      contextWith(topics),
      tool.inputSchema.parse({ confirmWrite: true, ...input }),
    );
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    registerExtensionRpcTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
  });

  it('is an experimental external action that needs destructive remote approval and local write scope', () => {
    const tool = registry.get('easyeda_extension_call')!;
    expect(tool.profile).toBe('experimental');
    expect(tool.sideEffect).toBe('external-action');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.openWorldHint).toBe(true);
    expect(remoteRiskForTool(tool)).toBe('destructive');
    expect(tool.confirmWrite).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(getRequiredToolScopes(tool)).toEqual(['diagnostics:write']);
    expect(isToolScopeAllowedByServer(tool, 'easyeda:read')).toBe(false);
    expect(isToolScopeAllowedByServer(tool, 'diagnostics:read')).toBe(false);
    expect(isToolScopeAllowedByServer(tool, 'diagnostics:write')).toBe(true);
    expect(tool.inputSchema.safeParse({ topic: 'mcp.rcp.ping' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ topic: 'mcp.rcp.ping', confirmWrite: false }).success).toBe(
      false,
    );
  });

  it('forwards an allowlisted call and returns the service reply', async () => {
    bridgeCall.mockResolvedValue({
      topic: 'mcp.rcp.checkNet',
      timeoutMs: 20_000,
      result: { violations: [] },
    });

    const result = await run({
      topic: 'mcp.rcp.checkNet',
      message: { net: 'USB_DP' },
      timeoutMs: 20_000,
    });

    expect(bridgeCall).toHaveBeenCalledWith(
      'extension.rpcCall',
      {
        topic: 'mcp.rcp.checkNet',
        message: { net: 'USB_DP' },
        timeoutMs: 20_000,
        confirmWrite: true,
      },
      { timeoutMs: 25_000 },
    );
    expect(result).toEqual({ topic: 'mcp.rcp.checkNet', ok: true, result: { violations: [] } });
  });

  it('sends null when no message is given and defaults the timeout', async () => {
    bridgeCall.mockResolvedValue({ topic: 'mcp.rcp.ping', timeoutMs: 10_000, result: 'pong' });

    await run({ topic: 'mcp.rcp.ping' });

    expect(bridgeCall).toHaveBeenCalledWith(
      'extension.rpcCall',
      { topic: 'mcp.rcp.ping', message: null, timeoutMs: 10_000, confirmWrite: true },
      { timeoutMs: 15_000 },
    );
  });

  it('is disabled until BRIDGE_EXTENSION_RPC_TOPICS is set', async () => {
    const result = await run({ topic: 'mcp.rcp.checkNet' }, '');

    expect(result).toMatchObject({ ok: false, disabled: true });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it.each([
    ['a topic outside the allowlist', 'mcp.other.tool', 'mcp.rcp.*'],
    ['a prefix sibling', 'mcp.rcpx.run', 'mcp.rcp.*'],
    ['an exact entry that differs', 'mcp.rcp.checkNet2', 'mcp.rcp.checkNet'],
  ])('refuses %s without calling the bridge', async (_label, topic, topics) => {
    const result = await run({ topic }, topics);

    expect(result).toMatchObject({ ok: false });
    expect(result.disabled).toBeUndefined();
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('refuses oversized or non-JSON messages without calling the bridge', async () => {
    const big = await run({ topic: 'mcp.rcp.checkNet', message: 'x'.repeat(256 * 1024) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cyclic = await run({ topic: 'mcp.rcp.checkNet', message: circular });

    expect(big).toMatchObject({ ok: false, error: expect.stringMatching(/256 KiB/) });
    expect(cyclic).toMatchObject({ ok: false });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it.each([
    'UNSUPPORTED_RUNTIME',
    'INVALID_PARAMS',
    'CONFIRM_WRITE_REQUIRED',
    'REGISTRY_MISMATCH',
    'EXTENSION_VERSION_MISMATCH',
    'BRIDGE_NOT_CONNECTED',
    'METHOD_NOT_ALLOWED',
    'METHOD_NOT_FOUND',
  ])('reports verified pre-dispatch refusal %s as a known failure', async (code) => {
    bridgeCall.mockRejectedValue(Object.assign(new Error('private details'), { code }));
    const result = await run({ topic: 'mcp.rcp.checkNet' });
    expect(result).toMatchObject({ ok: false, outcomeUnknown: false });
    expect(result.error).toContain('not dispatched');
    expect(result.error).not.toContain('private details');
  });

  it.each(['EXTENSION_RPC_FAILED', 'PAYLOAD_TOO_LARGE', 'TRANSPORT_FAILURE'])(
    'keeps possible post-dispatch failure %s uncertain',
    async (code) => {
      bridgeCall.mockRejectedValue(Object.assign(new Error('private details'), { code }));
      expect(await run({ topic: 'mcp.rcp.checkNet' })).toMatchObject({
        ok: false,
        outcomeUnknown: true,
      });
    },
  );

  it('reports bridge and service failures as ok=false', async () => {
    bridgeCall.mockRejectedValue(
      Object.assign(new Error('private /tmp/design.eprj2'), { code: 'EXTENSION_RPC_NO_REPLY' }),
    );

    const result = await run({ topic: 'mcp.rcp.checkNet' });

    expect(result).toMatchObject({
      ok: false,
      outcomeUnknown: true,
      error: expect.stringMatching(/outcome is unknown/),
    });
    expect(JSON.stringify(result)).not.toContain('/tmp/design.eprj2');
  });

  it.each([
    null,
    {},
    { topic: 'mcp.other', result: null },
    { topic: 'mcp.rcp.checkNet', result: null, timeoutMs: 123 },
  ])('does not report success for an unverified response (%j)', async (reply) => {
    bridgeCall.mockResolvedValue(reply);
    expect(await run({ topic: 'mcp.rcp.checkNet' })).toMatchObject({
      ok: false,
      outcomeUnknown: true,
    });
  });

  it.each(['rcp.checkNet', 'mcp.', 'mcp.a b', 'MCP.x', 'mcp.' + 'a'.repeat(121)])(
    'rejects topic %j at the schema boundary',
    (topic) => {
      const tool = registry.get('easyeda_extension_call')!;
      expect(tool.inputSchema.safeParse({ topic, confirmWrite: true }).success).toBe(false);
    },
  );

  it('rejects out-of-range timeouts at the schema boundary', () => {
    const tool = registry.get('easyeda_extension_call')!;
    expect(
      tool.inputSchema.safeParse({ topic: 'mcp.x', timeoutMs: 50, confirmWrite: true }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ topic: 'mcp.x', timeoutMs: 60_001, confirmWrite: true }).success,
    ).toBe(false);
  });
});

describe('extension RPC topic allowlist', () => {
  it('parses comma-separated entries and ignores blanks', () => {
    expect(parseExtensionRpcTopics(' mcp.a , ,mcp.b.*,')).toEqual(['mcp.a', 'mcp.b.*']);
  });

  it('matches exact topics and prefixes, never topics outside mcp.', () => {
    expect(isExtensionRpcTopicAllowed('mcp.rcp.run', ['mcp.rcp.*'])).toBe(true);
    expect(isExtensionRpcTopicAllowed('mcp.rcp', ['mcp.rcp'])).toBe(true);
    expect(isExtensionRpcTopicAllowed('mcp.anything', ['mcp.*'])).toBe(true);
    expect(isExtensionRpcTopicAllowed('other.rcp', ['mcp.*'])).toBe(false);
    expect(isExtensionRpcTopicAllowed('mcp.rcp', ['mcp.rcp.*'])).toBe(false);
  });

  it('validates BRIDGE_EXTENSION_RPC_TOPICS entries at startup', () => {
    expect(EnvSchema.safeParse({ BRIDGE_EXTENSION_RPC_TOPICS: 'mcp.rcp.*,mcp.ping' }).success).toBe(
      true,
    );
    expect(EnvSchema.safeParse({ BRIDGE_EXTENSION_RPC_TOPICS: '*' }).success).toBe(false);
    expect(EnvSchema.safeParse({ BRIDGE_EXTENSION_RPC_TOPICS: 'rcp.*' }).success).toBe(false);
    expect(EnvSchema.safeParse({ BRIDGE_EXTENSION_RPC_TOPICS: 'mcp.a*b' }).success).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import {
  isExtensionRpcTopicAllowed,
  parseExtensionRpcTopics,
  registerExtensionRpcTools,
} from '../../../src/tools/L1_extension_rpc.js';
import { remoteRiskForTool, ToolRegistry } from '../../../src/tools/registry.js';
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
    return tool.handler(contextWith(topics), tool.inputSchema.parse(input));
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    registerExtensionRpcTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
  });

  it('is an experimental external action that needs remote write approval', () => {
    const tool = registry.get('easyeda_extension_call')!;
    expect(tool.profile).toBe('experimental');
    expect(tool.sideEffect).toBe('external-action');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.openWorldHint).toBe(true);
    expect(remoteRiskForTool(tool)).toBe('write');
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
      { topic: 'mcp.rcp.checkNet', message: { net: 'USB_DP' }, timeoutMs: 20_000 },
      { timeoutMs: 25_000 },
    );
    expect(result).toEqual({ topic: 'mcp.rcp.checkNet', ok: true, result: { violations: [] } });
  });

  it('sends null when no message is given and defaults the timeout', async () => {
    bridgeCall.mockResolvedValue({ result: 'pong' });

    await run({ topic: 'mcp.rcp.ping' });

    expect(bridgeCall).toHaveBeenCalledWith(
      'extension.rpcCall',
      { topic: 'mcp.rcp.ping', message: null, timeoutMs: 10_000 },
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

  it('reports bridge and service failures as ok=false', async () => {
    bridgeCall.mockRejectedValue(new Error('Extension RPC mcp.rcp.checkNet failed: timeout'));

    const result = await run({ topic: 'mcp.rcp.checkNet' });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/) });
  });

  it.each(['rcp.checkNet', 'mcp.', 'mcp.a b', 'MCP.x', 'mcp.' + 'a'.repeat(121)])(
    'rejects topic %j at the schema boundary',
    (topic) => {
      const tool = registry.get('easyeda_extension_call')!;
      expect(tool.inputSchema.safeParse({ topic }).success).toBe(false);
    },
  );

  it('rejects out-of-range timeouts at the schema boundary', () => {
    const tool = registry.get('easyeda_extension_call')!;
    expect(tool.inputSchema.safeParse({ topic: 'mcp.x', timeoutMs: 50 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ topic: 'mcp.x', timeoutMs: 60_001 }).success).toBe(false);
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

import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionRpcOperations,
  EXTENSION_RPC_DEFAULT_TIMEOUT_MS,
  EXTENSION_RPC_MAX_TIMEOUT_MS,
} from '../src/extension-rpc-operations.js';

function makeOperations(bus: unknown) {
  const readFirstPath = vi.fn(() => bus);
  const createBridgeError = vi.fn((code: string, message: string, _suggestion: string) =>
    Object.assign(new Error(message), { code }),
  );
  return {
    readFirstPath,
    operations: createExtensionRpcOperations({
      readFirstPath: readFirstPath as never,
      createBridgeError,
    }),
  };
}

describe('extension RPC operations', () => {
  it.each([undefined, false, 'true'])(
    'refuses unconfirmed invocation (%j)',
    async (confirmWrite) => {
      const rpcCallPublic = vi.fn();
      const { operations, readFirstPath } = makeOperations({ rpcCallPublic });
      await expect(operations.call({ topic: 'mcp.ping', confirmWrite })).rejects.toMatchObject({
        code: 'CONFIRM_WRITE_REQUIRED',
      });
      expect(readFirstPath).not.toHaveBeenCalled();
      expect(rpcCallPublic).not.toHaveBeenCalled();
    },
  );

  it('refuses oversized bridge payload before calling a service', async () => {
    const rpcCallPublic = vi.fn();
    const { operations } = makeOperations({ rpcCallPublic });
    await expect(
      operations.call({ topic: 'mcp.ping', confirmWrite: true, message: 'é'.repeat(140_000) }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(rpcCallPublic).not.toHaveBeenCalled();
  });

  it('calls an opted-in public service and returns its JSON reply', async () => {
    const rpcCallPublic = vi.fn(async () => ({ violations: [{ net: 'USB_DP', gapMm: 0.4 }] }));
    const { readFirstPath, operations } = makeOperations({ rpcCallPublic });

    await expect(
      operations.call({
        confirmWrite: true,
        topic: 'mcp.rcp.checkNet',
        message: { net: 'USB_DP' },
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({
      topic: 'mcp.rcp.checkNet',
      timeoutMs: 5000,
      result: { violations: [{ net: 'USB_DP', gapMm: 0.4 }] },
    });
    expect(readFirstPath).toHaveBeenCalledWith(['SYS_MessageBus', 'sys_MessageBus']);
    expect(rpcCallPublic).toHaveBeenCalledWith('mcp.rcp.checkNet', { net: 'USB_DP' }, 5000);
  });

  it('sends null when no message is given and bounds the timeout', async () => {
    const rpcCallPublic = vi.fn(async () => 'ok');
    const { operations } = makeOperations({ rpcCallPublic });

    await operations.call({ confirmWrite: true, topic: 'mcp.ping' });
    await operations.call({ confirmWrite: true, topic: 'mcp.ping', timeoutMs: 10 ** 9 });
    await operations.call({ confirmWrite: true, topic: 'mcp.ping', timeoutMs: 1 });
    await operations.call({ confirmWrite: true, topic: 'mcp.ping', timeoutMs: 1.5 });

    expect(rpcCallPublic.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [null, EXTENSION_RPC_DEFAULT_TIMEOUT_MS],
      [null, EXTENSION_RPC_MAX_TIMEOUT_MS],
      [null, 100],
      [null, EXTENSION_RPC_DEFAULT_TIMEOUT_MS],
    ]);
  });

  it.each([
    undefined,
    '',
    'rcp.checkNet',
    'mcp.',
    'mcp..x',
    'MCP.rcp',
    'mcp.rcp/../x',
    'mcp.has space',
    'mcp.' + 'a'.repeat(121),
    42,
  ])('rejects topic %j before touching the message bus', async (topic) => {
    const rpcCallPublic = vi.fn();
    const { readFirstPath, operations } = makeOperations({ rpcCallPublic });

    await expect(operations.call({ confirmWrite: true, topic })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(readFirstPath).not.toHaveBeenCalled();
    expect(rpcCallPublic).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { rpcCall: vi.fn() }])(
    'fails closed when the public message bus is unavailable (%#)',
    async (bus) => {
      const { operations } = makeOperations(bus);
      await expect(
        operations.call({ confirmWrite: true, topic: 'mcp.ping' }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
    },
  );

  it('reports a failing or missing service as EXTENSION_RPC_FAILED', async () => {
    const rpcCallPublic = vi.fn(async () => {
      throw new Error('private /tmp/design.eprj2');
    });
    const { operations } = makeOperations({ rpcCallPublic });

    await expect(
      operations.call({ confirmWrite: true, topic: 'mcp.rcp.checkNet' }),
    ).rejects.toMatchObject({
      code: 'EXTENSION_RPC_FAILED',
      message: expect.stringContaining('outcome is unknown'),
    });
  });

  it.each([undefined, null, ''])(
    'reports a reasonless rejection (%j) as no reply within the timeout',
    async (reason) => {
      const rpcCallPublic = vi.fn(() => Promise.reject(reason));
      const { operations } = makeOperations({ rpcCallPublic });

      await expect(
        operations.call({ confirmWrite: true, topic: 'mcp.demo.missing', timeoutMs: 2000 }),
      ).rejects.toMatchObject({
        code: 'EXTENSION_RPC_NO_REPLY',
        message: expect.stringContaining('outcome is unknown'),
      });
    },
  );

  it('serializes non-JSON replies without methods and with bounded depth', async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const rpcCallPublic = vi.fn(async () => ({ fn: () => 1, deep }));
    const { operations } = makeOperations({ rpcCallPublic });

    const reply = (await operations.call({ confirmWrite: true, topic: 'mcp.shape' })) as {
      result: unknown;
    };
    expect(JSON.stringify(reply.result)).toContain('[MaxDepth]');
    expect(JSON.stringify(reply.result)).not.toContain('__methods');
  });
});

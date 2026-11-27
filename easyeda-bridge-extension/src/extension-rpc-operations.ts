import { normalizeValue } from './api-introspection.js';
import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';

/**
 * Only services that deliberately opt in are callable: another extension must
 * register its handler with `eda.sys_MessageBus.rpcServicePublic('mcp.<name>', fn)`.
 * Private-bus services and public topics outside the `mcp.` namespace stay unreachable.
 */
export const EXTENSION_RPC_TOPIC_PATTERN = /^mcp\.[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

export const EXTENSION_RPC_DEFAULT_TIMEOUT_MS = 10_000;
export const EXTENSION_RPC_MAX_TIMEOUT_MS = 60_000;
const EXTENSION_RPC_MIN_TIMEOUT_MS = 100;
/** Depth for serializing the service reply; deeper levels come back as "[MaxDepth]". */
const EXTENSION_RPC_RESULT_DEPTH = 10;

export interface ExtensionRpcDependencies {
  readFirstPath: ApiRuntime['readFirstPath'];
  createBridgeError: BridgeErrorFactory;
}

export interface ExtensionRpcOperations {
  call(params: Record<string, unknown>): Promise<unknown>;
}

interface PublicMessageBus {
  rpcCallPublic(topic: string, message?: unknown, timeout?: number): Promise<unknown>;
}

function isPublicMessageBus(value: unknown): value is PublicMessageBus {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Partial<PublicMessageBus>).rpcCallPublic === 'function'
  );
}

function boundedTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    return EXTENSION_RPC_DEFAULT_TIMEOUT_MS;
  return Math.min(EXTENSION_RPC_MAX_TIMEOUT_MS, Math.max(EXTENSION_RPC_MIN_TIMEOUT_MS, value));
}

export function createExtensionRpcOperations({
  readFirstPath,
  createBridgeError,
}: ExtensionRpcDependencies): ExtensionRpcOperations {
  // Call a service another EasyEDA extension registered on the public message bus.
  // The bridge only forwards JSON data; it never evaluates code supplied by the caller.
  async function call(params: Record<string, unknown>): Promise<unknown> {
    const topic = typeof params.topic === 'string' ? params.topic : '';
    if (!EXTENSION_RPC_TOPIC_PATTERN.test(topic)) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Extension RPC topic must match mcp.<name> (letters, digits, "_", "-", ".").',
        'Register the service with eda.sys_MessageBus.rpcServicePublic("mcp.<name>", handler).',
      );
    }
    const bus = readFirstPath<unknown>(['SYS_MessageBus', 'sys_MessageBus']);
    if (!isPublicMessageBus(bus)) {
      throw createBridgeError(
        'UNSUPPORTED_RUNTIME',
        'This EasyEDA runtime does not expose the public message bus (SYS_MessageBus.rpcCallPublic).',
        'Update EasyEDA Pro to a version with the extension message bus API.',
      );
    }
    const timeoutMs = boundedTimeout(params.timeoutMs);
    let reply: unknown;
    try {
      reply = await bus.rpcCallPublic(topic, params.message ?? null, timeoutMs);
    } catch (error) {
      // EasyEDA rejects with no reason when no service answers before the timeout,
      // which covers both an unregistered topic and a service that is too slow.
      if (error === undefined || error === null || error === '') {
        throw createBridgeError(
          'EXTENSION_RPC_NO_REPLY',
          `Extension RPC ${topic} got no reply within ${timeoutMs} ms.`,
          'Check that the extension providing this topic is installed and enabled, or raise timeoutMs.',
        );
      }
      throw createBridgeError(
        'EXTENSION_RPC_FAILED',
        `Extension RPC ${topic} failed: ${error instanceof Error ? error.message : String(error)}`,
        'Check that the extension providing this topic is installed, enabled and registered.',
      );
    }
    return {
      topic,
      timeoutMs,
      result: normalizeValue(reply, EXTENSION_RPC_RESULT_DEPTH, new WeakSet<object>(), false),
    };
  }

  return { call };
}

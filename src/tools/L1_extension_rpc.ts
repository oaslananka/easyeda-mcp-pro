import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import { type ToolContext } from './types.js';
import { type ToolRegistry } from './registry.js';

/** Same namespace the extension enforces: only services registered as `mcp.<name>`. */
const TOPIC_PATTERN = /^mcp\.[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
/** Request and reply data are bounded; the extension also honors the negotiated transport cap. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** Margin for the bridge round trip on top of the service's own timeout. */
const BRIDGE_TIMEOUT_MARGIN_MS = 5_000;

/** Parse the opt-in allowlist: exact topics, or prefixes written as `mcp.<prefix>*`. */
export function parseExtensionRpcTopics(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isExtensionRpcTopicAllowed(topic: string, allowlist: readonly string[]): boolean {
  if (!TOPIC_PATTERN.test(topic)) return false;
  return allowlist.some((entry) =>
    entry.endsWith('*') ? topic.startsWith(entry.slice(0, -1)) : topic === entry,
  );
}

function messageByteLength(message: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(message ?? null), 'utf8');
  } catch {
    return undefined;
  }
}

// These stable codes are emitted before the service invocation, either by the
// local bridge manager or the extension. Never classify arbitrary transport or
// service errors as known failures.
const RPC_PRE_DISPATCH_RECOVERY = new Map<string, string>([
  ['UNSUPPORTED_RUNTIME', 'Use an EasyEDA runtime with public message bus support.'],
  ['INVALID_PARAMS', 'Check the topic and message parameters.'],
  ['CONFIRM_WRITE_REQUIRED', 'Obtain explicit approval and set confirmWrite=true.'],
  ['REGISTRY_MISMATCH', 'Reconnect with a matching bridge method registry.'],
  ['EXTENSION_VERSION_MISMATCH', 'Install the extension matching the server version.'],
  ['BRIDGE_NOT_CONNECTED', 'Connect the EasyEDA bridge before retrying.'],
]);

function rpcFailure(topic: string, err: unknown) {
  const code = (err as { code?: unknown } | null)?.code;
  const recovery = typeof code === 'string' ? RPC_PRE_DISPATCH_RECOVERY.get(code) : undefined;
  if (recovery) {
    return {
      topic,
      ok: false,
      outcomeUnknown: false,
      error: `Extension RPC was not dispatched (${code}). ${recovery}`,
    };
  }
  const detail =
    code === 'EXTENSION_RPC_NO_REPLY'
      ? 'No service reply within the timeout'
      : 'Extension RPC failed';
  return {
    topic,
    ok: false,
    outcomeUnknown: true,
    error:
      detail +
      '; the outcome is unknown. The service may still be running; inspect before retrying.',
  };
}

export function registerExtensionRpcTools(registry: ToolRegistry, _config: EnvConfig): void {
  registry.register({
    name: 'easyeda_extension_call',
    title: 'Call an opted-in EasyEDA extension service',
    description:
      'Experimental: call a service another EasyEDA extension registered with ' +
      'sys_MessageBus.rpcServicePublic under an mcp. topic. Disabled unless the topic is listed in ' +
      'BRIDGE_EXTENSION_RPC_TOPICS. Sends JSON data only; the service, not this server, decides ' +
      'what it does. May mutate designs; requires confirmWrite=true.',
    profile: 'experimental',
    evidence: ['pro-api-types'],
    risk: 'high',
    confirmWrite: true,
    sideEffect: 'external-action',
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      confirmWrite: z
        .literal(true)
        .describe('Explicit approval for this potentially destructive service invocation.'),
      topic: z
        .string()
        .regex(TOPIC_PATTERN)
        .describe('Public message-bus topic in the mcp. namespace, e.g. mcp.rcp.checkNet.'),
      message: z
        .unknown()
        .optional()
        .describe('JSON payload passed as the single argument to the service handler.'),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .default(10_000)
        .describe('How long the service may take to reply.'),
    }),
    outputSchema: z.object({
      topic: z.string(),
      ok: z.boolean(),
      result: z.unknown().optional(),
      disabled: z.boolean().optional(),
      error: z.string().optional(),
      outcomeUnknown: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { topic, message, timeoutMs, confirmWrite } = params as {
        topic: string;
        message?: unknown;
        timeoutMs: number;
        confirmWrite: true;
      };
      if (confirmWrite !== true)
        return { topic, ok: false, error: 'confirmWrite=true is required.' };
      const configured = ctx.config.BRIDGE_EXTENSION_RPC_TOPICS;
      const allowlist = parseExtensionRpcTopics(typeof configured === 'string' ? configured : '');
      if (allowlist.length === 0) {
        return {
          topic,
          ok: false,
          disabled: true,
          error:
            'Extension RPC is disabled. Set BRIDGE_EXTENSION_RPC_TOPICS to the mcp.* topics this server may call.',
        };
      }
      if (!isExtensionRpcTopicAllowed(topic, allowlist)) {
        return {
          topic,
          ok: false,
          error: `Topic ${topic} is not listed in BRIDGE_EXTENSION_RPC_TOPICS.`,
        };
      }
      const bytes = messageByteLength(message);
      if (bytes === undefined || bytes > MAX_MESSAGE_BYTES) {
        return {
          topic,
          ok: false,
          error: 'Message must be JSON-serializable and at most 256 KiB.',
        };
      }
      try {
        const reply = await ctx.bridge.call(
          'extension.rpcCall',
          { topic, message: message ?? null, timeoutMs, confirmWrite },
          { timeoutMs: timeoutMs + BRIDGE_TIMEOUT_MARGIN_MS },
        );
        const response = z
          .object({ topic: z.literal(topic), timeoutMs: z.literal(timeoutMs), result: z.unknown() })
          .safeParse(reply);
        if (!response.success || response.data.result === undefined) {
          return {
            topic,
            ok: false,
            outcomeUnknown: true,
            error:
              'No verified service reply; the outcome is unknown. Inspect the service before retrying.',
          };
        }
        return { topic, ok: true, result: response.data.result };
      } catch (err) {
        return rpcFailure(topic, err);
      }
    },
  });
}

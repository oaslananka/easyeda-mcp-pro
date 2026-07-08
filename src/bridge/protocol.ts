import { z } from 'zod';

export const BRIDGE_PROTOCOL = 'easyeda-mcp-pro.bridge';
export const BRIDGE_CLIENT_NAME = 'easyeda-mcp-pro';
export const BRIDGE_CONTRACT_VERSION = 1;

/** Supported protocol versions for the bridge pairing/handshake. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['1.0.0'] as const;
export const CURRENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Zod schema for the initial handshake message.
 * Client → Server: identifies the client and its protocol version.
 */
export const BridgeHandshakeSchema = z.object({
  type: z.literal('handshake'),
  protocol: z.literal(BRIDGE_PROTOCOL),
  protocolVersion: z.enum(SUPPORTED_PROTOCOL_VERSIONS),
  clientName: z.literal(BRIDGE_CLIENT_NAME),
  contractVersion: z.literal(BRIDGE_CONTRACT_VERSION).default(BRIDGE_CONTRACT_VERSION),
  extensionVersion: z.string().optional(),
  easyedaVersion: z.string().optional(),
  devMode: z.boolean().optional(),
  sessionToken: z.string().optional(),
  /** Hash of the extension's active dispatcher method list (same algorithm as
   *  the server's methodRegistryHash) so stale dispatch logic fails loudly. */
  methodListHash: z.string().optional(),
  /** Version of the extension loader shell (tracks the .eext import). */
  loaderVersion: z.string().optional(),
});

/**
 * Server → Client: issued before handshake when the bridge requires
 * a pairing proof-of-possession (non-loopback + BRIDGE_TOKEN set).
 */
export const BridgePairingChallengeSchema = z.object({
  type: z.literal('pairing_challenge'),
  challenge: z.string(),
});

/**
 * Client → Server: response to a pairing challenge.
 * The client echoes the challenge and supplies the session token.
 */
export const BridgePairingResponseSchema = z.object({
  type: z.literal('pairing_response'),
  challenge: z.string(),
  sessionToken: z.string(),
});

/**
 * Zod schema for the hello message.
 * Server → Client: sent after successful handshake/pairing to announce
 * bridge capabilities, version info, and the method registry hash.
 */
export const BridgeHelloSchema = z.object({
  type: z.literal('hello'),
  bridgeVersion: z.string(),
  contractVersion: z.literal(BRIDGE_CONTRACT_VERSION),
  supportedProtocolVersions: z.array(z.enum(SUPPORTED_PROTOCOL_VERSIONS)).min(1),
  easyedaVersion: z.string().optional(),
  apiVersion: z.string().optional(),
  capabilities: z.array(z.string()),
  methodRegistryHash: z.string(),
  devMode: z.boolean(),
  /** The server's configured BRIDGE_MAX_PAYLOAD_SIZE, so the extension can self-limit
   *  binary (Blob/File) results before sending — avoiding a payload-too-large close
   *  of the whole connection over one oversized response. */
  maxPayloadSize: z.number().int().positive().optional(),
  /** Whether this server reassembles `{type:'chunk'}` envelopes, letting the
   *  extension split payloads larger than maxPayloadSize across frames. */
  supportsChunking: z.boolean().optional(),
  /** Aggregate cap for one chunked payload (defaults to 8× maxPayloadSize). */
  maxAggregatePayloadSize: z.number().int().positive().optional(),
  /** Whether this server accepts system.hotSwap.* dispatcher pushes (dev only). */
  hotSwapEnabled: z.boolean().optional(),
});

/**
 * Zod schema for an RPC request message.
 * Client → Server: invokes a named method with optional parameters.
 */
export const BridgeRequestSchema = z.object({
  id: z.string(),
  type: z.literal('request'),
  method: z.string(),
  params: z.unknown().optional(),
  timeoutMs: z.number().int().optional(),
  traceparent: z.string().optional(),
});

/**
 * Zod schema for an RPC response message.
 * Server → Client: carries the result or a structured error.
 */
export const BridgeResponseSchema = z.object({
  id: z.string(),
  type: z.literal('response'),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.enum([
        'BRIDGE_NOT_READY',
        'METHOD_NOT_ALLOWED',
        'METHOD_NOT_FOUND',
        'NET_NOT_FOUND',
        'NET_COLLISION',
        'EASYEDA_API_ERROR',
        'TIMEOUT',
        'INVALID_PARAMS',
        'UNAUTHORIZED',
        'DEV_MODE_REQUIRED',
        'NOT_IMPLEMENTED',
        'PAYLOAD_TOO_LARGE',
        'SCHEMATIC_NOT_FOCUSED',
        'UNKNOWN',
      ]),
      message: z.string(),
      suggestion: z.string(),
      data: z.unknown().optional(),
      easyedaVersion: z.string().optional(),
    })
    .optional(),
  durationMs: z.number(),
});

/**
 * Zod schema for a heartbeat keep-alive message.
 * Both directions: ensures the WebSocket connection is still alive.
 */
export const BridgeHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number(),
});

/** Inferred TypeScript type for a hello message. */
export type BridgeHello = z.infer<typeof BridgeHelloSchema>;
/**
 * Inferred TypeScript type for a response message with typed result.
 * @template TResult - The shape of the successful result payload.
 */
export type BridgeResponse<TResult = unknown> = Omit<
  z.infer<typeof BridgeResponseSchema>,
  'result' | 'error'
> & {
  result?: TResult;
  error?: {
    code: string;
    message: string;
    suggestion: string;
    data?: unknown;
    easyedaVersion?: string;
  };
};

import { type z } from 'zod';
import { type ToolProfile } from '../config/profiles.js';

import { type LcscClient } from '../vendors/lcsc/client.js';
import { type JlcpcbClient } from '../vendors/jlcpcb/client.js';
import { type MouserClient } from '../vendors/mouser/client.js';
import { type DigiKeyClient } from '../vendors/digikey/client.js';
import { type Storage } from '../storage/index.js';
import { type RemoteGateway } from '../remote/gateway.js';
import { type BridgeOwnershipConflict } from '../bridge/listener-ownership.js';

export type ToolSideEffect =
  'read-only' | 'design-mutation' | 'artifact-write' | 'local-state-write' | 'external-action';

export interface ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  /** Unique tool name used in MCP protocol */
  name: string;
  /** Human-readable title */
  title: string;
  /** Long description explaining purpose, inputs, and effects */
  description: string;
  /** Minimum profile required to enable this tool */
  profile: ToolProfile;
  /** Source(s) used to derive the tool's schema and behaviour */
  evidence: Array<
    | 'official-docs'
    | 'pro-api-types'
    | 'runtime-probe'
    | 'official-skill'
    | 'source-format'
    | 'vendor-api-docs'
    | 'inferred'
  >;
  /** Safety risk level — gates like confirmWrite trigger at 'medium' and above */
  risk: 'low' | 'medium' | 'high';
  /** Whether the tool can mutate project/design state.
   *  When true the runtime requires explicit acknowledgment according to confirmationPolicy. */
  confirmWrite: boolean;
  /** Confirmation timing. Defaults to `always`; `apply-mode` permits a non-mutating
   *  `mode=preview` call while still requiring confirmWrite=true for `mode=apply`. */
  confirmationPolicy?: 'always' | 'apply-mode';
  /** Explicit side-effect category. Omitted definitions fall back to confirmWrite-based classification. */
  sideEffect?: ToolSideEffect;
  /** Logical group for UI organisation and documentation (e.g. 'schematic', 'bom', 'board') */
  group: string;
  /** Schema version string — bump when breaking changes are made to input/output schemas */
  version: string;
  /** MCP protocol annotation hints */
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: TInput;
  outputSchema: TOutput;
  handler: (context: ToolContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
  /**
   * Optional: extract MCP image content blocks (e.g. a PNG canvas capture)
   * from a successful, schema-validated tool result. Returned images are
   * appended to the response's `content` array alongside the usual JSON/text
   * block. Most tools omit this.
   */
  imageContent?: (output: z.infer<TOutput>) => Array<{ data: string; mimeType: string }>;
  /**
   * Output field names to drop from `structuredContent` and the JSON text
   * content block when `imageContent` successfully produced at least one
   * image block — the same payload would otherwise be sent three times over
   * the wire (once as raw JSON text, once in structuredContent, once as a
   * proper image content block). The field is NOT removed from what
   * `imageContent` itself receives, only from the response's other two
   * copies. Most tools omit this.
   */
  imageContentOmitFields?: string[];
}

export interface BridgeDiagnosticsSnapshot {
  manager_uptime_ms?: number;
  active_port?: number;
  last_heartbeat_ms?: number;
  heartbeat_silence_ms?: number;
  method_registry_hash?: string;
  reconnect?: unknown;
  blocked_by_other_instance?: boolean;
  owner_pid?: number;
  owner_port?: number;
}

export interface ToolContext {
  profile: ToolProfile;
  bridge: {
    connected: boolean;
    call: <TParams, TResult>(
      method: string,
      params?: TParams,
      opts?: { timeoutMs?: number; traceparent?: string },
    ) => Promise<TResult>;
    uptimeMs?: number;
    activePort?: number;
    lastHeartbeatMs?: number;
    methodRegistryHash?: string;
    telemetry?: unknown;
    easyedaVersion?: string;
    extensionVersion?: string;
    extensionVersionMismatch?: boolean;
    /** Hash of the extension's active dispatcher method list (from handshake). */
    extensionMethodListHash?: string;
    /** Extension loader version (tracks the imported .eext shell). */
    loaderVersion?: string;
    /** True when the extension dispatcher's method list differs from the server registry. */
    registryMismatch?: boolean;
    /** Details about a live local process that currently owns the bridge listener. */
    ownershipConflict?: BridgeOwnershipConflict;
  };
  config: {
    bridgeTimeoutMs: number;
    artifactDir: string;
    bridgeHost: string;
    bridgePort: number;
    keylessSourcingEnabled?: boolean;
    [key: string]: unknown;
  };
  remote?: {
    gateway: RemoteGateway;
  };
  vendors: {
    lcsc: LcscClient | null;
    jlcpcb: JlcpcbClient | null;
    mouser: MouserClient | null;
    digikey: DigiKeyClient | null;
  };
  /** Local SQLite storage (project cache, artifacts, verified device catalog cache). */
  storage?: Storage;
}

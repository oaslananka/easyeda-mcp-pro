import { type z } from 'zod';
import { type ToolProfile } from '../config/profiles.js';

import { type LcscClient } from '../vendors/lcsc/client.js';
import { type JlcpcbClient } from '../vendors/jlcpcb/client.js';
import { type MouserClient } from '../vendors/mouser/client.js';
import { type DigiKeyClient } from '../vendors/digikey/client.js';

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
   *  When true the runtime MUST require an explicit acknowledgment before execution. */
  confirmWrite: boolean;
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
}

export interface BridgeDiagnosticsSnapshot {
  manager_uptime_ms?: number;
  active_port?: number;
  last_heartbeat_ms?: number;
  heartbeat_silence_ms?: number;
  method_registry_hash?: string;
  reconnect?: unknown;
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
  };
  config: {
    bridgeTimeoutMs: number;
    artifactDir: string;
    bridgeHost: string;
    bridgePort: number;
    keylessSourcingEnabled?: boolean;
    [key: string]: unknown;
  };
  vendors: {
    lcsc: LcscClient | null;
    jlcpcb: JlcpcbClient | null;
    mouser: MouserClient | null;
    digikey: DigiKeyClient | null;
  };
}

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ToolDefinition, type ToolContext } from './types.js';
import {
  registeredOutputSchema,
  getRawInput,
  parseWriteMode,
  omitWriteControls,
  writePlanResponse,
  type WriteMode,
} from './transaction.js';
import { type ToolProfile, getEnabledProfiles } from '../config/profiles.js';
import { z, ZodError } from 'zod';
import { SERVER_VERSION } from '../config/version.js';
import { getGlobalMetricsCollector, type ObservabilityCategory } from '../observability/index.js';
import { type RemoteIdentity } from '../remote/scope.js';
import { type RemoteRiskLevel } from '../remote/protocol.js';
import { type RemoteGatewayToolResult } from '../remote/gateway.js';

// ── Structured error codes ────────────────────────────────────────────────

export const ErrorCodes = {
  CONFIRM_WRITE_REQUIRED: 'ERR_CONFIRM_WRITE_REQUIRED',
  BRIDGE_DISCONNECTED: 'ERR_BRIDGE_DISCONNECTED',
  TOOL_EXECUTION: 'ERR_TOOL_EXECUTION',
  TOOL_NOT_FOUND: 'ERR_TOOL_NOT_FOUND',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  TOOL_OUTPUT_INVALID: 'ERR_TOOL_OUTPUT_INVALID',
  FORBIDDEN_SCOPE: 'ERR_FORBIDDEN_SCOPE',
  REMOTE_RELAY: 'ERR_REMOTE_RELAY',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface StructuredError {
  errorCode: ErrorCode;
  message: string;
  /** Optional structured details for the client */
  details?: Record<string, unknown>;
}

const READ_ALL_SCOPE = 'easyeda:read';
const WRITE_ALL_SCOPE = 'easyeda:write';

const REMOTE_RELAY_CONTROL_SHAPE = {
  remoteSessionId: z
    .string()
    .min(1)
    .optional()
    .describe('Paired Remote Relay session id. Optional when MCP_REMOTE_SESSION_ID is configured.'),
  remoteApprovalId: z
    .string()
    .min(1)
    .optional()
    .describe('Approved Remote Relay action id required for write, export, and destructive calls.'),
};

function registeredInputSchema(tool: ToolDefinition, context: ToolContext): z.ZodType {
  if (context.config.MCP_BRIDGE_BACKEND !== 'remote_relay') return tool.inputSchema;
  if (tool.inputSchema instanceof z.ZodObject) {
    return tool.inputSchema.safeExtend(REMOTE_RELAY_CONTROL_SHAPE);
  }
  return z.intersection(tool.inputSchema, z.object(REMOTE_RELAY_CONTROL_SHAPE));
}

type RemoteGatewayFailure = Extract<RemoteGatewayToolResult, { ok: false }>;

class RemoteRelayRouteError extends Error {
  constructor(readonly failure: RemoteGatewayFailure) {
    super(`Remote relay ${failure.code}: ${failure.message}`);
    this.name = 'RemoteRelayRouteError';
  }
}

function categoryForTool(tool: ToolDefinition): ObservabilityCategory {
  if (tool.group === 'diagnostics') return 'diagnostics';
  if (tool.group === 'export') return 'export';
  if (tool.group === 'bom' && tool.name.includes('sourcing')) return 'vendor-api';
  if (tool.group === 'drc-erc' || tool.group === 'pcb-constraints') return 'analysis';
  if (tool.group === 'pcb-write') return tool.confirmWrite ? 'bridge-write' : 'analysis';
  if (tool.confirmWrite) return 'bridge-write';
  return 'analysis';
}

function parseToolScopes(value: unknown): Set<string> | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') return null;

  return new Set(
    trimmed
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

const STATIC_GROUP_SCOPES: Partial<Record<ToolDefinition['group'], string[]>> = {
  diagnostics: ['diagnostics:read'],
  'drc-erc': ['checks:read'],
  board: ['pcb:read'],
  'pcb-constraints': ['pcb:read'],
  'pcb-write': ['pcb:write'],
  export: ['export:write'],
  visual: ['schematic:read', 'pcb:read'],
  'design-rules': ['design-rules:read'],
  workflows: ['schematic:write'],
  simulation: ['simulation:read'],
};

function specialToolScopes(tool: ToolDefinition): string[] | undefined {
  if (tool.name === 'easyeda_execute') return ['bridge:execute'];
  if (tool.name === 'easyeda_api_call') return [tool.confirmWrite ? 'api:write' : 'api:read'];
  if (tool.name === 'easyeda_api_inventory' || tool.name === 'easyeda_component_probe') {
    return ['api:read'];
  }
  return undefined;
}

export function getRequiredToolScopes(tool: ToolDefinition): string[] {
  const special = specialToolScopes(tool);
  if (special) return special;
  const staticScopes = STATIC_GROUP_SCOPES[tool.group];
  if (staticScopes) return staticScopes;
  if (tool.group === 'schematic') {
    return [tool.confirmWrite ? 'schematic:write' : 'schematic:read'];
  }
  if (tool.group === 'bom') return [tool.name.includes('sourcing') ? 'bom:source' : 'bom:read'];
  if (tool.group === 'catalog') return [tool.confirmWrite ? 'catalog:write' : 'catalog:read'];
  if (tool.group === 'project') return [tool.confirmWrite ? 'project:write' : 'project:read'];
  return [tool.confirmWrite ? WRITE_ALL_SCOPE : READ_ALL_SCOPE];
}

function hasRequiredToolScopes(
  allowedScopes: Set<string> | null,
  requiredScopes: string[],
): boolean {
  if (allowedScopes === null) return true;
  if (allowedScopes.has('*')) return true;
  if (requiredScopes.some((scope) => allowedScopes.has(scope))) return true;
  if (
    requiredScopes.some((scope) => scope.endsWith(':write')) &&
    allowedScopes.has(WRITE_ALL_SCOPE)
  ) {
    return true;
  }
  return (
    allowedScopes.has(READ_ALL_SCOPE) && requiredScopes.every((scope) => scope.endsWith(':read'))
  );
}

/**
 * Build a structured error content block for MCP responses.
 */
/** Shallow-copies `value` without `fields` — used to drop large duplicate
 *  payloads (e.g. a base64 image) from structuredContent/text once they've
 *  already been extracted into a dedicated content block. See
 *  `ToolDefinition.imageContentOmitFields`. */
function omitFields(value: unknown, fields: string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const omit = new Set(fields);
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!omit.has(key)) result[key] = val;
  }
  return result;
}

function structuredErrorResponse(error: StructuredError) {
  return {
    isError: true,
    structuredContent: error as unknown as Record<string, unknown>,
    content: [{ type: 'text' as const, text: `[${error.errorCode}] ${error.message}` }],
  };
}

// ── Bridge-disconnected helper ────────────────────────────────────────────

function bridgeDisconnectedResponse(
  host = '127.0.0.1',
  port = '49620',
): ReturnType<typeof structuredErrorResponse> {
  return structuredErrorResponse({
    errorCode: ErrorCodes.BRIDGE_DISCONNECTED,
    message: [
      `Bridge connection failed on ${host}:${port}`,
      '',
      'Possible causes:',
      '  1. EasyEDA Pro is not running',
      '  2. MCP Pro Bridge extension is not installed',
      '  3. Extension\'s "Allow External Interaction" is disabled',
      '  4. A firewall is blocking localhost connections',
      '',
      'Quick fix:',
      '  → Open EasyEDA Pro → Settings → Extensions → Extension Manager',
      '  → Import the extension file: easyeda-bridge-extension.eext',
      '  → Enable "Allow External Interaction"',
      '  → Click MCP Bridge → Connect in the menu bar',
    ].join('\n'),
    details: { host, port },
  });
}

type McpHandlerExtra = {
  authInfo?: {
    clientId?: string;
    scopes?: string[];
    expiresAt?: number;
    extra?: Record<string, unknown>;
  };
  requestInfo?: { headers?: unknown };
};

function readHeader(headers: unknown, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (headers && typeof headers === 'object' && 'get' in headers) {
    const value = (headers as { get: (key: string) => string | null | undefined }).get(name);
    return value ?? undefined;
  }
  if (headers && typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[lower];
    const firstValue = Array.isArray(value) ? value[0] : value;
    if (typeof firstValue === 'string') return firstValue;
    if (typeof firstValue === 'number' || typeof firstValue === 'boolean')
      return String(firstValue);
  }
  return undefined;
}

function normalizeRemoteScope(scope: string): string {
  return scope
    .trim()
    .replace(/^easyeda:/, 'easyeda.')
    .replace('project-admin', 'project_admin');
}

function parseRemoteScopes(value: unknown): RemoteIdentity['scopes'] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .map(normalizeRemoteScope)
    .filter(Boolean) as RemoteIdentity['scopes'];
}

function remoteIdentityFromExtra(extra: unknown): RemoteIdentity | undefined {
  const handlerExtra = extra as McpHandlerExtra | undefined;
  const auth = handlerExtra?.authInfo;
  if (auth) {
    const claims = auth.extra ?? {};
    let userId = auth.clientId;
    if (typeof claims.userId === 'string') userId = claims.userId;
    if (typeof claims.sub === 'string') userId = claims.sub;
    if (!userId) return undefined;
    return {
      userId,
      scopes: (auth.scopes ?? []).map(normalizeRemoteScope) as RemoteIdentity['scopes'],
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt * 1000) : undefined,
    };
  }

  const headers = handlerExtra?.requestInfo?.headers;
  const userId = readHeader(headers, 'x-remote-user-id');
  if (!userId) return undefined;
  const expiresAtHeader = readHeader(headers, 'x-remote-expires-at');
  return {
    userId,
    scopes: parseRemoteScopes(readHeader(headers, 'x-remote-scopes') ?? 'easyeda.read'),
    expiresAt: expiresAtHeader ? new Date(expiresAtHeader) : undefined,
  };
}

function rawRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Resolve a tool's Remote Relay risk tier using explicit policy precedence. */
export function remoteRiskForTool(tool: ToolDefinition): RemoteRiskLevel {
  if (tool.name === 'easyeda_execute') return 'destructive';
  if (tool.group === 'export') return 'export';
  if (tool.risk === 'high') return 'destructive';
  if (tool.confirmWrite || tool.risk === 'medium') return 'write';
  return 'read';
}

interface PreparedToolContext {
  context: ToolContext;
  release?: () => void;
}

async function contextForRemoteRelay(
  context: ToolContext,
  tool: ToolDefinition,
  raw: unknown,
  extra: unknown,
  parsed: unknown,
): Promise<PreparedToolContext> {
  if (context.config.MCP_BRIDGE_BACKEND !== 'remote_relay') return { context };
  const gateway = context.remote?.gateway;
  if (!gateway) {
    throw new Error('Remote relay backend requested but no RemoteGateway is configured.');
  }

  const controls = rawRecord(raw);
  const configuredSessionId =
    typeof context.config.MCP_REMOTE_SESSION_ID === 'string'
      ? context.config.MCP_REMOTE_SESSION_ID
      : '';
  let sessionId =
    typeof controls.remoteSessionId === 'string'
      ? controls.remoteSessionId
      : configuredSessionId || undefined;
  const approvalId =
    typeof controls.remoteApprovalId === 'string' ? controls.remoteApprovalId : undefined;
  const identity = remoteIdentityFromExtra(extra);
  const riskLevel = remoteRiskForTool(tool);
  let grantId: string | undefined;

  if (riskLevel !== 'read') {
    const authorization = await gateway.authorizeToolInvocation({
      identity,
      sessionId,
      toolName: tool.name,
      riskLevel,
      input: parsed,
      approvalId,
    });
    if (!authorization.ok) throw new RemoteRelayRouteError(authorization);
    sessionId = authorization.sessionId;
    grantId = authorization.grantId;
  }

  return {
    context: {
      ...context,
      bridge: {
        ...context.bridge,
        get connected() {
          return true;
        },
        call: async <TParams, TResult>(
          method: string,
          params?: TParams,
          opts?: { timeoutMs?: number; traceparent?: string },
        ): Promise<TResult> => {
          const result = await gateway.routeToolRequest({
            identity,
            sessionId,
            toolName: method,
            riskLevel,
            input: params,
            grantId,
            deadlineMs: opts?.timeoutMs,
          });
          if (!result.ok) throw new RemoteRelayRouteError(result);
          return result.result as TResult;
        },
      },
    },
    release: grantId ? () => void gateway.revokeInvocationGrant(grantId) : undefined,
  };
}

function invalidWriteModeResponse(tool: ToolDefinition, error: ZodError) {
  return structuredErrorResponse({
    errorCode: ErrorCodes.INVALID_INPUT,
    message: `Invalid writeMode for "${tool.name}": ${error.message}`,
    details: { toolName: tool.name, issues: error.issues },
  });
}

function forbiddenScopeResponse(
  context: ToolContext,
  tool: ToolDefinition,
  requiredScopes: string[],
) {
  const allowedScopes = parseToolScopes(context.config.TOOL_SCOPES);
  if (hasRequiredToolScopes(allowedScopes, requiredScopes)) return undefined;
  return structuredErrorResponse({
    errorCode: ErrorCodes.FORBIDDEN_SCOPE,
    message: `Tool "${tool.name}" requires one of: ${requiredScopes.join(', ')}.`,
    details: {
      toolName: tool.name,
      requiredScopes,
      configuredScopes: allowedScopes ? Array.from(allowedScopes) : ['*'],
    },
  });
}

function writePlanningResponse(
  tool: ToolDefinition,
  raw: Record<string, unknown>,
  writeMode: WriteMode,
  requiredScopes: string[],
) {
  if (!tool.confirmWrite || writeMode === 'apply') return undefined;
  const parsedPlan = tool.inputSchema.safeParse({ ...raw, confirmWrite: true });
  if (!parsedPlan.success) {
    return structuredErrorResponse({
      errorCode: ErrorCodes.INVALID_INPUT,
      message: `Invalid input for "${tool.name}": ${parsedPlan.error.message}`,
      details: { toolName: tool.name, issues: parsedPlan.error.issues },
    });
  }
  return writePlanResponse(tool, writeMode, omitWriteControls(parsedPlan.data), requiredScopes);
}

function confirmWriteResponse(tool: ToolDefinition, raw: Record<string, unknown>) {
  if (!tool.confirmWrite || raw.confirmWrite === true) return undefined;
  return structuredErrorResponse({
    errorCode: ErrorCodes.CONFIRM_WRITE_REQUIRED,
    message: `Tool "${tool.name}" can mutate design state and requires confirmWrite=true.`,
    details: { toolName: tool.name, toolGroup: tool.group, risk: tool.risk },
  });
}

async function executeToolWithMetrics(
  context: ToolContext,
  tool: ToolDefinition,
  raw: Record<string, unknown>,
  extra: unknown,
  parsed: unknown,
): Promise<unknown> {
  const startedAt = Date.now();
  let prepared: PreparedToolContext | undefined;
  try {
    prepared = await contextForRemoteRelay(context, tool, raw, extra, parsed);
    const result = await tool.handler(prepared.context, parsed);
    getGlobalMetricsCollector().recordTimed({
      category: categoryForTool(tool),
      name: tool.name,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return result;
  } catch (err) {
    getGlobalMetricsCollector().recordTimed({
      category: categoryForTool(tool),
      name: tool.name,
      durationMs: Date.now() - startedAt,
      ok: false,
    });
    throw err;
  } finally {
    prepared?.release?.();
  }
}

function formatToolSuccess(tool: ToolDefinition, result: unknown) {
  const output = tool.outputSchema.safeParse(result);
  if (!output.success) {
    return structuredErrorResponse({
      errorCode: ErrorCodes.TOOL_OUTPUT_INVALID,
      message: `Tool "${tool.name}" returned output that does not match its declared outputSchema.`,
      details: { toolName: tool.name, issues: output.error.issues },
    });
  }

  const images = tool.imageContent?.(output.data) ?? [];
  const responseData =
    images.length > 0 && tool.imageContentOmitFields?.length
      ? omitFields(output.data, tool.imageContentOmitFields)
      : output.data;
  const structuredContent =
    typeof responseData === 'object' && responseData !== null
      ? (responseData as Record<string, unknown>)
      : { value: responseData };
  return {
    structuredContent,
    content: [
      { type: 'text' as const, text: JSON.stringify(responseData, null, 2) },
      ...images.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
  };
}

function toolFailureResponse(tool: ToolDefinition, context: ToolContext, err: unknown) {
  if (err instanceof ZodError) {
    return structuredErrorResponse({
      errorCode: ErrorCodes.INVALID_INPUT,
      message: `Invalid input for "${tool.name}": ${err.message}`,
      details: { toolName: tool.name, issues: err.issues },
    });
  }

  if (err instanceof RemoteRelayRouteError) {
    return structuredErrorResponse({
      errorCode: ErrorCodes.REMOTE_RELAY,
      message: err.message,
      details: {
        toolName: tool.name,
        remoteCode: err.failure.code,
        status: err.failure.status,
        approvalId: err.failure.approvalId,
        approvalExpiresAt: err.failure.approvalExpiresAt,
      },
    });
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Bridge not connected') || msg.includes('Bridge disconnected')) {
    return bridgeDisconnectedResponse(context.config.bridgeHost, String(context.config.bridgePort));
  }

  return structuredErrorResponse({
    errorCode: ErrorCodes.TOOL_EXECUTION,
    message: `Tool "${tool.name}" failed: ${msg}`,
    details: { toolName: tool.name },
  });
}

async function handleRegisteredToolCall(
  tool: ToolDefinition,
  context: ToolContext,
  input: unknown,
  extra: unknown,
) {
  try {
    const raw = getRawInput(input);
    const writeMode = parseWriteMode(raw);
    if (writeMode instanceof ZodError) return invalidWriteModeResponse(tool, writeMode);

    const requiredScopes = getRequiredToolScopes(tool);
    const scopeError = forbiddenScopeResponse(context, tool, requiredScopes);
    if (scopeError) return scopeError;

    const planned = writePlanningResponse(tool, raw, writeMode, requiredScopes);
    if (planned) return planned;

    const confirmError = confirmWriteResponse(tool, raw);
    if (confirmError) return confirmError;

    const parsed = tool.inputSchema.parse(input ?? {});
    const result = await executeToolWithMetrics(context, tool, raw, extra, parsed);
    return formatToolSuccess(tool, result);
  } catch (err) {
    return toolFailureResponse(tool, context, err);
  }
}

// ── Tool metadata snapshot ────────────────────────────────────────────────

export interface ToolMetadata {
  name: string;
  title: string;
  description: string;
  profile: ToolProfile;
  risk: 'low' | 'medium' | 'high';
  confirmWrite: boolean;
  group: string;
  version: string;
  evidence: ToolDefinition['evidence'];
  annotations: ToolDefinition['annotations'];
}

// ── Registry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private currentProfile: ToolProfile = 'core';

  setProfile(profile: ToolProfile): void {
    this.currentProfile = profile;
  }

  register<TInput extends z.ZodType, TOutput extends z.ZodType>(
    definition: ToolDefinition<TInput, TOutput>,
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered.`);
    }
    this.tools.set(definition.name, definition as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getEnabledTools(): ToolDefinition[] {
    const enabledProfiles = new Set(getEnabledProfiles(this.currentProfile));
    return Array.from(this.tools.values()).filter((t) => enabledProfiles.has(t.profile));
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Register all enabled tools onto an MCP server.
   *  Each handler is wrapped with:
   *    - confirmWrite gate  (rejects calls that omit the required acknowledgment)
   *    - structured error codes
   *    - bridge‑disconnected friendly error interception
   */
  registerAllOnServer(server: McpServer, context: ToolContext): void {
    for (const tool of this.getEnabledTools()) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: registeredInputSchema(tool, context),
          outputSchema: registeredOutputSchema(tool),
          annotations: tool.annotations,
        },
        async (input: unknown, extra: unknown) =>
          handleRegisteredToolCall(tool, context, input, extra),
      );
    }
  }

  /** Return rich metadata for every enabled tool. */
  getToolDefinitions(): ToolMetadata[] {
    const enabled = this.getEnabledTools();
    return enabled.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      profile: t.profile,
      risk: t.risk,
      confirmWrite: t.confirmWrite,
      group: t.group,
      version: t.version,
      evidence: t.evidence,
      annotations: t.annotations,
    }));
  }

  /** Return a summary snapshot for diagnostics / health‑check endpoints. */
  getSummary(): { total: number; enabled: number; profile: ToolProfile; serverVersion: string } {
    return {
      total: this.tools.size,
      enabled: this.getEnabledTools().length,
      profile: this.currentProfile,
      serverVersion: SERVER_VERSION,
    };
  }
}

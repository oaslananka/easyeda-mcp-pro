import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ToolDefinition, type ToolContext } from './types.js';
import {
  registeredOutputSchema,
  getRawInput,
  parseWriteMode,
  omitWriteControls,
  writePlanResponse,
} from './transaction.js';
import { type ToolProfile, getEnabledProfiles } from '../config/profiles.js';
import { ZodError, type z } from 'zod';
import { SERVER_VERSION } from '../config/version.js';

// ── Structured error codes ────────────────────────────────────────────────

export const ErrorCodes = {
  CONFIRM_WRITE_REQUIRED: 'ERR_CONFIRM_WRITE_REQUIRED',
  BRIDGE_DISCONNECTED: 'ERR_BRIDGE_DISCONNECTED',
  TOOL_EXECUTION: 'ERR_TOOL_EXECUTION',
  TOOL_NOT_FOUND: 'ERR_TOOL_NOT_FOUND',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  TOOL_OUTPUT_INVALID: 'ERR_TOOL_OUTPUT_INVALID',
  FORBIDDEN_SCOPE: 'ERR_FORBIDDEN_SCOPE',
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

export function getRequiredToolScopes(tool: ToolDefinition): string[] {
  if (tool.name === 'easyeda_execute') return ['bridge:execute'];
  if (tool.name === 'easyeda_api_call') return [tool.confirmWrite ? 'api:write' : 'api:read'];
  if (tool.name === 'easyeda_api_inventory' || tool.name === 'easyeda_component_probe') {
    return ['api:read'];
  }

  switch (tool.group) {
    case 'diagnostics':
      return ['diagnostics:read'];
    case 'schematic':
      return [tool.confirmWrite ? 'schematic:write' : 'schematic:read'];
    case 'bom':
      return [tool.name.includes('sourcing') ? 'bom:source' : 'bom:read'];
    case 'drc-erc':
      return ['checks:read'];
    case 'board':
    case 'pcb-constraints':
      return ['pcb:read'];
    case 'pcb-write':
      return ['pcb:write'];
    case 'export':
      return ['export:write'];
    default:
      return [tool.confirmWrite ? WRITE_ALL_SCOPE : READ_ALL_SCOPE];
  }
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
          inputSchema: tool.inputSchema,
          outputSchema: registeredOutputSchema(tool),
          annotations: tool.annotations,
        },
        async (input: unknown) => {
          try {
            const raw = getRawInput(input);
            const writeMode = parseWriteMode(raw);
            if (writeMode instanceof ZodError) {
              return structuredErrorResponse({
                errorCode: ErrorCodes.INVALID_INPUT,
                message: `Invalid writeMode for "${tool.name}": ${writeMode.message}`,
                details: { toolName: tool.name, issues: writeMode.issues },
              });
            }

            // ── Capability scope gate ────────────────────────────
            const allowedScopes = parseToolScopes(context.config.TOOL_SCOPES);
            const requiredScopes = getRequiredToolScopes(tool);
            if (!hasRequiredToolScopes(allowedScopes, requiredScopes)) {
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

            // ── Write transaction planning / preview / verification ─────
            if (tool.confirmWrite && writeMode !== 'apply') {
              const parsedPlan = tool.inputSchema.safeParse({ ...raw, confirmWrite: true });
              if (!parsedPlan.success) {
                return structuredErrorResponse({
                  errorCode: ErrorCodes.INVALID_INPUT,
                  message: `Invalid input for "${tool.name}": ${parsedPlan.error.message}`,
                  details: { toolName: tool.name, issues: parsedPlan.error.issues },
                });
              }
              return writePlanResponse(
                tool,
                writeMode,
                omitWriteControls(parsedPlan.data),
                requiredScopes,
              );
            }

            // ── confirmWrite gate for apply ─────────────────────────────
            if (tool.confirmWrite && raw.confirmWrite !== true) {
              return structuredErrorResponse({
                errorCode: ErrorCodes.CONFIRM_WRITE_REQUIRED,
                message: `Tool "${tool.name}" can mutate design state and requires confirmWrite=true.`,
                details: { toolName: tool.name, toolGroup: tool.group, risk: tool.risk },
              });
            }

            // ── Parse & execute ───────────────────────────────────────
            const parsed = tool.inputSchema.parse(input ?? {});
            const result = await tool.handler(context, parsed);
            const output = tool.outputSchema.safeParse(result);

            if (!output.success) {
              return structuredErrorResponse({
                errorCode: ErrorCodes.TOOL_OUTPUT_INVALID,
                message: `Tool "${tool.name}" returned output that does not match its declared outputSchema.`,
                details: { toolName: tool.name, issues: output.error.issues },
              });
            }

            const structuredContent =
              typeof output.data === 'object' && output.data !== null
                ? (output.data as Record<string, unknown>)
                : { value: output.data };
            return {
              structuredContent,
              content: [{ type: 'text' as const, text: JSON.stringify(output.data, null, 2) }],
            };
          } catch (err) {
            // ── Zod validation errors ─────────────────────────────────
            if (err instanceof ZodError) {
              return structuredErrorResponse({
                errorCode: ErrorCodes.INVALID_INPUT,
                message: `Invalid input for "${tool.name}": ${err.message}`,
                details: { toolName: tool.name, issues: err.issues },
              });
            }

            // ── Bridge-disconnected interception ──────────────────────
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Bridge not connected') || msg.includes('Bridge disconnected')) {
              return bridgeDisconnectedResponse(
                context.config.bridgeHost,
                String(context.config.bridgePort),
              );
            }

            // ── Generic execution error ───────────────────────────────
            return structuredErrorResponse({
              errorCode: ErrorCodes.TOOL_EXECUTION,
              message: `Tool "${tool.name}" failed: ${msg}`,
              details: { toolName: tool.name },
            });
          }
        },
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

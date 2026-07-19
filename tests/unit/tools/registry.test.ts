import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, ErrorCodes, remoteRiskForTool } from '../../../src/tools/registry.js';
import { type ToolDefinition, type ToolContext } from '../../../src/tools/types.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import { checkRemoteScope, requiredScopeForRisk } from '../../../src/remote/scope.js';
import { registeredOutputSchema, writePlanOutputSchema } from '../../../src/tools/transaction.js';
import {
  getGlobalMetricsCollector,
  resetGlobalMetricsCollector,
} from '../../../src/observability/index.js';

// ── Default test config ───────────────────────────────────────────────────

const TEST_CONFIG = EnvSchema.parse({ NODE_ENV: 'test' });

// ── Helpers ───────────────────────────────────────────────────────────────

function createMockTool(
  name: string,
  profile: 'core' | 'pro' | 'full' | 'dev' = 'core',
  overrides?: Partial<ToolDefinition>,
): ToolDefinition {
  return {
    name,
    title: name,
    description: `Test tool ${name}`,
    profile,
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'test',
    version: '1.0.0',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

/** Build a minimal mock MCP server that captures registered handlers. */
function mockMcpServer(): {
  server: Record<string, any>;
  handlers: Map<string, (input: unknown) => Promise<any>>;
} {
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  const server = {
    registerTool: (name: string, _definition: any, handler: (input: unknown) => Promise<any>) => {
      handlers.set(name, handler);
    },
  };
  return { server, handlers };
}

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    profile: 'core',
    bridge: { connected: false, call: vi.fn() },
    config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
    vendors: {
      lcsc: null,
      jlcpcb: null,
      mouser: null,
      digikey: null,
    },
    ...overrides,
  };
}

// ── Required-field keys (every tool definition must have these) ────────────

const REQUIRED_TOOL_KEYS: (keyof ToolDefinition)[] = [
  'name',
  'title',
  'description',
  'profile',
  'evidence',
  'risk',
  'confirmWrite',
  'group',
  'version',
  'annotations',
  'inputSchema',
  'outputSchema',
  'handler',
];

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    resetGlobalMetricsCollector();
  });

  describe('basic operations', () => {
    it('should register and retrieve a tool', () => {
      const tool = createMockTool('test_tool');
      registry.register(tool);
      expect(registry.get('test_tool')).toBeDefined();
    });

    it('should throw on duplicate registration', () => {
      registry.register(createMockTool('dup_tool'));
      expect(() => registry.register(createMockTool('dup_tool'))).toThrow(/already registered/);
    });

    it('should return only core tools by default', () => {
      registry.register(createMockTool('core_tool', 'core'));
      registry.register(createMockTool('pro_tool', 'pro'));
      registry.register(createMockTool('full_tool', 'full'));

      const enabled = registry.getEnabledTools();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.name).toBe('core_tool');
    });

    it('should include pro tools when profile is pro', () => {
      registry.register(createMockTool('core_tool', 'core'));
      registry.register(createMockTool('pro_tool', 'pro'));
      registry.setProfile('pro');

      const enabled = registry.getEnabledTools();
      expect(enabled).toHaveLength(2);
    });

    it('should return empty for unknown tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return all tools', () => {
      registry.register(createMockTool('a', 'core'));
      registry.register(createMockTool('b', 'pro'));
      const all = registry.getAllTools();
      expect(all).toHaveLength(2);
    });
  });

  describe('observability instrumentation', () => {
    it('records successful tool duration through registry wrapper', async () => {
      registry.register(createMockTool('observed_tool', 'core'));
      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('observed_tool')!({});
      const snapshot = getGlobalMetricsCollector().snapshot();

      expect(response.isError).toBeFalsy();
      expect(snapshot.byCategory.analysis.count).toBe(1);
      expect(snapshot.byCategory.analysis.ok).toBe(1);
    });

    it('records failed tool duration through registry wrapper', async () => {
      registry.register(
        createMockTool('observed_failure', 'core', {
          handler: async () => {
            throw new Error('boom');
          },
        }),
      );
      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('observed_failure')!({});
      const snapshot = getGlobalMetricsCollector().snapshot();

      expect(response.isError).toBe(true);
      expect(snapshot.byCategory.analysis.errors).toBe(1);
    });
  });

  describe('getToolDefinitions', () => {
    it('should return metadata for each enabled tool', () => {
      registry.register(createMockTool('tool_a', 'core'));
      registry.register(createMockTool('tool_b', 'pro'));
      registry.setProfile('pro');

      const defs = registry.getToolDefinitions();
      expect(defs).toHaveLength(2);
      for (const d of defs) {
        expect(d).toHaveProperty('name');
        expect(d).toHaveProperty('title');
        expect(d).toHaveProperty('description');
        expect(d).toHaveProperty('profile');
        expect(d).toHaveProperty('risk');
        expect(d).toHaveProperty('confirmWrite');
        expect(d).toHaveProperty('group');
        expect(d).toHaveProperty('version');
        expect(d).toHaveProperty('evidence');
        expect(d).toHaveProperty('annotations');
      }
    });
  });

  describe('getSummary', () => {
    it('should return correct summary snapshot', () => {
      registry.register(createMockTool('t1', 'core'));
      registry.register(createMockTool('t2', 'full'));

      const summary = registry.getSummary();
      expect(summary).toMatchObject({
        total: 2,
        enabled: 1, // core only by default
        profile: 'core',
      });
      expect(typeof summary.serverVersion).toBe('string');
    });
  });

  describe('confirmWrite gate (registry level)', () => {
    it('should reject confirmWrite=true tool when confirmWrite is not true in input', async () => {
      const mutableTool = createMockTool('mutable_tool', 'core', {
        confirmWrite: true,
        risk: 'high',
      });
      registry.register(mutableTool);

      const { server, handlers } = mockMcpServer();
      const ctx = mockContext();
      registry.registerAllOnServer(server as any, ctx);

      const handler = handlers.get('mutable_tool');
      expect(handler).toBeDefined();

      const response = await handler!({});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('ERR_CONFIRM_WRITE_REQUIRED');
      expect(response.content[0].text).toContain('confirmWrite=true');
    });

    it('should allow confirmWrite=true tool when input has confirmWrite: true', async () => {
      const mutableTool = createMockTool('mutable_tool', 'core', {
        confirmWrite: true,
        risk: 'high',
        outputSchema: z.object({ ok: z.boolean(), written: z.boolean() }),
        handler: async () => ({ ok: true, written: true }),
      });
      registry.register(mutableTool);

      const { server, handlers } = mockMcpServer();
      const ctx = mockContext();
      registry.registerAllOnServer(server as any, ctx);

      const handler = handlers.get('mutable_tool');
      expect(handler).toBeDefined();

      const response = await handler!({ confirmWrite: true });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({ ok: true, written: true });
    });

    it('should return a write transaction plan without executing the handler', async () => {
      const handler = vi.fn(async () => ({ ok: true, written: true }));
      const mutableTool = createMockTool('planned_tool', 'core', {
        confirmWrite: true,
        risk: 'high',
        inputSchema: z.object({
          name: z.string(),
          confirmWrite: z.literal(true),
        }),
        outputSchema: z.object({ ok: z.boolean(), written: z.boolean() }),
        handler,
      });
      registry.register(mutableTool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('planned_tool')!({ name: 'R1', writeMode: 'plan' });

      expect(handler).not.toHaveBeenCalled();
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        success: true,
        transaction: {
          toolName: 'planned_tool',
          phase: 'plan',
          willApply: false,
          bridgeCallRequired: false,
          confirmWriteRequired: true,
          inputPreview: { name: 'R1' },
          nextStep: { writeMode: 'apply', confirmWrite: true },
        },
      });
    });

    it('should reject invalid writeMode before execution', async () => {
      const handler = vi.fn(async () => ({ ok: true, written: true }));
      const mutableTool = createMockTool('bad_write_mode', 'core', {
        confirmWrite: true,
        risk: 'high',
        outputSchema: z.object({ ok: z.boolean(), written: z.boolean() }),
        handler,
      });
      registry.register(mutableTool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('bad_write_mode')!({
        confirmWrite: true,
        writeMode: 'simulate',
      });

      expect(handler).not.toHaveBeenCalled();
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.INVALID_INPUT);
      expect(response.content[0].text).toContain('writeMode');
    });

    it('should not block confirmWrite=false tools', async () => {
      const readOnlyTool = createMockTool('readonly_tool', 'core', {
        confirmWrite: false,
        handler: async () => ({ ok: true }),
      });
      registry.register(readOnlyTool);

      const { server, handlers } = mockMcpServer();
      const ctx = mockContext();
      registry.registerAllOnServer(server as any, ctx);

      const handler = handlers.get('readonly_tool');
      expect(handler).toBeDefined();

      const response = await handler!({});
      expect(response.isError).toBeFalsy();
    });
  });

  describe('image content', () => {
    it('appends an image content block when the tool defines imageContent', async () => {
      const tool = createMockTool('image_tool', 'core', {
        outputSchema: z.object({ ok: z.boolean(), image_base64: z.string().optional() }),
        handler: async () => ({ ok: true, image_base64: 'ZmFrZS1wbmctYnl0ZXM=' }),
        imageContent: (output) =>
          output.image_base64 ? [{ data: output.image_base64, mimeType: 'image/png' }] : [],
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('image_tool')!({});

      expect(response.isError).toBeFalsy();
      expect(response.content).toHaveLength(2);
      expect(response.content[0]).toMatchObject({ type: 'text' });
      expect(response.content[1]).toEqual({
        type: 'image',
        data: 'ZmFrZS1wbmctYnl0ZXM=',
        mimeType: 'image/png',
      });
    });

    it('omits imageContentOmitFields from structuredContent and the text block once an image block exists', async () => {
      const tool = createMockTool('deduped_image_tool', 'core', {
        outputSchema: z.object({
          ok: z.boolean(),
          image_base64: z.string().optional(),
          other: z.string(),
        }),
        handler: async () => ({ ok: true, image_base64: 'ZmFrZS1wbmctYnl0ZXM=', other: 'kept' }),
        imageContent: (output) =>
          output.image_base64 ? [{ data: output.image_base64, mimeType: 'image/png' }] : [],
        imageContentOmitFields: ['image_base64'],
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('deduped_image_tool')!({});

      // The image is still delivered exactly once, as its own content block...
      expect(response.content).toHaveLength(2);
      expect(response.content[1]).toEqual({
        type: 'image',
        data: 'ZmFrZS1wbmctYnl0ZXM=',
        mimeType: 'image/png',
      });
      // ...but is no longer duplicated into structuredContent or the JSON text block.
      expect(response.structuredContent).toEqual({ ok: true, other: 'kept' });
      expect(response.content[0].text).not.toContain('ZmFrZS1wbmctYnl0ZXM=');
      expect(response.content[0].text).toContain('kept');
    });

    it('does not add an image block when imageContent returns an empty array', async () => {
      const tool = createMockTool('no_image_tool', 'core', {
        outputSchema: z.object({ ok: z.boolean() }),
        handler: async () => ({ ok: true }),
        imageContent: () => [],
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('no_image_tool')!({});
      expect(response.content).toHaveLength(1);
    });

    it('does not add an image block for tools that omit imageContent entirely', async () => {
      const tool = createMockTool('plain_tool', 'core');
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('plain_tool')!({});
      expect(response.content).toHaveLength(1);
    });
  });

  describe('capability scope gate', () => {
    it('should allow all tools when TOOL_SCOPES is empty', async () => {
      const tool = createMockTool('scope_default_allow', 'core');
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const response = await handlers.get('scope_default_allow')!({});
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({ ok: true });
    });

    it('should reject a tool when configured scopes do not include the required capability', async () => {
      const tool = createMockTool('scope_denied_write', 'core', {
        group: 'schematic',
        confirmWrite: true,
        risk: 'high',
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(
        server as any,
        mockContext({ config: { ...mockContext().config, TOOL_SCOPES: 'schematic:read' } }),
      );

      const response = await handlers.get('scope_denied_write')!({ confirmWrite: true });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.FORBIDDEN_SCOPE);
      expect(response.structuredContent).toMatchObject({
        errorCode: ErrorCodes.FORBIDDEN_SCOPE,
        details: { requiredScopes: ['schematic:write'] },
      });
    });

    it('should allow a tool when configured scopes include the required capability', async () => {
      const tool = createMockTool('scope_allowed_write', 'core', {
        group: 'schematic',
        confirmWrite: true,
        risk: 'high',
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(
        server as any,
        mockContext({ config: { ...mockContext().config, TOOL_SCOPES: 'schematic:write' } }),
      );

      const response = await handlers.get('scope_allowed_write')!({ confirmWrite: true });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({ ok: true });
    });
  });

  describe('structured error codes', () => {
    it('should return ERR_INVALID_INPUT on ZodError', async () => {
      const tool = createMockTool('zod_fail', 'core', {
        inputSchema: z.object({ requiredField: z.string() }),
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const handler = handlers.get('zod_fail');
      expect(handler).toBeDefined();

      // Missing required field
      const response = await handler!({});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.INVALID_INPUT);
    });

    it('should return ERR_TOOL_OUTPUT_INVALID when handler result violates outputSchema', async () => {
      const tool = createMockTool('bad_output', 'core', {
        outputSchema: z.object({ ok: z.boolean() }),
        handler: async () => ({ ok: 'not-a-boolean' }) as never,
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const handler = handlers.get('bad_output');
      expect(handler).toBeDefined();

      const response = await handler!({});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.TOOL_OUTPUT_INVALID);
      expect(response.structuredContent).toMatchObject({
        errorCode: ErrorCodes.TOOL_OUTPUT_INVALID,
        details: { toolName: 'bad_output' },
      });
    });

    it('should return ERR_TOOL_EXECUTION on generic handler failure', async () => {
      const tool = createMockTool('fail_tool', 'core', {
        confirmWrite: false,
        handler: async () => {
          throw new Error('Something went wrong');
        },
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const handler = handlers.get('fail_tool');
      expect(handler).toBeDefined();

      const response = await handler!({});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.TOOL_EXECUTION);
    });

    it('should return ERR_BRIDGE_DISCONNECTED on bridge error', async () => {
      const tool = createMockTool('bridge_fail', 'core', {
        handler: async () => {
          throw new Error('Bridge not connected');
        },
      });
      registry.register(tool);

      const { server, handlers } = mockMcpServer();
      registry.registerAllOnServer(server as any, mockContext());

      const handler = handlers.get('bridge_fail');
      expect(handler).toBeDefined();

      const response = await handler!({});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain(ErrorCodes.BRIDGE_DISCONNECTED);
    });

    it('should have all error codes defined and non-empty', () => {
      const codes = Object.values(ErrorCodes);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(code).toMatch(/^ERR_/);
        expect(code.length).toBeGreaterThan(5);
      }
    });
  });

  describe('tool completeness guard (real tools)', () => {
    it('every registered built-in tool must have all required fields', () => {
      registerBuiltinTools(registry, TEST_CONFIG);
      const allTools = registry.getAllTools();

      expect(allTools.length).toBeGreaterThan(20); // sanity: at least 20 tools

      for (const tool of allTools) {
        for (const key of REQUIRED_TOOL_KEYS) {
          expect(tool).toHaveProperty(key);
          // String fields must be non-empty
          if (key === 'name' || key === 'title' || key === 'group') {
            expect((tool as any)[key]).toBeTruthy();
          }
          // version must be semver-like
          if (key === 'version') {
            expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/);
          }
        }
        // confirmWrite must be boolean
        expect(typeof tool.confirmWrite).toBe('boolean');

        // group must be a known value
        expect([
          'diagnostics',
          'schematic',
          'bom',
          'drc-erc',
          'board',
          'export',
          'pcb-constraints',
          'pcb-write',
          'visual',
          'catalog',
          'design-rules',
          'workflows',
          'simulation',
          'project',
        ]).toContain(tool.group);

        // profile must be valid
        expect(['core', 'pro', 'full', 'dev', 'experimental']).toContain(tool.profile);

        // risk must be valid
        expect(['low', 'medium', 'high']).toContain(tool.risk);
      }
    });

    it('every confirmWrite:true tool has risk medium or high', () => {
      registerBuiltinTools(registry, TEST_CONFIG);
      const allTools = registry.getAllTools();

      for (const tool of allTools) {
        if (tool.confirmWrite) {
          expect(['medium', 'high']).toContain(tool.risk);
        }
      }
    });
  });

  describe('remote risk policy', () => {
    it.each([
      {
        label: 'high-risk confirmWrite tool',
        tool: createMockTool('high_write', 'core', { risk: 'high', confirmWrite: true }),
        expected: 'destructive',
      },
      {
        label: 'medium-risk confirmWrite tool',
        tool: createMockTool('medium_write', 'core', { risk: 'medium', confirmWrite: true }),
        expected: 'write',
      },
      {
        label: 'low-risk read tool',
        tool: createMockTool('low_read', 'core', { risk: 'low', confirmWrite: false }),
        expected: 'read',
      },
      {
        label: 'high-risk export tool',
        tool: createMockTool('high_export', 'core', {
          group: 'export',
          risk: 'high',
          confirmWrite: true,
        }),
        expected: 'export',
      },
      {
        label: 'raw execution tool',
        tool: createMockTool('easyeda_execute', 'dev', {
          risk: 'low',
          confirmWrite: false,
        }),
        expected: 'destructive',
      },
    ] as const)('classifies $label as $expected', ({ tool, expected }) => {
      expect(remoteRiskForTool(tool)).toBe(expected);
    });

    it('enumerates every built-in high-risk tool and classifies non-export tools as destructive', () => {
      registerBuiltinTools(registry, TEST_CONFIG);
      const highRiskTools = registry
        .getAllTools()
        .filter((tool) => tool.risk === 'high')
        .sort((left, right) => left.name.localeCompare(right.name));

      expect(highRiskTools.map((tool) => tool.name)).toEqual([
        'easyeda_api_call',
        'easyeda_pcb_add_track',
        'easyeda_pcb_add_via',
        'easyeda_pcb_add_zone',
        'easyeda_pcb_autoroute',
        'easyeda_pcb_delete_component',
        'easyeda_pcb_floorplan',
        'easyeda_pcb_modify_component',
        'easyeda_pcb_place_component',
        'easyeda_pcb_place_component_group',
        'easyeda_pcb_route_path_plan',
        'easyeda_schematic_batch_write',
        'easyeda_schematic_layout_autofix_apply',
      ]);

      for (const tool of highRiskTools) {
        expect(tool.group).not.toBe('export');
        expect(remoteRiskForTool(tool), tool.name).toBe('destructive');
      }
    });

    it('requires project_admin and rejects write-only identity for high-risk tools', () => {
      const riskLevel = remoteRiskForTool(
        createMockTool('high_scope_tool', 'core', { risk: 'high', confirmWrite: true }),
      );

      expect(requiredScopeForRisk(riskLevel)).toBe('easyeda.project_admin');
      expect(checkRemoteScope({ userId: 'writer', scopes: ['easyeda.write'] }, riskLevel)).toEqual({
        ok: false,
        code: 'SCOPE_MISSING',
        message: 'Remote tool requires easyeda.project_admin.',
      });
      expect(
        checkRemoteScope({ userId: 'admin', scopes: ['easyeda.project_admin'] }, riskLevel),
      ).toEqual({ ok: true });
    });
  });

  // ── Original tests preserved below ──────────────────────────────────────

  it('should expose runtime inventory in core and generic API call in full profile', () => {
    registerBuiltinTools(registry, TEST_CONFIG);

    expect(registry.get('easyeda_api_inventory')).toBeDefined();
    expect(registry.get('easyeda_api_call')).toBeDefined();
    expect(registry.getEnabledTools().some((tool) => tool.name === 'easyeda_api_inventory')).toBe(
      true,
    );
    expect(registry.getEnabledTools().some((tool) => tool.name === 'easyeda_api_call')).toBe(false);

    registry.setProfile('full');
    expect(registry.getEnabledTools().some((tool) => tool.name === 'easyeda_api_call')).toBe(true);
  });

  it('should not register easyeda_execute by default even for dev profile', () => {
    registry.setProfile('dev');
    registerBuiltinTools(registry, TEST_CONFIG);

    expect(registry.get('easyeda_execute')).toBeUndefined();
    expect(registry.getEnabledTools().some((tool) => tool.name === 'easyeda_execute')).toBe(false);
  });

  it('should register easyeda_execute only when both raw execution gates are enabled', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      BRIDGE_RAW_EXEC_ENABLED: 'true',
      MCP_RAW_EXEC_EXPERIMENTAL: 'true',
    });

    registry.setProfile('dev');
    registerBuiltinTools(registry, config);

    expect(registry.get('easyeda_execute')).toBeDefined();
    expect(registry.getEnabledTools().some((tool) => tool.name === 'easyeda_execute')).toBe(true);
  });

  it('should require confirmation before generic API write calls reach the bridge', async () => {
    registerBuiltinTools(registry, TEST_CONFIG);
    const tool = registry.get('easyeda_api_call');
    const bridgeCall = vi.fn();
    const context: ToolContext = {
      profile: 'full',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
    } as unknown as ToolContext;

    const result = await tool?.handler(context, {
      path: 'SCH_PrimitiveWire.create',
      args: [],
      confirmWrite: false,
    });

    expect(result).toMatchObject({
      ok: false,
      path: 'SCH_PrimitiveWire.create',
      requires_confirmation: true,
    });
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('should intercept "Bridge not connected" errors and return friendly error content', async () => {
    const tool = createMockTool('test_bridge_fail');
    tool.handler = async () => {
      throw new Error('Bridge not connected. Cannot call method "SCH_PrimitiveWire.getAll".');
    };
    registry.register(tool);

    let registeredHandler: ((input: unknown) => Promise<any>) | null = null;
    const mockMcpServer = {
      registerTool: (name: string, definition: any, handler: any) => {
        registeredHandler = handler;
      },
    } as unknown as any;

    const context: ToolContext = {
      profile: 'core',
      bridge: { connected: false, call: vi.fn() },
      config: { bridgeTimeoutMs: 1000, artifactDir: 'dir' },
    } as unknown as ToolContext;

    registry.registerAllOnServer(mockMcpServer, context);
    expect(registeredHandler).toBeDefined();

    const response = await registeredHandler!({});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Bridge connection failed');
    expect(response.content[0].text).toContain('EasyEDA Pro is not running');
  });
});

describe('registered output schema compatibility', () => {
  it('uses an open object schema for confirmWrite tools to avoid SDK union conversion crashes', () => {
    const tool = createMockTool('confirm_output_schema', 'core', { confirmWrite: true });
    const schema = registeredOutputSchema(tool);

    expect(schema.safeParse({ arbitrary: 'tool output' }).success).toBe(true);
    expect(schema.safeParse({ success: true, transaction: {} }).success).toBe(true);
  });

  it('keeps transaction plan schema strict for internal validation', () => {
    expect(writePlanOutputSchema.safeParse({ success: true, transaction: {} }).success).toBe(false);
  });
});

describe('ToolRegistry remote relay backend', () => {
  it('advertises relay session and approval controls in remote MCP tool schemas', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_schema',
      toolName: 'schematic.getDocument',
      result: { ok: true },
      durationMs: 1,
    }));
    const domainHandler = vi.fn(async (ctx: ToolContext, input: { query: string }) => {
      await ctx.bridge.call('schematic.getDocument', input);
      return { ok: true };
    });
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_schema_tool', 'core', {
        inputSchema: z.object({ query: z.string() }),
        handler: domainHandler as ToolDefinition['handler'],
      }),
    );

    let registeredDefinition: { inputSchema: z.ZodType } | undefined;
    let registeredHandler:
      ((input: unknown, extra: unknown) => Promise<Record<string, unknown>>) | undefined;
    registry.registerAllOnServer(
      {
        registerTool: (
          _name: string,
          definition: { inputSchema: z.ZodType },
          handler: (input: unknown, extra: unknown) => Promise<Record<string, unknown>>,
        ) => {
          registeredDefinition = definition;
          registeredHandler = handler;
        },
      } as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    const parsed = registeredDefinition?.inputSchema.parse({
      query: 'current',
      remoteSessionId: 'sess_schema',
      remoteApprovalId: 'appr_schema',
    }) as Record<string, unknown>;
    expect(parsed).toEqual({
      query: 'current',
      remoteSessionId: 'sess_schema',
      remoteApprovalId: 'appr_schema',
    });

    await registeredHandler?.(parsed, {
      authInfo: {
        clientId: 'client-schema',
        scopes: ['easyeda:read'],
        extra: { sub: 'user-schema' },
      },
    });

    expect(domainHandler).toHaveBeenCalledWith(expect.any(Object), { query: 'current' });
    expect(routeToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_schema',
        input: { query: 'current' },
      }),
    );
    expect(routeToolRequest.mock.calls[0]?.[0]).not.toHaveProperty('approvalId');
  });

  it('does not advertise Remote Relay controls in local bridge mode', () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('local_schema_tool', 'core', {
        inputSchema: z.object({ query: z.string() }),
      }),
    );
    let registeredInput: z.ZodType | undefined;
    registry.registerAllOnServer(
      {
        registerTool: (_name: string, definition: { inputSchema: z.ZodType }) => {
          registeredInput = definition.inputSchema;
        },
      } as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'local_bridge',
        },
      }),
    );

    expect(registeredInput).toBeInstanceOf(z.ZodObject);
    expect((registeredInput as z.ZodObject).shape).not.toHaveProperty('remoteSessionId');
    expect((registeredInput as z.ZodObject).shape).not.toHaveProperty('remoteApprovalId');
  });
  it('routes bridge calls through RemoteGateway when MCP_BRIDGE_BACKEND=remote_relay', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_1',
      toolName: 'schematic.listComponents',
      result: { ok: true },
      durationMs: 4,
    }));
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_read_tool', 'core', {
        inputSchema: z.object({ remoteSessionId: z.string().optional() }),
        handler: async (ctx) =>
          await ctx.bridge.call(
            'schematic.listComponents',
            { includeHidden: false },
            { timeoutMs: 123 },
          ),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    const headers = new Map<string, string>([
      ['x-remote-user-id', 'user-a'],
      ['x-remote-scopes', 'easyeda.read'],
    ]);
    const response = await handlers.get('remote_read_tool')!(
      { remoteSessionId: 'sess_1' },
      { requestInfo: { headers } },
    );

    expect(response.isError).toBeFalsy();
    expect(routeToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        toolName: 'schematic.listComponents',
        riskLevel: 'read',
        input: { includeHidden: false },
        deadlineMs: 123,
      }),
    );
    expect(routeToolRequest.mock.calls[0]?.[0].identity).toMatchObject({
      userId: 'user-a',
      scopes: ['easyeda.read'],
    });
  });

  it('classifies a high-risk confirmWrite tool as destructive for Remote Relay authorization', async () => {
    const authorizeToolInvocation = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_high_risk',
      grantId: 'grant_high_risk',
    }));
    const revokeInvocationGrant = vi.fn(() => true);
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_high_risk_tool', 'core', {
        risk: 'high',
        confirmWrite: true,
        inputSchema: z.object({ confirmWrite: z.literal(true) }),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
        remote: {
          gateway: { authorizeToolInvocation, revokeInvocationGrant } as any,
        },
      }),
    );

    const response = await handlers.get('remote_high_risk_tool')!(
      {
        confirmWrite: true,
        remoteSessionId: 'sess_high_risk',
        remoteApprovalId: 'approval_high_risk',
      },
      {
        authInfo: {
          clientId: 'client-a',
          scopes: ['easyeda:write'],
          extra: { sub: 'user-a' },
        },
      },
    );

    expect(response.isError).toBeFalsy();
    expect(authorizeToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'remote_high_risk_tool',
        riskLevel: 'destructive',
        approvalId: 'approval_high_risk',
      }),
    );
    expect(revokeInvocationGrant).toHaveBeenCalledWith('grant_high_risk');
  });

  it('authorizes a risky MCP invocation once and reuses its private grant for every bridge call', async () => {
    const authorizeToolInvocation = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_2',
      grantId: 'grant_1',
    }));
    const routeToolRequest = vi.fn(async (input: { toolName: string }) => ({
      ok: true as const,
      sessionId: 'sess_2',
      toolName: input.toolName,
      result: { ok: true },
      durationMs: 7,
    }));
    const revokeInvocationGrant = vi.fn(() => true);
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_export_tool', 'core', {
        group: 'export',
        risk: 'high',
        confirmWrite: true,
        inputSchema: z.object({ confirmWrite: z.boolean() }),
        handler: async (ctx) => {
          await ctx.bridge.call('board.prepareExport', { format: 'zip' });
          await ctx.bridge.call('board.exportGerbers', { format: 'zip' });
          return { ok: true };
        },
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
        remote: {
          gateway: {
            authorizeToolInvocation,
            routeToolRequest,
            revokeInvocationGrant,
          } as any,
        },
      }),
    );

    const response = await handlers.get('remote_export_tool')!(
      {
        confirmWrite: true,
        remoteSessionId: 'sess_2',
        remoteApprovalId: 'appr_1',
      },
      {
        authInfo: {
          clientId: 'client-a',
          scopes: ['easyeda:export'],
          extra: { sub: 'user-a' },
        },
      },
    );

    expect(response.isError).toBeFalsy();
    expect(authorizeToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_2',
        toolName: 'remote_export_tool',
        riskLevel: 'export',
        input: { confirmWrite: true },
        approvalId: 'appr_1',
      }),
    );
    expect(routeToolRequest).toHaveBeenCalledTimes(2);
    expect(routeToolRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sess_2',
        toolName: 'board.prepareExport',
        riskLevel: 'export',
        input: { format: 'zip' },
        grantId: 'grant_1',
      }),
    );
    expect(routeToolRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sess_2',
        toolName: 'board.exportGerbers',
        grantId: 'grant_1',
      }),
    );
    expect(revokeInvocationGrant).toHaveBeenCalledWith('grant_1');
    expect(routeToolRequest.mock.calls[0]?.[0].identity).toMatchObject({
      userId: 'user-a',
      scopes: ['easyeda.export'],
    });
  });

  it('uses the configured Remote Relay session id when request input omits one', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_configured',
      toolName: 'schematic.getDocument',
      result: { ok: true },
      durationMs: 2,
    }));
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_configured_session_tool', 'core', {
        handler: async (ctx) => await ctx.bridge.call('schematic.getDocument'),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
          MCP_REMOTE_SESSION_ID: 'sess_configured',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    const response = await handlers.get('remote_configured_session_tool')!({}, {});

    expect(response.isError).toBeFalsy();
    expect(routeToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess_configured' }),
    );
  });

  it('surfaces Remote Relay routing failures as structured tool errors', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: false as const,
      status: 424,
      code: 'SESSION_DISCONNECTED' as const,
      message: 'Paired EasyEDA extension is disconnected.',
    }));
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_failure_tool', 'core', {
        inputSchema: z.object({ remoteSessionId: z.string().optional() }),
        handler: async (ctx) => await ctx.bridge.call('schematic.getDocument'),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    const response = await handlers.get('remote_failure_tool')!({ remoteSessionId: 'missing' });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      errorCode: ErrorCodes.REMOTE_RELAY,
      details: {
        toolName: 'remote_failure_tool',
        remoteCode: 'SESSION_DISCONNECTED',
        status: 424,
      },
    });
    expect(response.content[0].text).toContain('SESSION_DISCONNECTED');
  });

  it('surfaces a missing RemoteGateway when remote backend is enabled', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_missing_gateway_tool', 'core', {
        handler: async (ctx) => await ctx.bridge.call('schematic.getDocument'),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
        },
      }),
    );

    const response = await handlers.get('remote_missing_gateway_tool')!({});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('no RemoteGateway is configured');
  });

  it('accepts Remote Relay identity from OAuth client id when no subject claim exists', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_client',
      toolName: 'schematic.getDocument',
      result: { ok: true },
      durationMs: 2,
    }));
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_client_identity_tool', 'core', {
        handler: async (ctx) => await ctx.bridge.call('schematic.getDocument'),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
          MCP_REMOTE_SESSION_ID: 'sess_client',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    await handlers.get('remote_client_identity_tool')!(
      {},
      {
        authInfo: { clientId: 'client-only', scopes: ['easyeda:read'], extra: {} },
      },
    );

    expect(routeToolRequest.mock.calls[0]?.[0].identity).toMatchObject({
      userId: 'client-only',
      scopes: ['easyeda.read'],
    });
  });

  it('ignores non-scalar debug identity headers instead of stringifying objects', async () => {
    const routeToolRequest = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess_headers',
      toolName: 'schematic.getDocument',
      result: { ok: true },
      durationMs: 2,
    }));
    const registry = new ToolRegistry();
    registry.register(
      createMockTool('remote_non_scalar_headers_tool', 'core', {
        handler: async (ctx) => await ctx.bridge.call('schematic.getDocument'),
      }),
    );
    const { server, handlers } = mockMcpServer();
    registry.registerAllOnServer(
      server as any,
      mockContext({
        config: {
          bridgeTimeoutMs: 1000,
          artifactDir: '.easyeda-mcp-pro/artifacts',
          bridgeHost: '127.0.0.1',
          bridgePort: 49620,
          MCP_BRIDGE_BACKEND: 'remote_relay',
          MCP_REMOTE_SESSION_ID: 'sess_headers',
        },
        remote: { gateway: { routeToolRequest } as any },
      }),
    );

    await handlers.get('remote_non_scalar_headers_tool')!(
      {},
      {
        requestInfo: { headers: { 'x-remote-user-id': { bad: 'object' } } },
      },
    );

    expect(routeToolRequest.mock.calls[0]?.[0].identity).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, ErrorCodes } from '../../../src/tools/registry.js';
import { type ToolDefinition, type ToolContext } from '../../../src/tools/types.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';

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

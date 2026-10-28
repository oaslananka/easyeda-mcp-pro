import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { EnvSchema, type EnvConfig } from '../../../src/config/env.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import {
  createLocalStdioTaskSession,
  resolveLocalStdioTaskPrincipal,
} from '../../../src/tasks/task-local-session.js';

function localFixture() {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TRANSPORT: 'stdio' });
  const registry = new ToolRegistry();
  registry.setProfile('core');
  registerBuiltinTools(registry, config);
  return { config, registry };
}

describe('trusted local stdio task session (no OAuth)', () => {
  it('mints one stable, unpredictable process-scoped owner with no token or sign-in', () => {
    const { config, registry } = localFixture();
    const session = createLocalStdioTaskSession(config, registry);
    const principal = resolveLocalStdioTaskPrincipal(session, config, registry);
    expect(principal?.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...principal!.allowedOperations].sort()).toEqual([
      'easyeda_bom_generate',
      'easyeda_pcb_components',
    ]);
    expect(resolveLocalStdioTaskPrincipal(session, config, registry)?.ownerId).toBe(
      principal?.ownerId,
    );
    const secondSession = createLocalStdioTaskSession(config, registry);
    expect(resolveLocalStdioTaskPrincipal(secondSession, config, registry)?.ownerId).not.toBe(
      principal?.ownerId,
    );
    expect(Object.keys(session)).toEqual(['mode']);
    expect(JSON.stringify(session)).not.toContain(principal!.ownerId);
  });

  it('cannot be created under HTTP or Remote Relay, even when on localhost', () => {
    const { config, registry } = localFixture();
    const session = createLocalStdioTaskSession(config, registry);
    const http = { ...config, TRANSPORT: 'http' } as EnvConfig;
    const relay = { ...config, MCP_BRIDGE_BACKEND: 'remote_relay' } as EnvConfig;
    expect(() => createLocalStdioTaskSession(http, registry)).toThrow('local stdio');
    expect(() => createLocalStdioTaskSession(relay, registry)).toThrow('local stdio');
    expect(resolveLocalStdioTaskPrincipal(session, http, registry)).toBeUndefined();
    expect(resolveLocalStdioTaskPrincipal(session, relay, registry)).toBeUndefined();
  });

  it('fails closed for copied JSON, client-supplied identity or a foreign registry', () => {
    const { config, registry } = localFixture();
    const session = createLocalStdioTaskSession(config, registry);
    for (const forged of [
      {},
      { mode: 'stdio' },
      JSON.parse(JSON.stringify(session)) as unknown,
      { mode: 'stdio', ownerId: 'alice' },
      'stdio',
      null,
    ])
      expect(resolveLocalStdioTaskPrincipal(forged, config, registry)).toBeUndefined();
    const otherRegistry = new ToolRegistry();
    otherRegistry.setProfile('core');
    registerBuiltinTools(otherRegistry, config);
    expect(resolveLocalStdioTaskPrincipal(session, config, otherRegistry)).toBeUndefined();
  });

  it('honors the real server TOOL_SCOPES parser, including the default empty scope', () => {
    const { config, registry } = localFixture();
    expect(config.TOOL_SCOPES).toBe('');
    const session = createLocalStdioTaskSession(config, registry);
    expect(resolveLocalStdioTaskPrincipal(session, config, registry)?.allowedOperations.size).toBe(
      2,
    );

    // Each configured scope has its own session; caller cannot widen the
    // original session by swapping config after startup.
    expect(
      resolveLocalStdioTaskPrincipal(session, { ...config, TOOL_SCOPES: '*' }, registry),
    ).toBeUndefined();
    const bom = { ...config, TOOL_SCOPES: 'bom:read' };
    expect([
      ...resolveLocalStdioTaskPrincipal(createLocalStdioTaskSession(bom, registry), bom, registry)!
        .allowedOperations,
    ]).toEqual(['easyeda_bom_generate']);
    const pcb = { ...config, TOOL_SCOPES: 'pcb:read' };
    expect([
      ...resolveLocalStdioTaskPrincipal(createLocalStdioTaskSession(pcb, registry), pcb, registry)!
        .allowedOperations,
    ]).toEqual(['easyeda_pcb_components']);
    const writeOnly = { ...config, TOOL_SCOPES: 'easyeda:write' };
    expect(
      resolveLocalStdioTaskPrincipal(
        createLocalStdioTaskSession(writeOnly, registry),
        writeOnly,
        registry,
      ),
    ).toBeUndefined();
    const bogus = { ...config, TOOL_SCOPES: 'unrelated:read' };
    expect(
      resolveLocalStdioTaskPrincipal(createLocalStdioTaskSession(bogus, registry), bogus, registry),
    ).toBeUndefined();
  });

  it('rechecks the actual enabled tool profile and read-only metadata on every request', () => {
    const { config, registry } = localFixture();
    const session = createLocalStdioTaskSession(config, registry);
    const bom = registry.get('easyeda_bom_generate')!;
    const pcb = registry.get('easyeda_pcb_components')!;
    const bomProfile = bom.profile;
    const pcbProfile = pcb.profile;
    try {
      bom.profile = 'experimental';
      pcb.profile = 'experimental';
      expect(resolveLocalStdioTaskPrincipal(session, config, registry)).toBeUndefined();
      bom.profile = bomProfile;
      pcb.profile = pcbProfile;

      bom.confirmWrite = true;
      expect([
        ...resolveLocalStdioTaskPrincipal(session, config, registry)!.allowedOperations,
      ]).toEqual(['easyeda_pcb_components']);
      bom.confirmWrite = false;

      pcb.sideEffect = 'design-mutation';
      expect([
        ...resolveLocalStdioTaskPrincipal(session, config, registry)!.allowedOperations,
      ]).toEqual(['easyeda_bom_generate']);
      pcb.sideEffect = 'read-only';
      pcb.annotations.readOnlyHint = false;
      expect([
        ...resolveLocalStdioTaskPrincipal(session, config, registry)!.allowedOperations,
      ]).toEqual(['easyeda_bom_generate']);
    } finally {
      bom.profile = bomProfile;
      pcb.profile = pcbProfile;
    }
  });

  it('does not modify stdio defaults or register Tasks protocol in production', () => {
    const { config } = localFixture();
    expect(config.TRANSPORT).toBe('stdio');
    expect(config.MCP_TASKS_ENABLED).toBe(false);
    expect(config.MCP_V2_EXPERIMENTAL).toBe(false);
  });
});

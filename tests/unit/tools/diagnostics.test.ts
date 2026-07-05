import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerDiagnosticsCore } from '../../../src/tools/L0_diagnostics_core.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Diagnostics Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<
    typeof vi.fn<(method: string, params?: unknown, opts?: unknown) => Promise<unknown>>
  >;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerDiagnosticsCore(registry, config);

    bridgeCall = vi.fn();

    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
        bridgeHost: '127.0.0.1',
        bridgePort: 49620,
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('easyeda_health_check returns ok when bridge connected', async () => {
    const tool = registry.get('easyeda_health_check');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {});

    expect(result).toBeDefined();
    expect(result?.status).toBe('ok');
    expect(result?.bridge_connected).toBe(true);
    expect(result?.profile).toBe('core');
    expect(result?.version).toBeDefined();
    expect(result?.node_version).toBeDefined();
    expect(result?.transport).toBe('stdio');
    expect(result?.ups).toBeGreaterThanOrEqual(0);
    expect(result?.keyless_sourcing_enabled).toBe(true);
    expect(result?.catalog_device_count).toBeGreaterThan(0);
    expect(result?.extension_version_mismatch).toBe(false);
  });

  it('easyeda_health_check returns degraded when bridge not connected', async () => {
    const tool = registry.get('easyeda_health_check');
    expect(tool).toBeDefined();

    const disconnectedContext: ToolContext = {
      ...context,
      bridge: {
        connected: false,
        call: bridgeCall,
      },
    };

    const result = await tool?.handler(disconnectedContext, {});

    expect(result?.status).toBe('degraded');
    expect(result?.bridge_connected).toBe(false);
  });

  it('easyeda_health_check surfaces EasyEDA version and extension version mismatch', async () => {
    const tool = registry.get('easyeda_health_check');

    const mismatchContext: ToolContext = {
      ...context,
      bridge: {
        connected: true,
        call: bridgeCall,
        easyedaVersion: '2.1.0',
        extensionVersion: '0.0.1',
        extensionVersionMismatch: true,
      },
    };

    const result = await tool?.handler(mismatchContext, {});

    expect(result?.status).toBe('degraded');
    expect(result?.easyeda_version).toBe('2.1.0');
    expect(result?.extension_version).toBe('0.0.1');
    expect(result?.extension_version_mismatch).toBe(true);
  });

  it('easyeda_health_check reflects keylessSourcingEnabled=false from ctx.config', async () => {
    const tool = registry.get('easyeda_health_check');

    const disabledContext: ToolContext = {
      ...context,
      config: { ...context.config, keylessSourcingEnabled: false },
    };

    const result = await tool?.handler(disabledContext, {});
    expect(result?.keyless_sourcing_enabled).toBe(false);
  });

  it('easyeda_bridge_status returns connected status with bridge details', async () => {
    const tool = registry.get('easyeda_bridge_status');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      bridgeVersion: '1.2.3',
      easyedaVersion: '2.0.0',
      capabilities: ['bom', 'export'],
      devMode: false,
      lastHeartbeatMs: 500,
    });

    const result = await tool?.handler(context, {});

    expect(bridgeCall).toHaveBeenCalledWith('system.getStatus', {});
    expect(result).toBeDefined();
    expect(result?.connected).toBe(true);
    expect(result?.bridge_version).toBe('1.2.3');
    expect(result?.easyeda_version).toBe('2.0.0');
    expect(result?.capabilities).toEqual(['bom', 'export']);
    expect(result?.dev_mode).toBe(false);
    expect(result?.last_heartbeat_ms).toBe(500);
    expect(result?.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('easyeda_bridge_status returns disconnected when bridge not connected', async () => {
    const tool = registry.get('easyeda_bridge_status');
    expect(tool).toBeDefined();

    const disconnectedContext: ToolContext = {
      ...context,
      bridge: {
        connected: false,
        call: bridgeCall,
      },
    };

    const result = await tool?.handler(disconnectedContext, {});

    expect(result?.connected).toBe(false);
    expect(result?.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('easyeda_bridge_status handles bridge call error gracefully', async () => {
    const tool = registry.get('easyeda_bridge_status');
    expect(tool).toBeDefined();

    bridgeCall.mockRejectedValue(new Error('Bridge timeout'));

    const result = await tool?.handler(context, {});

    expect(result?.connected).toBe(true);
    expect(result?.status_error).toBe('Bridge timeout');
    expect(result?.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('easyeda_get_capabilities returns profiles and feature flags', async () => {
    const tool = registry.get('easyeda_get_capabilities');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {});

    expect(result).toBeDefined();
    expect(result?.server_name).toBe('easyeda-mcp-pro');
    expect(result?.server_version).toBeDefined();
    expect(result?.protocol_version).toBeDefined();
    expect(result?.profiles).toBeInstanceOf(Array);
    expect(result?.profiles.length).toBeGreaterThan(0);
    expect(result?.current_profile).toBe('core');
    expect(result?.feature_flags).toBeDefined();
    expect(result?.transports).toEqual(['stdio']);
  });

  it('easyeda_get_server_config returns redacted config', async () => {
    const tool = registry.get('easyeda_get_server_config');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, { include_flags: false });

    expect(result).toBeDefined();
    expect(result?.node_env).toBe('test');
    expect(result?.log_level).toBeDefined();
    expect(result?.profile).toBe('core');
    expect(result?.transport).toBe('stdio');
    expect(result?.bridge_host).toBe('127.0.0.1');
    expect(result?.bridge_port).toBe(49620);
    expect(result?.mcp_protocol_version).toBeDefined();
  });

  it('easyeda_get_tool_profiles returns profile list', async () => {
    const tool = registry.get('easyeda_get_tool_profiles');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {});

    expect(result).toBeDefined();
    expect(result?.current).toBe('core');
    expect(result?.profiles).toBeInstanceOf(Array);
    expect(result?.profiles.length).toBeGreaterThan(0);
    const activeProfile = result?.profiles.find((p) => p.is_active);
    expect(activeProfile?.name).toBe('core');
  });

  it('easyeda_get_feature_flags returns flag values', async () => {
    const tool = registry.get('easyeda_get_feature_flags');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {});

    expect(result).toBeDefined();
    expect(result?.flags).toBeDefined();
    expect(typeof result?.flags.mcp_tasks_enabled).toBe('boolean');
    expect(typeof result?.flags.mcp_apps_enabled).toBe('boolean');
    expect(typeof result?.flags.jlcpcb_ordering_enabled).toBe('boolean');
    expect(typeof result?.flags.ai_enabled).toBe('boolean');
  });

  it('easyeda_run_self_test returns check results', async () => {
    const tool = registry.get('easyeda_run_self_test');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {});

    expect(result).toBeDefined();
    expect(result?.passed).toBe(true);
    expect(result?.checks).toBeInstanceOf(Array);
    expect(result?.checks.length).toBeGreaterThan(0);

    const configCheck = result?.checks.find((c) => c.name === 'config_valid');
    expect(configCheck?.status).toBe('pass');

    const bridgeCheck = result?.checks.find((c) => c.name === 'bridge_connected');
    expect(bridgeCheck?.status).toBe('pass');
  });

  it('easyeda_run_self_test warns when bridge not connected', async () => {
    const tool = registry.get('easyeda_run_self_test');
    expect(tool).toBeDefined();

    const disconnectedContext: ToolContext = {
      ...context,
      bridge: {
        connected: false,
        call: bridgeCall,
      },
    };

    const result = await tool?.handler(disconnectedContext, {});

    expect(result?.passed).toBe(false);

    const bridgeCheck = result?.checks.find((c) => c.name === 'bridge_connected');
    expect(bridgeCheck?.status).toBe('warn');
    expect(bridgeCheck?.message).toBe('Bridge not connected');

    const versionCheck = result?.checks.find((c) => c.name === 'easyeda_version_detected');
    expect(versionCheck?.status).toBe('skipped');
  });

  it('easyeda_run_self_test passes easyeda_version_detected when the version is known', async () => {
    const tool = registry.get('easyeda_run_self_test');

    const versionedContext: ToolContext = {
      ...context,
      bridge: { connected: true, call: bridgeCall, easyedaVersion: '2.1.0' },
    };

    const result = await tool?.handler(versionedContext, {});
    const versionCheck = result?.checks.find((c) => c.name === 'easyeda_version_detected');
    expect(versionCheck?.status).toBe('pass');
    expect(versionCheck?.message).toContain('2.1.0');
    expect(result?.passed).toBe(true);
  });

  it('easyeda_run_self_test warns on extension_version_match when versions differ', async () => {
    const tool = registry.get('easyeda_run_self_test');

    const mismatchContext: ToolContext = {
      ...context,
      bridge: {
        connected: true,
        call: bridgeCall,
        extensionVersion: '0.0.1',
        extensionVersionMismatch: true,
      },
    };

    const result = await tool?.handler(mismatchContext, {});
    const extCheck = result?.checks.find((c) => c.name === 'extension_version_match');
    expect(extCheck?.status).toBe('warn');
    expect(result?.passed).toBe(false);
  });
});

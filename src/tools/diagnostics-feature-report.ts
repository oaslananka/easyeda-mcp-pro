import { type EnvConfig } from '../config/env.js';
import { loadFeatureFlags } from '../config/feature-flags.js';

export function buildCapabilityFeatureFlags(config: EnvConfig): Record<string, boolean> {
  const flags = loadFeatureFlags(config);
  return {
    tasks_enabled: flags.mcpTasksEnabled,
    apps_enabled: flags.mcpAppsEnabled,
    v2_experimental: flags.mcpV2Experimental,
    ordering_enabled: flags.jlcpcbOrderingEnabled,
  };
}

export function buildServerConfigFeatureFlags(config: EnvConfig): Record<string, boolean> {
  const flags = loadFeatureFlags(config);
  return {
    mcp_tasks_enabled: flags.mcpTasksEnabled,
    mcp_apps_enabled: flags.mcpAppsEnabled,
    mcp_v2_experimental: flags.mcpV2Experimental,
    ai_enabled: flags.aiEnabled,
    otel_enabled: flags.otelEnabled,
  };
}

export function buildDetailedFeatureFlags(config: EnvConfig): Record<string, boolean> {
  const flags = loadFeatureFlags(config);
  return {
    mcp_tasks_enabled: flags.mcpTasksEnabled,
    mcp_apps_enabled: flags.mcpAppsEnabled,
    mcp_v2_experimental: flags.mcpV2Experimental,
    jlcpcb_ordering_enabled: flags.jlcpcbOrderingEnabled,
    jlcsearch_enabled: flags.jlcsearchEnabled,
    mouser_enabled: flags.mouserEnabled,
    digikey_enabled: flags.digikeyEnabled,
    oauth_enabled: flags.oauthEnabled,
    otel_enabled: flags.otelEnabled,
    ai_enabled: flags.aiEnabled,
    dev_bridge: flags.devBridge,
    bridge_raw_exec_enabled: flags.bridgeRawExecEnabled,
    raw_exec_experimental: flags.rawExecExperimental,
  };
}

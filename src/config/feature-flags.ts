import { type EnvConfig } from './env.js';
import { getFeatureMaturity } from './feature-maturity.js';

export interface FeatureFlags {
  mcpTasksEnabled: boolean;
  mcpAppsEnabled: boolean;
  mcpV2Experimental: boolean;
  jlcpcbOrderingEnabled: boolean;
  jlcsearchEnabled: boolean;
  mouserEnabled: boolean;
  digikeyEnabled: boolean;
  oauthEnabled: boolean;
  otelEnabled: boolean;
  aiEnabled: boolean;
  devBridge: boolean;
  bridgeRawExecEnabled: boolean;
  rawExecExperimental: boolean;
}

export function loadFeatureFlags(config: EnvConfig): FeatureFlags {
  const maturity = getFeatureMaturity(config);
  return {
    mcpTasksEnabled: maturity.mcp_tasks.effective,
    mcpAppsEnabled: maturity.mcp_apps.effective,
    mcpV2Experimental: maturity.mcp_v2.effective,
    jlcpcbOrderingEnabled: config.JLCPCB_ENABLE_ORDERING,
    jlcsearchEnabled: config.JLCSEARCH_ENABLED,
    mouserEnabled: config.MOUSER_ENABLED,
    digikeyEnabled: config.DIGIKEY_ENABLED,
    oauthEnabled: maturity.oauth.effective,
    otelEnabled: maturity.otel_export.effective,
    aiEnabled: maturity.ai_provider.effective,
    devBridge: config.EASYEDA_DEV_BRIDGE,
    bridgeRawExecEnabled: config.BRIDGE_RAW_EXEC_ENABLED,
    rawExecExperimental: config.MCP_RAW_EXEC_EXPERIMENTAL,
  };
}

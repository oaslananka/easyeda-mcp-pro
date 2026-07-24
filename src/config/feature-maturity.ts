import { type EnvConfig } from './env.js';

export type FeatureMaturity = 'implemented' | 'experimental' | 'reserved';

export interface FeatureMaturityEntry {
  maturity: FeatureMaturity;
  configured: boolean;
  effective: boolean;
  note: string;
}

export type FeatureMaturityReport = Record<string, FeatureMaturityEntry>;

/**
 * Describe user-visible configuration independently from whether a value was set.
 * Reserved settings remain parseable for compatibility but cannot be reported as
 * active until a runtime implementation consumes them.
 */
export function getFeatureMaturity(config: EnvConfig): FeatureMaturityReport {
  return {
    mcp_tasks: {
      maturity: 'reserved',
      configured: config.MCP_TASKS_ENABLED,
      effective: false,
      note: 'The setting is reserved; this server does not advertise or execute MCP Tasks.',
    },
    mcp_apps: {
      maturity: 'reserved',
      configured: config.MCP_APPS_ENABLED,
      effective: false,
      note: 'The setting is reserved; no MCP Apps UI/resource runtime is registered.',
    },
    mcp_v2: {
      maturity: 'reserved',
      configured: config.MCP_V2_EXPERIMENTAL,
      effective: false,
      note: 'The setting is reserved and does not change the negotiated MCP protocol.',
    },
    ai_provider: {
      maturity: 'reserved',
      configured: config.AI_PROVIDER !== 'none',
      effective: false,
      note: 'Provider/model settings are reserved; no in-process AI provider is invoked.',
    },
    otel_export: {
      maturity: 'reserved',
      configured: config.OTEL_ENABLED,
      effective: false,
      note: 'OTLP settings are reserved; the current observability path is local structured metrics.',
    },
    remote_relay: {
      maturity: 'experimental',
      configured: config.MCP_BRIDGE_BACKEND === 'remote_relay',
      effective: config.MCP_BRIDGE_BACKEND === 'remote_relay',
      note: 'The paired relay path is implemented behind explicit configuration and is not Beta.',
    },
    raw_execution: {
      maturity: 'experimental',
      configured: config.MCP_RAW_EXEC_EXPERIMENTAL || config.BRIDGE_RAW_EXEC_ENABLED,
      effective:
        config.NODE_ENV !== 'production' &&
        config.MCP_RAW_EXEC_EXPERIMENTAL &&
        config.BRIDGE_RAW_EXEC_ENABLED,
      note: 'Raw execution requires both development-only gates and remains quarantined.',
    },
    oauth: {
      maturity: 'implemented',
      configured: config.OAUTH_ENABLED,
      effective: config.OAUTH_ENABLED,
      note: 'OAuth/JWKS validation is implemented and mandatory for non-loopback HTTP.',
    },
  };
}

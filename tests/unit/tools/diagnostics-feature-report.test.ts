import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import {
  buildCapabilityFeatureFlags,
  buildDetailedFeatureFlags,
  buildServerConfigFeatureFlags,
} from '../../../src/tools/diagnostics-feature-report.js';

describe('diagnostics feature reporting', () => {
  const config = EnvSchema.parse({
    NODE_ENV: 'test',
    MCP_TASKS_ENABLED: 'true',
    MCP_APPS_ENABLED: 'true',
    MCP_V2_EXPERIMENTAL: 'true',
    AI_PROVIDER: 'openai',
    OTEL_ENABLED: 'true',
    JLCPCB_ENABLE_ORDERING: 'true',
    JLCSEARCH_ENABLED: 'true',
    MOUSER_ENABLED: 'true',
    DIGIKEY_ENABLED: 'true',
    OAUTH_ENABLED: 'true',
    EASYEDA_DEV_BRIDGE: 'true',
    BRIDGE_RAW_EXEC_ENABLED: 'true',
    MCP_RAW_EXEC_EXPERIMENTAL: 'true',
  });

  it('keeps reserved flags ineffective across every public diagnostics view', () => {
    expect(buildCapabilityFeatureFlags(config)).toEqual({
      tasks_enabled: false,
      apps_enabled: false,
      v2_experimental: false,
      ordering_enabled: true,
    });

    expect(buildServerConfigFeatureFlags(config)).toEqual({
      mcp_tasks_enabled: false,
      mcp_apps_enabled: false,
      mcp_v2_experimental: false,
      ai_enabled: false,
      otel_enabled: false,
    });
  });

  it('keeps implemented and experimental flags explicit in the detailed view', () => {
    expect(buildDetailedFeatureFlags(config)).toEqual({
      mcp_tasks_enabled: false,
      mcp_apps_enabled: false,
      mcp_v2_experimental: false,
      jlcpcb_ordering_enabled: true,
      jlcsearch_enabled: true,
      mouser_enabled: true,
      digikey_enabled: true,
      oauth_enabled: true,
      otel_enabled: false,
      ai_enabled: false,
      dev_bridge: true,
      bridge_raw_exec_enabled: true,
      raw_exec_experimental: true,
    });
  });
});

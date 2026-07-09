import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type EnvConfig } from '../config/env.js';
import { type ToolProfile } from '../config/profiles.js';
import { SERVER_VERSION } from '../config/version.js';
import { createLogger } from '../utils/logger.js';
import { ToolRegistry } from '../tools/registry.js';
import { type ToolContext } from '../tools/types.js';
import { redactObject } from '../utils/redaction.js';
import { loadFeatureFlags } from '../config/feature-flags.js';
import { Storage } from '../storage/index.js';
import { type HttpTransportInstance } from './transports/http.js';
import { BridgeManager } from '../bridge/manager.js';
import { CdpBridgeManager } from '../bridge/cdp-manager.js';
import { startHotSwapWatcher } from '../bridge/hotswap-watcher.js';
import { registerBuiltinTools } from '../tools/register.js';
import { registerProjectResourcesAndPrompts } from './resources-prompts.js';
import { RemoteGateway } from '../remote/gateway.js';

import { LcscClient } from '../vendors/lcsc/client.js';
import { JlcpcbClient } from '../vendors/jlcpcb/client.js';
import { MouserClient } from '../vendors/mouser/client.js';
import { DigiKeyClient } from '../vendors/digikey/client.js';
import { createFileVendorCache } from '../vendors/cache.js';
import { configureVendorRateLimit } from '../vendors/base-http-client.js';

export interface CreateServerOptions {
  remoteGateway?: RemoteGateway;
}

export interface McpServerInstance {
  server: McpServer;
  registry: ToolRegistry;
  transport: StdioServerTransport | StreamableHTTPServerTransport;
  httpTransport?: HttpTransportInstance;
  context: ToolContext;
  storage?: Storage;
  bridge: BridgeManager | CdpBridgeManager;
  shutdown: () => Promise<void>;
}

export async function createServer(
  config: EnvConfig,
  options: CreateServerOptions = {},
): Promise<McpServerInstance> {
  const logger = createLogger(config);
  const flags = loadFeatureFlags(config);
  const remoteGateway =
    options.remoteGateway ??
    (config.MCP_BRIDGE_BACKEND === 'remote_relay' ? new RemoteGateway() : undefined);

  logger.info(
    {
      profile: config.TOOL_PROFILE,
      transport: config.TRANSPORT,
      nodeVersion: process.version,
      flags: redactObject(flags),
      bridgeMode: process.env.EASYEDA_BRIDGE === 'cdp' ? 'cdp' : 'extension',
    },
    'server initializing',
  );

  const server = new McpServer(
    {
      name: 'easyeda-mcp-pro',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        ...(flags.mcpTasksEnabled ? {} : undefined),
      },
    },
  );

  const bridge =
    process.env.EASYEDA_BRIDGE === 'cdp' ? new CdpBridgeManager(config) : new BridgeManager(config);
  await bridge.connect();
  const stopHotSwapWatcher =
    bridge instanceof BridgeManager ? startHotSwapWatcher(bridge, config) : undefined;

  const registry = new ToolRegistry();
  registry.setProfile(config.TOOL_PROFILE as ToolProfile);
  registerBuiltinTools(registry, config);

  configureVendorRateLimit(config.VENDOR_MIN_REQUEST_INTERVAL_MS);
  const vendorCache = createFileVendorCache(config.CACHE_DIR);

  const lcscClient = config.JLCSEARCH_ENABLED ? new LcscClient(config, vendorCache) : null;
  const jlcClient = config.JLCPCB_MODE === 'approved_api' ? new JlcpcbClient(config) : null;
  const mouserClient = config.MOUSER_ENABLED ? new MouserClient(config) : null;
  const digikeyClient = config.DIGIKEY_ENABLED ? new DigiKeyClient(config) : null;

  const storage = new Storage(config);
  storage.initialize();

  const context: ToolContext = {
    profile: config.TOOL_PROFILE as ToolProfile,
    bridge: {
      get connected() {
        return bridge.connected;
      },
      call: async (method, params, opts) => {
        logger.debug({ method }, 'bridge call');
        return bridge.call(method, params, opts);
      },
      get uptimeMs() {
        return bridge.uptimeMs;
      },
      get activePort() {
        return bridge.activePort;
      },
      get lastHeartbeatMs() {
        return bridge.lastHeartbeatMs;
      },
      get methodRegistryHash() {
        return bridge.methodRegistryHash;
      },
      get easyedaVersion() {
        return bridge.easyedaVersion;
      },
      get extensionVersion() {
        return bridge.extensionVersion;
      },
      get extensionVersionMismatch() {
        return bridge.extensionVersionMismatch;
      },
      get extensionMethodListHash() {
        return bridge.extensionMethodListHash;
      },
      get loaderVersion() {
        return bridge.loaderVersion;
      },
      get registryMismatch() {
        return bridge.registryMismatch;
      },
    },
    config: {
      bridgeTimeoutMs: config.BRIDGE_TIMEOUT_MS,
      artifactDir: config.ARTIFACT_DIR,
      bridgeHost: config.BRIDGE_HOST,
      bridgePort: bridge.activePort || config.BRIDGE_PORT,
      keylessSourcingEnabled: config.KEYLESS_SOURCING_ENABLED,
      TOOL_SCOPES: config.TOOL_SCOPES,
      MCP_BRIDGE_BACKEND: config.MCP_BRIDGE_BACKEND,
      MCP_REMOTE_SESSION_ID: config.MCP_REMOTE_SESSION_ID,
    },
    remote: remoteGateway ? { gateway: remoteGateway } : undefined,
    vendors: {
      lcsc: lcscClient,
      jlcpcb: jlcClient,
      mouser: mouserClient,
      digikey: digikeyClient,
    },
    storage,
  };

  registry.registerAllOnServer(server, context);
  registerProjectResourcesAndPrompts(server, context);

  server.server.onerror = (error) => {
    logger.error({ err: error }, 'server error');
  };

  const transport = new StdioServerTransport();

  const shutdown = async () => {
    logger.info('server shutting down');
    stopHotSwapWatcher?.();
    storage.close();
    bridge.disconnect('server shutdown');
    await server.close();
  };

  return { server, registry, transport, context, storage, bridge, shutdown };
}

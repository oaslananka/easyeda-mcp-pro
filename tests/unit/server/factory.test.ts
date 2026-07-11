import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../../src/config/env.js';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  close: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  call: vi.fn(async () => ({ ok: true })),
  storageInit: vi.fn(),
  storageClose: vi.fn(),
  setProfile: vi.fn(),
  registerAll: vi.fn(),
  registerTools: vi.fn(),
  registerResources: vi.fn(),
  startHotSwapWatcher: vi.fn(() => vi.fn()),
  vendor: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    server = { onerror: undefined as ((error: unknown) => void) | undefined };
    close = mocks.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {},
}));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mocks.logger,
  getLogger: () => mocks.logger,
}));
vi.mock('../../../src/utils/redaction.js', () => ({ redactObject: (value: unknown) => value }));
vi.mock('../../../src/config/feature-flags.js', () => ({
  loadFeatureFlags: () => ({ mcpTasksEnabled: false }),
}));
vi.mock('../../../src/storage/index.js', () => ({
  Storage: class MockStorage {
    initialize = mocks.storageInit;
    close = mocks.storageClose;
  },
}));
vi.mock('../../../src/bridge/manager.js', () => ({
  BridgeManager: class MockBridgeManager {
    connected = true;
    connect = mocks.connect;
    disconnect = mocks.disconnect;
    call = mocks.call;
    uptimeMs = 12345;
    activePort = 49620;
    lastHeartbeatMs = 999;
    methodRegistryHash = 'test-hash';
    easyedaVersion = '2.0.0';
    extensionVersion = '0.20.0';
    extensionVersionMismatch = true;
  },
}));
vi.mock('../../../src/bridge/hotswap-watcher.js', () => ({
  startHotSwapWatcher: mocks.startHotSwapWatcher,
}));
vi.mock('../../../src/tools/registry.js', () => ({
  ToolRegistry: class MockToolRegistry {
    setProfile = mocks.setProfile;
    registerAllOnServer = mocks.registerAll;
  },
}));
vi.mock('../../../src/tools/register.js', () => ({ registerBuiltinTools: mocks.registerTools }));
vi.mock('../../../src/server/resources-prompts.js', () => ({
  registerProjectResourcesAndPrompts: mocks.registerResources,
}));
vi.mock('../../../src/vendors/lcsc/client.js', () => ({ LcscClient: class MockClient {} }));
vi.mock('../../../src/vendors/jlcpcb/client.js', () => ({ JlcpcbClient: class MockClient {} }));
vi.mock('../../../src/vendors/mouser/client.js', () => ({ MouserClient: class MockClient {} }));
vi.mock('../../../src/vendors/digikey/client.js', () => ({ DigiKeyClient: class MockClient {} }));

const { createServer } = await import('../../../src/server/factory.js');

function config(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    TOOL_PROFILE: 'pro',
    TRANSPORT: 'stdio',
    BRIDGE_TIMEOUT_MS: 5000,
    ARTIFACT_DIR: '.easyeda-mcp-pro/artifacts',
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_PORT: 49620,
    JLCSEARCH_ENABLED: false,
    JLCPCB_MODE: 'disabled',
    MOUSER_ENABLED: false,
    DIGIKEY_ENABLED: false,
    CACHE_DIR: '.easyeda-mcp-pro/cache',
    VENDOR_MIN_REQUEST_INTERVAL_MS: 0,
    KEYLESS_SOURCING_ENABLED: true,
    ...overrides,
  } as EnvConfig;
}

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.call.mockResolvedValue({ ok: true });
  });

  it('wires registry, resources, storage, and shutdown', async () => {
    const instance = await createServer(config());

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.setProfile).toHaveBeenCalledWith('pro');
    expect(mocks.registerTools).toHaveBeenCalledWith(instance.registry, expect.any(Object));
    expect(mocks.registerAll).toHaveBeenCalledWith(instance.server, instance.context);
    expect(mocks.registerResources).toHaveBeenCalledWith(instance.server, instance.context);
    expect(mocks.storageInit).toHaveBeenCalledTimes(1);

    await instance.shutdown();

    expect(mocks.storageClose).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledWith('server shutdown');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('does not open the local bridge or hot-swap watcher in Remote Relay mode', async () => {
    const instance = await createServer(
      config({ TRANSPORT: 'http', MCP_BRIDGE_BACKEND: 'remote_relay' }),
    );

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.startHotSwapWatcher).not.toHaveBeenCalled();
    expect(instance.context.remote?.gateway).toBeDefined();

    await instance.shutdown();

    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('delegates bridge calls through the tool context', async () => {
    const instance = await createServer(config());

    await expect(instance.context.bridge.call('ping', { value: 1 })).resolves.toEqual({ ok: true });

    expect(mocks.logger.debug).toHaveBeenCalledWith({ method: 'ping' }, 'bridge call');
    expect(mocks.call).toHaveBeenCalledWith('ping', { value: 1 }, undefined);
  });

  it('exposes bridge diagnostics and version fields through the tool context', async () => {
    const instance = await createServer(config());

    expect(instance.context.bridge.uptimeMs).toBe(12345);
    expect(instance.context.bridge.activePort).toBe(49620);
    expect(instance.context.bridge.lastHeartbeatMs).toBe(999);
    expect(instance.context.bridge.methodRegistryHash).toBe('test-hash');
    expect(instance.context.bridge.easyedaVersion).toBe('2.0.0');
    expect(instance.context.bridge.extensionVersion).toBe('0.20.0');
    expect(instance.context.bridge.extensionVersionMismatch).toBe(true);
  });

  it('exposes keylessSourcingEnabled through the tool context config', async () => {
    const instance = await createServer(config({ KEYLESS_SOURCING_ENABLED: false }));
    expect(instance.context.config.keylessSourcingEnabled).toBe(false);
  });

  it('exposes the same storage instance through the tool context', async () => {
    const instance = await createServer(config());
    expect(instance.context.storage).toBeDefined();
    expect(instance.context.storage).toBe(instance.storage);
  });

  it('creates vendor clients when enabled', async () => {
    const instance = await createServer(
      config({
        JLCSEARCH_ENABLED: true,
        JLCPCB_MODE: 'approved_api',
        MOUSER_ENABLED: true,
        DIGIKEY_ENABLED: true,
      }),
    );

    expect(instance.context.vendors.lcsc).toBeTruthy();
    expect(instance.context.vendors.jlcpcb).toBeTruthy();
    expect(instance.context.vendors.mouser).toBeTruthy();
    expect(instance.context.vendors.digikey).toBeTruthy();
  });
});

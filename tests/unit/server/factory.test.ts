import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../../src/config/env.js';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  mcpCtor: vi.fn(),
  serverClose: vi.fn(async () => undefined),
  storageCtor: vi.fn(),
  storageInitialize: vi.fn(),
  storageClose: vi.fn(),
  bridgeCtor: vi.fn(),
  bridgeConnect: vi.fn(async () => undefined),
  bridgeDisconnect: vi.fn(),
  bridgeCall: vi.fn(async () => ({ ok: true })),
  registrySetProfile: vi.fn(),
  registryRegisterAllOnServer: vi.fn(),
  registerBuiltinTools: vi.fn(),
  registerProjectResourcesAndPrompts: vi.fn(),
  loadFeatureFlags: vi.fn(() => ({ mcpTasksEnabled: false })),
  lcscCtor: vi.fn(),
  jlcpcbCtor: vi.fn(),
  mouserCtor: vi.fn(),
  digikeyCtor: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    server = { onerror: undefined as ((error: unknown) => void) | undefined };
    close = mocks.serverClose;

    constructor(...args: unknown[]) {
      mocks.mcpCtor(...args);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {},
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

vi.mock('../../../src/config/feature-flags.js', () => ({
  loadFeatureFlags: mocks.loadFeatureFlags,
}));

vi.mock('../../../src/utils/redaction.js', () => ({
  redactObject: vi.fn((value: unknown) => value),
}));

vi.mock('../../../src/storage/index.js', () => ({
  Storage: class MockStorage {
    initialize = mocks.storageInitialize;
    close = mocks.storageClose;

    constructor(config: EnvConfig) {
      mocks.storageCtor(config);
    }
  },
}));

vi.mock('../../../src/bridge/manager.js', () => ({
  BridgeManager: class MockBridgeManager {
    connected = true;
    connect = mocks.bridgeConnect;
    disconnect = mocks.bridgeDisconnect;
    call = mocks.bridgeCall;

    constructor(config: EnvConfig) {
      mocks.bridgeCtor(config);
    }
  },
}));

vi.mock('../../../src/tools/registry.js', () => ({
  ToolRegistry: class MockToolRegistry {
    setProfile = mocks.registrySetProfile;
    registerAllOnServer = mocks.registryRegisterAllOnServer;
  },
}));

vi.mock('../../../src/tools/register.js', () => ({
  registerBuiltinTools: mocks.registerBuiltinTools,
}));

vi.mock('../../../src/server/resources-prompts.js', () => ({
  registerProjectResourcesAndPrompts: mocks.registerProjectResourcesAndPrompts,
}));

vi.mock('../../../src/vendors/lcsc/client.js', () => ({
  LcscClient: class MockLcscClient {
    constructor(config: EnvConfig) {
      mocks.lcscCtor(config);
    }
  },
}));

vi.mock('../../../src/vendors/jlcpcb/client.js', () => ({
  JlcpcbClient: class MockJlcpcbClient {
    constructor(config: EnvConfig) {
      mocks.jlcpcbCtor(config);
    }
  },
}));

vi.mock('../../../src/vendors/mouser/client.js', () => ({
  MouserClient: class MockMouserClient {
    constructor(config: EnvConfig) {
      mocks.mouserCtor(config);
    }
  },
}));

vi.mock('../../../src/vendors/digikey/client.js', () => ({
  DigiKeyClient: class MockDigiKeyClient {
    constructor(config: EnvConfig) {
      mocks.digikeyCtor(config);
    }
  },
}));

const { createServer } = await import('../../../src/server/factory.js');

function makeConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
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
    ...overrides,
  } as EnvConfig;
}

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadFeatureFlags.mockReturnValue({ mcpTasksEnabled: false });
    mocks.bridgeConnect.mockResolvedValue(undefined);
    mocks.bridgeCall.mockResolvedValue({ ok: true });
    mocks.serverClose.mockResolvedValue(undefined);
  });

  it('wires the server, registry, bridge, storage, resources, and shutdown path', async () => {
    const config = makeConfig();
    const instance = await createServer(config);

    expect(mocks.mcpCtor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'easyeda-mcp-pro' }),
      expect.objectContaining({ capabilities: expect.objectContaining({ tools: {} }) }),
    );
    expect(mocks.bridgeCtor).toHaveBeenCalledWith(config);
    expect(mocks.bridgeConnect).toHaveBeenCalledTimes(1);
    expect(mocks.registrySetProfile).toHaveBeenCalledWith('pro');
    expect(mocks.registerBuiltinTools).toHaveBeenCalledWith(instance.registry, config);
    expect(mocks.registryRegisterAllOnServer).toHaveBeenCalledWith(instance.server, instance.context);
    expect(mocks.registerProjectResourcesAndPrompts).toHaveBeenCalledWith(
      instance.server,
      instance.context,
    );
    expect(mocks.storageCtor).toHaveBeenCalledWith(config);
    expect(mocks.storageInitialize).toHaveBeenCalledTimes(1);
    expect(instance.context.vendors).toMatchObject({
      lcsc: null,
      jlcpcb: null,
      mouser: null,
      digikey: null,
    });

    await instance.shutdown();

    expect(mocks.storageClose).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeDisconnect).toHaveBeenCalledWith('server shutdown');
    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
  });

  it('creates vendor clients only when their feature switches are enabled', async () => {
    const config = makeConfig({
      JLCSEARCH_ENABLED: true,
      JLCPCB_MODE: 'approved_api',
      MOUSER_ENABLED: true,
      DIGIKEY_ENABLED: true,
    });

    const instance = await createServer(config);

    expect(mocks.lcscCtor).toHaveBeenCalledWith(config);
    expect(mocks.jlcpcbCtor).toHaveBeenCalledWith(config);
    expect(mocks.mouserCtor).toHaveBeenCalledWith(config);
    expect(mocks.digikeyCtor).toHaveBeenCalledWith(config);
    expect(instance.context.vendors.lcsc).toBeTruthy();
    expect(instance.context.vendors.jlcpcb).toBeTruthy();
    expect(instance.context.vendors.mouser).toBeTruthy();
    expect(instance.context.vendors.digikey).toBeTruthy();
  });

  it('delegates bridge calls through the tool context', async () => {
    const instance = await createServer(makeConfig());

    await expect(
      instance.context.bridge.call('easyeda.ping', { value: 1 }, { timeoutMs: 123 }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.logger.debug).toHaveBeenCalledWith({ method: 'easyeda.ping' }, 'bridge call');
    expect(mocks.bridgeCall).toHaveBeenCalledWith(
      'easyeda.ping',
      { value: 1 },
      { timeoutMs: 123 },
    );
  });

  it('propagates bridge connection failures before storage initialization', async () => {
    mocks.bridgeConnect.mockRejectedValueOnce(new Error('bridge unavailable'));

    await expect(createServer(makeConfig())).rejects.toThrow('bridge unavailable');

    expect(mocks.storageInitialize).not.toHaveBeenCalled();
    expect(mocks.registerBuiltinTools).not.toHaveBeenCalled();
  });
});

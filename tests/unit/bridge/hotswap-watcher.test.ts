import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mockLogger,
  getLogger: () => mockLogger,
}));

import { startHotSwapWatcher } from '../../../src/bridge/hotswap-watcher.js';
import type { BridgeManager } from '../../../src/bridge/manager.js';
import type { EnvConfig } from '../../../src/config/env.js';

class FakeBridge extends EventEmitter {
  connected = true;
  call = vi.fn(async (_method: string, _params?: unknown) => ({}) as unknown);
}

function makeBundle(buildId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hotswap-watcher-'));
  const bundlePath = join(dir, 'dispatcher.js');
  writeFileSync(bundlePath, `// bundle ${buildId}`);
  writeFileSync(join(dir, 'dispatcher.meta.json'), JSON.stringify({ buildId }));
  return bundlePath;
}

function makeConfig(overrides: Partial<EnvConfig>): EnvConfig {
  return {
    BRIDGE_HOT_SWAP_ENABLED: true,
    BRIDGE_HOT_SWAP_WATCH: '',
    BRIDGE_HOT_SWAP_CHUNK_BYTES: 65536,
    ...overrides,
  } as EnvConfig;
}

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
}

describe('startHotSwapWatcher', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it('is a no-op when hot swap is disabled or no watch path is set', () => {
    const bridge = new FakeBridge();
    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_ENABLED: false, BRIDGE_HOT_SWAP_WATCH: makeBundle('d1') }),
    );
    expect(bridge.listenerCount('connected')).toBe(0);

    stop();
    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: '' }),
    );
    expect(bridge.listenerCount('connected')).toBe(0);
  });

  it('warns when the watched bundle does not exist yet', () => {
    const bridge = new FakeBridge();
    bridge.connected = false;
    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: '/nonexistent/dispatcher.js' }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bundlePath: '/nonexistent/dispatcher.js' }),
      expect.stringContaining('does not exist'),
    );
  });

  it('pushes the dispatcher when the extension reports a different build', async () => {
    const bundlePath = makeBundle('dnewxbuildxid1');
    const bridge = new FakeBridge();
    bridge.call.mockImplementation(async (method: string) => {
      if (method === 'system.loaderStatus') {
        return { hotSwapCompiled: true, activeDispatcher: 'baked', buildId: 'doldxbuildxid0' };
      }
      if (method === 'system.hotSwap.commit') {
        return { swapped: true, buildId: 'dnewxbuildxid1', methodCount: 49 };
      }
      return {};
    });

    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: bundlePath }),
    );
    await flushDebounce();

    const methods = bridge.call.mock.calls.map((c) => c[0]);
    expect(methods).toContain('system.hotSwap.begin');
    expect(methods[methods.length - 1]).toBe('system.hotSwap.commit');
  });

  it('does not push when the extension already runs the current build', async () => {
    const bundlePath = makeBundle('dsamexbuildxid');
    const bridge = new FakeBridge();
    bridge.call.mockImplementation(async (method: string) => {
      if (method === 'system.loaderStatus') {
        return { hotSwapCompiled: true, buildId: 'dsamexbuildxid' };
      }
      return {};
    });

    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: bundlePath }),
    );
    await flushDebounce();

    const methods = bridge.call.mock.calls.map((c) => c[0]);
    expect(methods).toContain('system.loaderStatus');
    expect(methods).not.toContain('system.hotSwap.begin');
  });

  it('warns and skips when the extension build has no hot-swap support', async () => {
    const bundlePath = makeBundle('dnewxbuildxid2');
    const bridge = new FakeBridge();
    bridge.call.mockImplementation(async (method: string) => {
      if (method === 'system.loaderStatus') {
        return { hotSwapCompiled: false, buildId: 'dwhatxeverxxxx' };
      }
      return {};
    });

    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: bundlePath }),
    );
    await flushDebounce();

    const methods = bridge.call.mock.calls.map((c) => c[0]);
    expect(methods).not.toContain('system.hotSwap.begin');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('does not include hot-swap support'),
    );
  });

  it('logs and survives a failed push', async () => {
    const bundlePath = makeBundle('dnewxbuildxid3');
    const bridge = new FakeBridge();
    bridge.call.mockImplementation(async (method: string) => {
      if (method === 'system.loaderStatus') {
        return { hotSwapCompiled: true, buildId: 'doldxbuildxid0' };
      }
      throw new Error('begin rejected');
    });

    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: bundlePath }),
    );
    await flushDebounce();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.any(String) }),
      'dispatcher hot-swap push failed',
    );
  });

  it('skips syncing while the bridge is disconnected and stop() removes the listener', async () => {
    const bundlePath = makeBundle('dnewxbuildxid4');
    const bridge = new FakeBridge();
    bridge.connected = false;

    stop = startHotSwapWatcher(
      bridge as unknown as BridgeManager,
      makeConfig({ BRIDGE_HOT_SWAP_WATCH: bundlePath }),
    );
    expect(bridge.listenerCount('connected')).toBe(1);
    bridge.emit('connected');
    await flushDebounce();
    expect(bridge.call).not.toHaveBeenCalled();

    stop();
    stop = null;
    expect(bridge.listenerCount('connected')).toBe(0);
  });
});

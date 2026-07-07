import { watch, existsSync, type FSWatcher } from 'node:fs';
import { type EnvConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { type BridgeManager } from './manager.js';
import { fetchLoaderStatus, pushDispatcher, readDispatcherArtifact } from './hotswap.js';

const DEBOUNCE_MS = 300;

/**
 * The dev hot-swap loop: while BRIDGE_HOT_SWAP_ENABLED is set and
 * BRIDGE_HOT_SWAP_WATCH points at the built dispatcher bundle, push the bundle
 * to the extension whenever (a) the extension (re)connects with a different
 * build than the one on disk — e.g. after an EasyEDA restart it comes back
 * with the stale baked dispatcher — or (b) the bundle file changes on disk
 * (the extension build:watch rebuilt it). Combined with `tsx watch` for the
 * server this closes the edit → run loop without any .eext re-import.
 */
export function startHotSwapWatcher(bridge: BridgeManager, config: EnvConfig): () => void {
  const logger = getLogger();
  const bundlePath = config.BRIDGE_HOT_SWAP_WATCH;

  if (!config.BRIDGE_HOT_SWAP_ENABLED || !bundlePath) {
    return () => {};
  }
  if (!existsSync(bundlePath)) {
    logger.warn(
      { bundlePath },
      'BRIDGE_HOT_SWAP_WATCH does not exist yet; hot-swap auto-push waits for it',
    );
  }

  let syncing = false;
  let pendingResync = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const sync = async (reason: string): Promise<void> => {
    if (stopped || !bridge.connected) return;
    if (syncing) {
      pendingResync = true;
      return;
    }
    syncing = true;
    try {
      const artifact = readDispatcherArtifact(bundlePath);
      const status = await fetchLoaderStatus(bridge.call.bind(bridge));
      if (status.hotSwapCompiled === false) {
        logger.warn(
          'extension build does not include hot-swap support; re-import a dev build once (pnpm --filter bridge-extension build:dev)',
        );
        return;
      }
      if (status.buildId === artifact.buildId) {
        logger.debug({ buildId: artifact.buildId, reason }, 'dispatcher already current');
        return;
      }
      logger.info(
        { from: status.buildId, to: artifact.buildId, reason },
        'pushing dispatcher hot-swap',
      );
      const result = await pushDispatcher(
        bridge.call.bind(bridge),
        artifact,
        config.BRIDGE_HOT_SWAP_CHUNK_BYTES,
      );
      logger.info(
        { buildId: result.buildId, methodCount: result.methodCount },
        'dispatcher hot-swap complete',
      );
    } catch (err) {
      logger.error({ err, reason }, 'dispatcher hot-swap push failed');
    } finally {
      syncing = false;
      if (pendingResync) {
        pendingResync = false;
        void sync('resync');
      }
    }
  };

  const scheduleSync = (reason: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void sync(reason);
    }, DEBOUNCE_MS);
  };

  const onConnected = (): void => scheduleSync('bridge connected');
  bridge.on('connected', onConnected);
  if (bridge.connected) scheduleSync('watcher started');

  const startFileWatcher = (): void => {
    try {
      watcher = watch(bundlePath, () => scheduleSync('bundle changed'));
    } catch (err) {
      logger.warn({ err, bundlePath }, 'could not watch dispatcher bundle; retrying in 5s');
      setTimeout(() => {
        if (!stopped) startFileWatcher();
      }, 5000);
    }
  };
  startFileWatcher();

  logger.info({ bundlePath }, 'dispatcher hot-swap watcher active');

  return () => {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    bridge.off('connected', onConnected);
    watcher?.close();
  };
}

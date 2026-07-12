export interface EasyedaTimerApi {
  setTimeoutTimer?: (id: string, delayMs: number, callback: () => void) => boolean;
  clearTimeoutTimer?: (id: string) => boolean;
  setIntervalTimer?: (id: string, delayMs: number, callback: () => void) => boolean;
  clearIntervalTimer?: (id: string) => boolean;
}

interface NativeTimerGlobal {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (callback: () => void, delayMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type RuntimeTimerHandle =
  | { source: 'easyeda'; kind: 'timeout' | 'interval'; id: string }
  | { source: 'native'; kind: 'timeout' | 'interval'; handle: unknown };

export interface RuntimeTimers {
  setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
  clearTimeout(handle: RuntimeTimerHandle | null): void;
  setInterval(callback: () => void, delayMs: number): RuntimeTimerHandle;
  clearInterval(handle: RuntimeTimerHandle | null): void;
}

export function createRuntimeTimers(
  getEasyedaTimerApi: () => EasyedaTimerApi | undefined,
  nativeGlobal: NativeTimerGlobal = globalThis as unknown as NativeTimerGlobal,
  idPrefix = 'easyeda-mcp-pro',
): RuntimeTimers {
  let sequence = 0;
  const nextId = (kind: 'timeout' | 'interval'): string => `${idPrefix}:${kind}:${++sequence}`;

  return {
    setTimeout(callback, delayMs) {
      const api = getEasyedaTimerApi();
      if (api?.setTimeoutTimer) {
        const id = nextId('timeout');
        if (api.setTimeoutTimer(id, delayMs, callback) !== false) {
          return { source: 'easyeda', kind: 'timeout', id };
        }
      }

      if (typeof nativeGlobal.setTimeout === 'function') {
        return {
          source: 'native',
          kind: 'timeout',
          handle: nativeGlobal.setTimeout.call(nativeGlobal, callback, delayMs),
        };
      }

      throw new Error('No timeout scheduler is available in the EasyEDA extension runtime.');
    },

    clearTimeout(handle) {
      if (!handle) return;
      if (handle.source === 'easyeda') {
        getEasyedaTimerApi()?.clearTimeoutTimer?.(handle.id);
        return;
      }
      nativeGlobal.clearTimeout?.call(nativeGlobal, handle.handle);
    },

    setInterval(callback, delayMs) {
      const api = getEasyedaTimerApi();
      if (api?.setIntervalTimer) {
        const id = nextId('interval');
        if (api.setIntervalTimer(id, delayMs, callback) !== false) {
          return { source: 'easyeda', kind: 'interval', id };
        }
      }

      if (typeof nativeGlobal.setInterval === 'function') {
        return {
          source: 'native',
          kind: 'interval',
          handle: nativeGlobal.setInterval.call(nativeGlobal, callback, delayMs),
        };
      }

      throw new Error('No interval scheduler is available in the EasyEDA extension runtime.');
    },

    clearInterval(handle) {
      if (!handle) return;
      if (handle.source === 'easyeda') {
        getEasyedaTimerApi()?.clearIntervalTimer?.(handle.id);
        return;
      }
      nativeGlobal.clearInterval?.call(nativeGlobal, handle.handle);
    },
  };
}

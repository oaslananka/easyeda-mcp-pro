import { describe, expect, it, vi } from 'vitest';
import { createRuntimeTimers, type EasyedaTimerApi } from '../src/runtime-timers.js';

describe('EasyEDA runtime timers', () => {
  it('uses sys_Timer when native browser timers are unavailable', () => {
    const callbacks = new Map<string, () => void>();
    const api: EasyedaTimerApi = {
      setTimeoutTimer: vi.fn((id, _delay, callback) => {
        callbacks.set(id, callback);
        return true;
      }),
      clearTimeoutTimer: vi.fn((id) => callbacks.delete(id)),
      setIntervalTimer: vi.fn((id, _delay, callback) => {
        callbacks.set(id, callback);
        return true;
      }),
      clearIntervalTimer: vi.fn((id) => callbacks.delete(id)),
    };
    const timers = createRuntimeTimers(() => api, {}, 'fixture');
    const timeoutCallback = vi.fn();
    const intervalCallback = vi.fn();

    const timeout = timers.setTimeout(timeoutCallback, 500);
    const interval = timers.setInterval(intervalCallback, 1000);

    expect(timeout).toMatchObject({ source: 'easyeda', kind: 'timeout' });
    expect(interval).toMatchObject({ source: 'easyeda', kind: 'interval' });
    expect(api.setTimeoutTimer).toHaveBeenCalledWith(expect.any(String), 500, timeoutCallback);
    expect(api.setIntervalTimer).toHaveBeenCalledWith(expect.any(String), 1000, intervalCallback);

    timers.clearTimeout(timeout);
    timers.clearInterval(interval);
    expect(api.clearTimeoutTimer).toHaveBeenCalledWith(
      timeout.source === 'easyeda' ? timeout.id : '',
    );
    expect(api.clearIntervalTimer).toHaveBeenCalledWith(
      interval.source === 'easyeda' ? interval.id : '',
    );
  });

  it('falls back to explicitly supplied native timers', () => {
    const nativeHandle = { id: 1 };
    const native = {
      setTimeout: vi.fn(() => nativeHandle),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => nativeHandle),
      clearInterval: vi.fn(),
    };
    const timers = createRuntimeTimers(() => undefined, native, 'fixture');

    const timeout = timers.setTimeout(() => undefined, 10);
    const interval = timers.setInterval(() => undefined, 20);
    timers.clearTimeout(timeout);
    timers.clearInterval(interval);

    expect(native.setTimeout).toHaveBeenCalledOnce();
    expect(native.setInterval).toHaveBeenCalledOnce();
    expect(native.clearTimeout).toHaveBeenCalledWith(nativeHandle);
    expect(native.clearInterval).toHaveBeenCalledWith(nativeHandle);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasOperations,
  type CanvasOperationDependencies,
} from '../src/canvas-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function makeOperations(
  overrides: Partial<CanvasOperationDependencies> = {},
): ReturnType<typeof createCanvasOperations> {
  return createCanvasOperations({
    callFirst: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    normalizeBinaryResult: vi.fn(async (value, fileName) => ({ value, fileName })),
    createBridgeError: bridgeError,
    animationRoot: {},
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('canvas operations', () => {
  it('captures the current area and normalizes string/non-string tab ids', async () => {
    const callFirst = vi.fn(async () => 'blob');
    const normalizeBinaryResult = vi.fn(async (value, fileName) => ({ value, fileName }));
    const operations = makeOperations({ callFirst, normalizeBinaryResult });

    await expect(operations.capture({ tabId: 'tab-1' })).resolves.toEqual({
      value: 'blob',
      fileName: 'capture.png',
    });
    await operations.capture({ tabId: 7 });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['DMT_EditorControl.getCurrentRenderedAreaImage'],
      'tab-1',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['DMT_EditorControl.getCurrentRenderedAreaImage'],
      undefined,
    );
    expect(normalizeBinaryResult).toHaveBeenCalledWith('blob', 'capture.png');
  });

  it('normalizes region bounds, waits a macrotask, then captures', async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    const callFirst = vi.fn(async (paths: readonly string[]) => {
      if (paths[0] === 'DMT_EditorControl.zoomToRegion') {
        callOrder.push('zoom');
        return true;
      }
      callOrder.push('capture');
      return 'region-blob';
    });
    const operations = makeOperations({ callFirst });

    const resultPromise = operations.captureRegion({
      left: 100,
      right: 0,
      top: 0,
      bottom: 50,
      tabId: 'tab-1',
    });
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toEqual({
      value: 'region-blob',
      fileName: 'capture-region.png',
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['DMT_EditorControl.zoomToRegion'],
      0,
      100,
      50,
      0,
      'tab-1',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['DMT_EditorControl.getCurrentRenderedAreaImage'],
      'tab-1',
    );
    expect(callOrder).toEqual(['zoom', 'capture']);
  });

  it('rejects non-finite and zero-area regions before touching EasyEDA', async () => {
    const callFirst = vi.fn(async () => true);
    const operations = makeOperations({ callFirst });

    await expect(
      operations.captureRegion({ left: Number.NaN, right: 10, top: 10, bottom: 0 }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Capture region coordinates must be finite numbers.',
    });
    await expect(
      operations.captureRegion({ left: 10, right: 10, top: 20, bottom: 0 }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Capture region must have non-zero width and height.',
    });
    await expect(
      operations.captureRegion({ left: 0, right: 10, top: 5, bottom: 5 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('does not capture when EasyEDA rejects the region zoom', async () => {
    const callFirst = vi.fn(async () => false);
    const normalizeBinaryResult = vi.fn(async () => undefined);
    const operations = makeOperations({ callFirst, normalizeBinaryResult });

    await expect(
      operations.captureRegion({ left: 0, right: 10, top: 10, bottom: 0 }),
    ).rejects.toMatchObject({
      code: 'EASYEDA_API_ERROR',
      message: 'EasyEDA could not zoom to the requested capture region.',
    });
    expect(callFirst).toHaveBeenCalledOnce();
    expect(normalizeBinaryResult).not.toHaveBeenCalled();
  });

  it('waits for two animation frames before capture', async () => {
    const callbacks: Array<() => void> = [];
    const requestAnimationFrame = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const callFirst = vi.fn(async (paths: readonly string[]) =>
      paths[0] === 'DMT_EditorControl.zoomToRegion' ? true : 'frame-blob',
    );
    const operations = makeOperations({
      callFirst,
      animationRoot: { requestAnimationFrame },
    });

    const resultPromise = operations.captureRegion({ left: 0, right: 10, top: 10, bottom: 0 });
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    expect(callbacks).toHaveLength(2);
    callbacks[1]?.();
    await expect(resultPromise).resolves.toMatchObject({ fileName: 'capture-region.png' });
    callbacks[1]?.();
    expect(callFirst).toHaveBeenCalledTimes(2);
  });

  it('bounds a suspended animation frame wait with the repaint timeout', async () => {
    vi.useFakeTimers();
    const requestAnimationFrame = vi.fn(() => 1);
    const callFirst = vi.fn(async (paths: readonly string[]) =>
      paths[0] === 'DMT_EditorControl.zoomToRegion' ? true : 'timeout-blob',
    );
    const operations = makeOperations({
      callFirst,
      animationRoot: { requestAnimationFrame },
    });

    const resultPromise = operations.captureRegion({ left: 0, right: 10, top: 10, bottom: 0 });
    await vi.advanceTimersByTimeAsync(75);
    await expect(resultPromise).resolves.toMatchObject({ fileName: 'capture-region.png' });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(callFirst).toHaveBeenCalledTimes(2);
  });

  it('forwards locate coordinates without inventing defaults', async () => {
    const callFirst = vi.fn(async () => 'located');
    const operations = makeOperations({ callFirst });

    await expect(operations.locate({ x: 12, y: -4, scaleRatio: 2, tabId: 'tab-2' })).resolves.toBe(
      'located',
    );
    await operations.locate({});

    expect(callFirst).toHaveBeenNthCalledWith(1, ['DMT_EditorControl.zoomTo'], 12, -4, 2, 'tab-2');
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['DMT_EditorControl.zoomTo'],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});

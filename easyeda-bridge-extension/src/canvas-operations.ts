import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { BinaryResultNormalizer } from './binary-result.js';

export interface CanvasAnimationRoot {
  requestAnimationFrame?: (callback: () => void) => number;
}

export interface CanvasOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  normalizeBinaryResult: BinaryResultNormalizer;
  createBridgeError: BridgeErrorFactory;
  animationRoot?: CanvasAnimationRoot;
}

export interface CanvasOperations {
  capture(params: Record<string, unknown>): Promise<unknown>;
  captureRegion(params: Record<string, unknown>): Promise<unknown>;
  locate(params: Record<string, unknown>): Promise<unknown>;
}

interface CanvasRegion {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function createCanvasOperations({
  callFirst,
  normalizeBinaryResult,
  createBridgeError,
  animationRoot = globalThis,
}: CanvasOperationDependencies): CanvasOperations {
  function normalizeCanvasRegion(value: CanvasRegion): CanvasRegion {
    const coordinates = [value.left, value.right, value.top, value.bottom];
    if (!coordinates.every(Number.isFinite)) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Capture region coordinates must be finite numbers.',
        'Provide finite left, right, top, and bottom document coordinates.',
      );
    }

    const region = {
      left: Math.min(value.left, value.right),
      right: Math.max(value.left, value.right),
      top: Math.max(value.top, value.bottom),
      bottom: Math.min(value.top, value.bottom),
    };
    if (region.left === region.right || region.top === region.bottom) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Capture region must have non-zero width and height.',
        'Expand the bounds around the component before capturing it.',
      );
    }
    return region;
  }

  async function waitForCanvasPaint(): Promise<void> {
    const requestFrame = animationRoot.requestAnimationFrame;
    if (typeof requestFrame === 'function') {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        // A minimized/background Electron window can suspend animation frames.
        // Keep capture bounded instead of waiting indefinitely for repaint.
        const timeout = setTimeout(finish, 75);
        requestFrame.call(animationRoot, () => requestFrame.call(animationRoot, finish));
      });
      return;
    }

    // Vitest/Node and older extension shells may not expose requestAnimationFrame.
    // A macrotask still lets an asynchronously scheduled canvas update settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async function capture(params: Record<string, unknown>): Promise<unknown> {
    const tabId = typeof params.tabId === 'string' ? params.tabId : undefined;
    const blob = await callFirst(['DMT_EditorControl.getCurrentRenderedAreaImage'], tabId);
    return normalizeBinaryResult(blob, 'capture.png');
  }

  async function captureRegion(params: Record<string, unknown>): Promise<unknown> {
    const region = normalizeCanvasRegion(params as unknown as CanvasRegion);
    const tabId = params.tabId;
    const zoomed = await callFirst(
      ['DMT_EditorControl.zoomToRegion'],
      region.left,
      region.right,
      region.top,
      region.bottom,
      tabId,
    );
    if (zoomed === false) {
      throw createBridgeError(
        'EASYEDA_API_ERROR',
        'EasyEDA could not zoom to the requested capture region.',
        'Verify that the target tab is open and the region uses document/canvas coordinates.',
      );
    }
    await waitForCanvasPaint();
    const blob = await callFirst(['DMT_EditorControl.getCurrentRenderedAreaImage'], tabId);
    return normalizeBinaryResult(blob, 'capture-region.png');
  }

  async function locate(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['DMT_EditorControl.zoomTo'],
      params.x,
      params.y,
      params.scaleRatio,
      params.tabId,
    );
  }

  return { capture, captureRegion, locate };
}

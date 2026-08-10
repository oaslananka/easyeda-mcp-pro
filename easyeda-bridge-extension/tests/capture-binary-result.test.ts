import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCanvasBinaryResult } from '../src/capture-binary-result.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canvas binary result policy', () => {
  it('caps the canvas budget at 1 MiB even when the bridge transport limit is larger', async () => {
    const originalBytes = new Uint8Array([1, 2, 3]);
    const result = (await normalizeCanvasBinaryResult(
      new Blob([originalBytes], { type: 'image/png' }),
      'capture.png',
      10 * 1024 * 1024,
    )) as { payloadBudgetBytes: number };

    expect(result.payloadBudgetBytes).toBe(629_145);
  });

  it('keeps an already-small PNG byte-for-byte unchanged', async () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const original = new Blob([originalBytes], { type: 'image/png' });

    const result = (await normalizeCanvasBinaryResult(original, 'capture.png', 1_000)) as {
      base64: string;
      byteLength: number;
      downsampled: boolean;
      payloadBudgetBytes: number;
    };

    expect(result).toMatchObject({
      byteLength: originalBytes.length,
      downsampled: false,
      payloadBudgetBytes: 600,
    });
    expect(Buffer.from(result.base64, 'base64')).toEqual(Buffer.from(originalBytes));
  });

  it('fails closed when the runtime cannot decode an oversized capture', async () => {
    const original = new Blob([new Uint8Array(1_000)], { type: 'image/png' });
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error('decode failed');
      }),
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {},
    });

    try {
      await expect(
        normalizeCanvasBinaryResult(original, 'capture.png', 1_000),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: originalOffscreenCanvas,
      });
    }
  });

  it('fails closed when resized PNG encoding throws', async () => {
    const original = new Blob([new Uint8Array(1_000)], { type: 'image/png' });
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 50, close: vi.fn() })),
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return { drawImage: vi.fn() };
        }
        async convertToBlob() {
          throw new Error('encode failed');
        }
      },
    });

    try {
      await expect(
        normalizeCanvasBinaryResult(original, 'capture.png', 1_000),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: originalOffscreenCanvas,
      });
    }
  });

  it('retries compression deterministically and fails if even a 1x1 PNG exceeds budget', async () => {
    const original = new Blob([new Uint8Array(1_000)], { type: 'image/png' });
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    const convertToBlob = vi
      .fn()
      .mockResolvedValueOnce(new Blob([new Uint8Array(900)], { type: 'image/png' }))
      .mockResolvedValueOnce(new Blob([new Uint8Array(500)], { type: 'image/png' }));
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 50, close: vi.fn() })),
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return { drawImage: vi.fn() };
        }
        convertToBlob = convertToBlob;
      },
    });

    try {
      const result = (await normalizeCanvasBinaryResult(original, 'capture.png', 1_000)) as {
        byteLength: number;
      };
      expect(convertToBlob).toHaveBeenCalledTimes(2);
      expect(result.byteLength).toBe(500);

      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: class {
          getContext() {
            return { drawImage: vi.fn() };
          }
          async convertToBlob() {
            return new Blob([new Uint8Array(700)], { type: 'image/png' });
          }
        },
      });
      await expect(
        normalizeCanvasBinaryResult(original, 'capture.png', 1_000),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: originalOffscreenCanvas,
      });
    }
  });

  it('fails closed with an actionable error when oversized capture resizing is unavailable', async () => {
    const original = new Blob([new Uint8Array(1_000)], { type: 'image/png' });
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: undefined });

    try {
      await expect(
        normalizeCanvasBinaryResult(original, 'capture.png', 1_000),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        message: expect.stringContaining('cannot safely downsample'),
        suggestion: expect.stringContaining('smaller capture region'),
      });
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: originalOffscreenCanvas,
      });
    }
  });

  it('downsamples an oversized PNG below the safe encoded-result budget', async () => {
    const original = new Blob([new Uint8Array(1_000)], { type: 'image/png' });
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 50, close: vi.fn() })),
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn() };
        }
        async convertToBlob() {
          return new Blob(
            [new Uint8Array(Math.max(1, Math.ceil((this.width * this.height) / 10)))],
            {
              type: 'image/png',
            },
          );
        }
      },
    });

    try {
      const result = (await normalizeCanvasBinaryResult(original, 'capture-region.png', 1_000)) as {
        byteLength: number;
        downsampled: boolean;
        originalDimensions: { width: number; height: number };
        imageDimensions: { width: number; height: number };
        payloadBudgetBytes: number;
      };
      expect(result).toMatchObject({
        downsampled: true,
        originalDimensions: { width: 100, height: 50 },
        payloadBudgetBytes: 600,
      });
      expect(result.byteLength).toBeLessThanOrEqual(600);
      expect(result.imageDimensions.width).toBeLessThan(100);
      expect(result.imageDimensions.height).toBeLessThan(50);
      expect(result.imageDimensions.width / result.imageDimensions.height).toBeCloseTo(2, 1);
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        value: originalOffscreenCanvas,
      });
    }
  });
});

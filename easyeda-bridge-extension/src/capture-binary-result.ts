import { isBlobLike, normalizeBinaryResult } from './binary-result.js';

const PAYLOAD_SAFETY_MARGIN = 0.6;
const MAX_MCP_IMAGE_RESULT_BYTES = 1_048_576;
const MAX_DOWNSAMPLE_ATTEMPTS = 8;

interface ImageDimensions {
  width: number;
  height: number;
}

function payloadTooLargeError(byteLength: number, budget: number): Error {
  return Object.assign(
    new Error(
      `Canvas capture is ${byteLength} bytes and exceeds the safe ${budget}-byte image budget, but this EasyEDA runtime cannot safely downsample it. Use a smaller capture region or lower the rendered viewport scale, then retry.`,
    ),
    {
      code: 'PAYLOAD_TOO_LARGE',
      suggestion: 'Use a smaller capture region or lower the rendered viewport scale, then retry.',
    },
  );
}

async function downsampleBlob(
  blob: Blob,
  budget: number,
): Promise<{ blob: Blob; originalDimensions: ImageDimensions; imageDimensions: ImageDimensions }> {
  const createBitmap = globalThis.createImageBitmap;
  const Canvas = globalThis.OffscreenCanvas;
  if (typeof createBitmap !== 'function' || typeof Canvas !== 'function') {
    throw payloadTooLargeError(blob.size, budget);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createBitmap(blob);
  } catch {
    throw payloadTooLargeError(blob.size, budget);
  }

  const originalDimensions = { width: bitmap.width, height: bitmap.height };
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw payloadTooLargeError(blob.size, budget);

    let width = bitmap.width;
    let height = bitmap.height;
    let currentBytes = blob.size;
    for (let attempt = 0; attempt < MAX_DOWNSAMPLE_ATTEMPTS; attempt += 1) {
      const scale = Math.min(0.95, Math.sqrt(budget / currentBytes));
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
      const canvas = new Canvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw payloadTooLargeError(blob.size, budget);
      context.drawImage(bitmap, 0, 0, width, height);

      let resized: Blob;
      try {
        resized = await canvas.convertToBlob({ type: 'image/png' });
      } catch {
        throw payloadTooLargeError(blob.size, budget);
      }
      if (resized.size <= budget) {
        return { blob: resized, originalDimensions, imageDimensions: { width, height } };
      }
      if (width === 1 && height === 1) break;
      currentBytes = resized.size;
    }
    throw payloadTooLargeError(blob.size, budget);
  } finally {
    bitmap.close();
  }
}

export async function normalizeCanvasBinaryResult(
  value: unknown,
  fallbackFileName: string,
  maxPayloadSize: number,
): Promise<unknown> {
  if (!isBlobLike(value)) return normalizeBinaryResult(value, fallbackFileName);
  const budget = Math.max(
    1,
    Math.floor(Math.min(maxPayloadSize, MAX_MCP_IMAGE_RESULT_BYTES) * PAYLOAD_SAFETY_MARGIN),
  );
  if (value.size <= budget) {
    const normalized = await normalizeBinaryResult(value, fallbackFileName);
    return normalized && typeof normalized === 'object'
      ? { ...normalized, downsampled: false, payloadBudgetBytes: budget }
      : normalized;
  }

  const resized = await downsampleBlob(value, budget);
  const normalized = await normalizeBinaryResult(resized.blob, fallbackFileName);
  return normalized && typeof normalized === 'object'
    ? {
        ...normalized,
        downsampled: true,
        originalDimensions: resized.originalDimensions,
        imageDimensions: resized.imageDimensions,
        payloadBudgetBytes: budget,
      }
    : normalized;
}

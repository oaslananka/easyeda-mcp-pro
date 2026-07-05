/**
 * Binary result handling (Blob/File → base64).
 *
 * EasyEDA Pro's manufacturing-data and canvas-capture APIs return in-memory
 * Blob/File objects (e.g. `PCB_ManufactureData.getGerberFile`,
 * `DMT_EditorControl.getCurrentRenderedAreaImage`). The bridge transport is
 * JSON-only (see `send()` in index.ts), and `JSON.stringify` on a Blob/File
 * produces `{}` — no own enumerable properties — silently dropping the
 * payload. Every dispatch case that can return a Blob/File must route its
 * result through {@link normalizeBinaryResult} before returning.
 *
 * Kept in its own module (rather than inline in index.ts) so it can be unit
 * tested without triggering index.ts's module-load side effects (WebSocket
 * bootstrap, auto-connect).
 */

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
};

export function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return (ext && MIME_TYPES_BY_EXTENSION[ext]) || 'application/octet-stream';
}

/** True for anything duck-typed as a Blob/File (has an `arrayBuffer()` method). */
export function isBlobLike(value: unknown): value is Blob {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

/**
 * Convert a Blob/File to a base64 string. Chunked to avoid a call-stack
 * overflow from `String.fromCharCode(...bytes)` on large payloads (multi-MB
 * PDFs/gerbers/canvas captures).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface BinaryResultPayload {
  base64: string;
  mimeType: string;
  fileName: string;
  byteLength: number;
}

/**
 * Convert any Blob/File dispatch result into a JSON-safe base64 payload; pass
 * through anything else (e.g. a plain netlist object) unchanged.
 */
export async function normalizeBinaryResult(
  value: unknown,
  fallbackFileName: string,
): Promise<BinaryResultPayload | unknown> {
  if (!isBlobLike(value)) return value;
  const fileName = (value as File).name || fallbackFileName;
  const base64 = await blobToBase64(value);
  return {
    base64,
    mimeType: value.type || guessMimeType(fileName),
    fileName,
    byteLength: value.size,
  };
}

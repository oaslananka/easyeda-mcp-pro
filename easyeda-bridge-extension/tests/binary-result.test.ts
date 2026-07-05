import { describe, it, expect } from 'vitest';
import {
  guessMimeType,
  isBlobLike,
  blobToBase64,
  normalizeBinaryResult,
} from '../src/binary-result.js';

describe('guessMimeType', () => {
  it('maps known extensions to their MIME type', () => {
    expect(guessMimeType('gerbers.zip')).toBe('application/zip');
    expect(guessMimeType('export.pdf')).toBe('application/pdf');
    expect(guessMimeType('netlist.csv')).toBe('text/csv');
    expect(guessMimeType('netlist.txt')).toBe('text/plain');
    expect(guessMimeType('capture.png')).toBe('image/png');
    expect(guessMimeType('data.json')).toBe('application/json');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(guessMimeType('weird.xyz')).toBe('application/octet-stream');
    expect(guessMimeType('no-extension')).toBe('application/octet-stream');
  });
});

describe('isBlobLike', () => {
  it('returns true for a real Blob', () => {
    expect(isBlobLike(new Blob(['hello']))).toBe(true);
  });

  it('returns true for a real File (Blob subclass)', () => {
    expect(isBlobLike(new File(['hello'], 'test.txt'))).toBe(true);
  });

  it('returns false for plain objects, arrays, and primitives', () => {
    expect(isBlobLike({ foo: 'bar' })).toBe(false);
    expect(isBlobLike([1, 2, 3])).toBe(false);
    expect(isBlobLike('a string')).toBe(false);
    expect(isBlobLike(null)).toBe(false);
    expect(isBlobLike(undefined)).toBe(false);
    expect(isBlobLike(42)).toBe(false);
  });
});

describe('blobToBase64', () => {
  it('round-trips a small blob to valid base64', async () => {
    const original = 'hello world';
    const blob = new Blob([original], { type: 'text/plain' });
    const base64 = await blobToBase64(blob);
    expect(Buffer.from(base64, 'base64').toString('utf-8')).toBe(original);
  });

  it('round-trips a large payload spanning multiple chunk boundaries', async () => {
    // 0x8000 (32768) is the chunk size in blobToBase64; exceed several chunks.
    const bytes = new Uint8Array(0x8000 * 3 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const blob = new Blob([bytes]);

    const base64 = await blobToBase64(blob);
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(bytes.length);
    expect(new Uint8Array(decoded)).toEqual(bytes);
  });
});

describe('normalizeBinaryResult', () => {
  it('converts a Blob into a base64 payload using the fallback file name', async () => {
    const blob = new Blob(['%PDF-1.4 fake pdf bytes'], { type: 'application/pdf' });
    const result = await normalizeBinaryResult(blob, 'export.pdf');

    expect(result).toMatchObject({
      mimeType: 'application/pdf',
      fileName: 'export.pdf',
      byteLength: blob.size,
    });
    expect(typeof (result as { base64: string }).base64).toBe('string');
    expect(Buffer.from((result as { base64: string }).base64, 'base64').toString()).toBe(
      '%PDF-1.4 fake pdf bytes',
    );
  });

  it("prefers a File object's own name over the fallback", async () => {
    const file = new File(['csv,data'], 'pick-place.csv', { type: 'text/csv' });
    const result = await normalizeBinaryResult(file, 'fallback.csv');
    expect(result).toMatchObject({ fileName: 'pick-place.csv', mimeType: 'text/csv' });
  });

  it('guesses a MIME type from the file name when blob.type is empty', async () => {
    const blob = new Blob(['zip bytes']);
    const result = await normalizeBinaryResult(blob, 'gerbers.zip');
    expect(result).toMatchObject({ mimeType: 'application/zip', fileName: 'gerbers.zip' });
  });

  it('passes through non-Blob values unchanged', async () => {
    const plainNetlist = { nets: ['GND', 'VCC'], format: 'pads' };
    const result = await normalizeBinaryResult(plainNetlist, 'netlist.txt');
    expect(result).toBe(plainNetlist);
  });

  it('passes through undefined unchanged', async () => {
    const result = await normalizeBinaryResult(undefined, 'capture.png');
    expect(result).toBeUndefined();
  });
});

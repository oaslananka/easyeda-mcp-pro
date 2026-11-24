import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';

// This is deliberately a narrow reader for EasyEDA's native two-file OBJ export,
// not a general archive extractor. No entry is ever written to disk.
const MAX_ARCHIVE = 700 * 1024;
const MAX_INFLATED = 8 * 1024 * 1024;
const MAX_MATERIAL = 128 * 1024;

interface Entry {
  name: string;
  offset: number;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
}

function invalid(): never {
  throw new Error('Unsupported or invalid native OBJ/MTL archive; no preview generated.');
}

function requireRange(buffer: Buffer, offset: number, size: number, limit = buffer.length): void {
  if (offset < 0 || size < 0 || offset + size > limit) invalid();
}

function decodePayload(value: unknown): Buffer {
  const payload = value as { base64?: unknown; byteLength?: unknown } | null;
  const encoded = payload?.base64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ARCHIVE / 3) * 4) {
    throw new Error('Native OBJ export is unavailable or exceeds the preview archive budget.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 22 ||
    bytes.length > MAX_ARCHIVE ||
    bytes.length !== payload?.byteLength ||
    bytes.toString('base64') !== encoded
  )
    invalid();
  return bytes;
}

function centralDirectory(bytes: Buffer): { offset: number; end: number } {
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 2 ||
    bytes.readUInt16LE(end + 10) !== 2 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    invalid();
  const offset = bytes.readUInt32LE(end + 16);
  if (offset + bytes.readUInt32LE(end + 12) !== end || offset < 30) invalid();
  return { offset, end };
}

function readCentralEntry(bytes: Buffer, start: number, end: number): [Entry, number] {
  requireRange(bytes, start, 46, end);
  if (bytes.readUInt32LE(start) !== 0x02014b50) invalid();
  const nameLength = bytes.readUInt16LE(start + 28);
  const extra = bytes.readUInt16LE(start + 30);
  const comment = bytes.readUInt16LE(start + 32);
  const next = start + 46 + nameLength + extra + comment;
  requireRange(bytes, start, next - start, end);
  const name = bytes.toString('ascii', start + 46, start + 46 + nameLength);
  if (
    !/^[A-Za-z0-9_-]{1,128}\.(?:obj|mtl)$/.test(name) ||
    !bytes.subarray(start + 46, start + 46 + nameLength).equals(Buffer.from(name, 'ascii')) ||
    bytes.readUInt16LE(start + 34) !== 0
  )
    invalid();
  const entry: Entry = {
    name,
    flags: bytes.readUInt16LE(start + 8),
    method: bytes.readUInt16LE(start + 10),
    crc: bytes.readUInt32LE(start + 16),
    compressed: bytes.readUInt32LE(start + 20),
    size: bytes.readUInt32LE(start + 24),
    offset: bytes.readUInt32LE(start + 42),
  };
  if (
    (entry.flags !== 0 && entry.flags !== 0x800) ||
    (entry.method !== 0 && entry.method !== 8) ||
    entry.size === 0 ||
    entry.size > (name.endsWith('.mtl') ? MAX_MATERIAL : MAX_INFLATED) ||
    entry.compressed === 0
  )
    invalid();
  return [entry, next];
}

function inflateEntry(bytes: Buffer, entry: Entry, limit: number): { text: string; end: number } {
  const start = entry.offset;
  requireRange(bytes, start, 30, limit);
  const nameLength = bytes.readUInt16LE(start + 26);
  const dataStart = start + 30 + nameLength + bytes.readUInt16LE(start + 28);
  requireRange(bytes, start, dataStart - start + entry.compressed, limit);
  if (
    bytes.readUInt32LE(start) !== 0x04034b50 ||
    bytes.readUInt16LE(start + 6) !== entry.flags ||
    bytes.readUInt16LE(start + 8) !== entry.method ||
    bytes.readUInt32LE(start + 14) !== entry.crc ||
    bytes.readUInt32LE(start + 18) !== entry.compressed ||
    bytes.readUInt32LE(start + 22) !== entry.size ||
    !bytes.subarray(start + 30, start + 30 + nameLength).equals(Buffer.from(entry.name))
  )
    invalid();
  const end = dataStart + entry.compressed;
  const compressed = bytes.subarray(dataStart, end);
  const raw =
    entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: entry.size });
  if (raw.length !== entry.size || crc32(raw) !== entry.crc) invalid();
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), end };
}

export function readNativeObjArchive(payload: unknown) {
  const bytes = decodePayload(payload);
  const { offset, end } = centralDirectory(bytes);
  const [first, next] = readCentralEntry(bytes, offset, end);
  const [second, last] = readCentralEntry(bytes, next, end);
  const entries: [Entry, Entry] = first.offset < second.offset ? [first, second] : [second, first];
  const obj = entries.find((entry) => entry.name.endsWith('.obj'));
  const mtl = entries.find((entry) => entry.name.endsWith('.mtl'));
  if (
    last !== end ||
    !obj ||
    !mtl ||
    obj.name.slice(0, -4) !== mtl.name.slice(0, -4) ||
    obj.size + mtl.size > MAX_INFLATED ||
    entries[0].offset !== 0
  )
    invalid();
  const a = inflateEntry(bytes, entries[0], offset);
  if (a.end !== entries[1].offset) invalid();
  const b = inflateEntry(bytes, entries[1], offset);
  if (b.end !== offset) invalid();
  return {
    obj: obj === entries[0] ? a.text : b.text,
    mtl: mtl === entries[0] ? a.text : b.text,
    mtlName: mtl.name,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

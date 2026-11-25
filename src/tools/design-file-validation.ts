/**
 * Bounded structural checks for `easyeda_export_design_file` payloads.
 *
 * These checks only confirm that the bytes are the expected kind of file (so a
 * mismatched, truncated or empty native result is never published as an
 * artifact). They are not fabrication, IPC conformance or content approval.
 */

export const DESIGN_FILE_KIND_IDS = [
  'ipc2581',
  'ipc_d356',
  'pcb_info',
  'test_points',
  'pads_layout',
  'schematic_svg',
] as const;
export type DesignFileKind = (typeof DESIGN_FILE_KIND_IDS)[number];

export interface DesignFileFormat {
  /** Extension and MIME type of the accepted payload. */
  extension: string;
  mimeType: string;
}

export type DesignFileValidation =
  { ok: true; format: DesignFileFormat } | { ok: false; error: string };

/** Smallest payload any kind can legitimately be; EasyEDA's failed IPC-2581 export is 2 bytes. */
const MIN_BYTES = 3;
/** Only the head of a file is inspected for signatures. */
const HEAD_BYTES = 4096;

/** Decode text with BOM detection (EasyEDA writes some tables as UTF-16LE). Undefined if not text. */
export function decodeText(buffer: Buffer): string | undefined {
  let text: string;
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
    } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
    } else {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
    }
  } catch {
    return undefined;
  }
  // NUL bytes mean binary data rather than a text interchange file.
  return text.includes('\u0000') ? undefined : text;
}

/**
 * Entry names of a structurally consistent ZIP archive, or undefined.
 * Walks the central directory with bounds checks; never inflates entries.
 */
export function zipEntryNames(archive: Buffer): string[] | undefined {
  if (archive.length < 30 || archive.readUInt32LE(0) !== 0x04034b50) return undefined;
  for (let eocd = archive.length - 22; eocd >= Math.max(0, archive.length - 65557); eocd--) {
    if (archive.readUInt32LE(eocd) !== 0x06054b50) continue;
    const count = archive.readUInt16LE(eocd + 10);
    const size = archive.readUInt32LE(eocd + 12);
    const offset = archive.readUInt32LE(eocd + 16);
    if (
      count === 0 ||
      eocd + 22 + archive.readUInt16LE(eocd + 20) !== archive.length ||
      offset + size !== eocd
    ) {
      continue;
    }
    const names: string[] = [];
    let cursor = offset;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) return undefined;
      const nameLength = archive.readUInt16LE(cursor + 28);
      const extraLength = archive.readUInt16LE(cursor + 30);
      const commentLength = archive.readUInt16LE(cursor + 32);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > eocd) return undefined;
      names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      cursor = end;
    }
    return cursor === eocd ? names : undefined;
  }
  return undefined;
}

function head(text: string): string {
  return text.slice(0, HEAD_BYTES).replace(/^\uFEFF/, '');
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
}

const reject = (error: string): DesignFileValidation => ({ ok: false, error });
const accept = (extension: string, mimeType: string): DesignFileValidation => ({
  ok: true,
  format: { extension, mimeType },
});

/** IPC-2581: an XML document whose root element is IPC-2581. */
function validateIpc2581(text: string | undefined): DesignFileValidation {
  if (!text) return reject('IPC-2581 export is not a text XML document.');
  const start = head(text).trimStart();
  if (!start.startsWith('<')) return reject('IPC-2581 export does not start with XML markup.');
  if (!/<IPC-2581[\s>]/.test(head(text))) {
    return reject('IPC-2581 export has no <IPC-2581> root element.');
  }
  return accept('xml', 'application/xml');
}

/**
 * IPC-D-356A: fixed-column text records. Every record starts with a comment (C),
 * parameter (P), numeric operation code (e.g. 317, 327, 367) or the 999 end record.
 */
function validateIpcD356(text: string | undefined): DesignFileValidation {
  if (!text) return reject('IPC-D-356A export is not a text file.');
  const lines = nonEmptyLines(text);
  if (lines.length < 2) return reject('IPC-D-356A export has no records.');
  if (!/^[CP]/.test(lines[0] ?? '')) {
    return reject('IPC-D-356A export does not start with a C or P header record.');
  }
  if (lines.some((line) => !/^[CP0-9]/.test(line))) {
    return reject('IPC-D-356A export contains a record with an unknown record code.');
  }
  if (!(lines[lines.length - 1] ?? '').startsWith('999')) {
    return reject('IPC-D-356A export has no 999 end-of-file record.');
  }
  return accept('ipc', 'text/plain');
}

/** Entry types EasyEDA Pro 3.2.209 writes into its native PADS archive. */
const PADS_ARCHIVE_EXTENSIONS = ['.asc', '.txt', '.c', '.d'];

/**
 * PADS: EasyEDA Pro returns a ZIP holding the PowerPCB layout (`<PCB>.asc`), the
 * PADS Logic schematic (`.txt`) and the schematic/PCB decal libraries (`.c`, `.d`).
 * A bare PADS ASCII layout (header record starting with !PADS-) is also accepted.
 */
function validatePadsLayout(buffer: Buffer, text: string | undefined): DesignFileValidation {
  const names = zipEntryNames(buffer);
  if (names) {
    const files = names.filter((name) => !name.endsWith('/')).map((name) => name.toLowerCase());
    if (!files.some((name) => name.endsWith('.asc'))) {
      return reject('PADS archive contains no .asc layout file.');
    }
    if (!files.every((name) => PADS_ARCHIVE_EXTENSIONS.some((ext) => name.endsWith(ext)))) {
      return reject('PADS archive contains entries that are not PADS design files.');
    }
    return accept('zip', 'application/zip');
  }
  if (!text) return reject('PADS layout export is neither a ZIP archive nor a text file.');
  if (!head(text).trimStart().startsWith('!PADS-')) {
    return reject('PADS layout export has no !PADS- header record.');
  }
  return accept('asc', 'text/plain');
}

/** Test points: a delimited text table with a header row. */
function validateTestPoints(text: string | undefined): DesignFileValidation {
  if (!text) return reject('Test point export is not a text table.');
  const lines = nonEmptyLines(text);
  if (!/[,\t;]/.test(lines[0] ?? '')) {
    return reject('Test point export has no delimited header row.');
  }
  return accept('csv', 'text/csv');
}

/** PCB information: a non-empty text report. */
function validatePcbInfo(text: string | undefined): DesignFileValidation {
  if (!text || nonEmptyLines(text).length === 0) {
    return reject('PCB information export is not a non-empty text report.');
  }
  return accept('txt', 'text/plain');
}

function isSvgText(text: string | undefined): boolean {
  if (!text) return false;
  const input = head(text).trimStart();
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/.test(input.charAt(cursor))) cursor++;
  };

  if (input.slice(0, 5).toLowerCase() === '<?xml') {
    const end = input.indexOf('?>', 5);
    if (end < 0) return false;
    cursor = end + 2;
    skipWhitespace();
  }
  while (true) {
    const comment = input.startsWith('<!--', cursor);
    const doctype = input.slice(cursor, cursor + 9).toLowerCase() === '<!doctype';
    if (!comment && !doctype) break;
    const marker = comment ? '-->' : '>';
    const end = input.indexOf(marker, cursor + (comment ? 4 : 9));
    if (end < 0) return false;
    cursor = end + marker.length;
    skipWhitespace();
  }
  return /^<svg[\s>]/i.test(input.slice(cursor, cursor + 5));
}

/** Schematic SVG: one SVG document, or (multi-page) a ZIP that contains only SVG pages. */
function validateSchematicSvg(buffer: Buffer, text: string | undefined): DesignFileValidation {
  if (isSvgText(text)) return accept('svg', 'image/svg+xml');
  const names = zipEntryNames(buffer);
  if (names) {
    const files = names.filter((name) => !name.endsWith('/'));
    if (files.length > 0 && files.every((name) => name.toLowerCase().endsWith('.svg'))) {
      return accept('zip', 'application/zip');
    }
    return reject('Schematic SVG archive contains entries that are not SVG pages.');
  }
  return reject('Schematic SVG export is neither an SVG document nor a ZIP of SVG pages.');
}

export function validateDesignFile(kind: DesignFileKind, buffer: Buffer): DesignFileValidation {
  if (buffer.byteLength < MIN_BYTES) return reject(`Bridge returned an empty ${kind} file.`);
  const text = decodeText(buffer);
  switch (kind) {
    case 'ipc2581':
      return validateIpc2581(text);
    case 'ipc_d356':
      return validateIpcD356(text);
    case 'pcb_info':
      return validatePcbInfo(text);
    case 'test_points':
      return validateTestPoints(text);
    case 'pads_layout':
      return validatePadsLayout(buffer, text);
    case 'schematic_svg':
      return validateSchematicSvg(buffer, text);
  }
}

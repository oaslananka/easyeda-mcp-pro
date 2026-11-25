import { describe, expect, it } from 'vitest';
import {
  decodeText,
  validateDesignFile,
  zipEntryNames,
  type DesignFileKind,
} from '../../../src/tools/design-file-validation.js';

const utf16le = (text: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/** Stored ZIP with one-byte entries; enough for central-directory checks. */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    const entry = Buffer.concat([local, n, Buffer.from('x')]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, n]));
    locals.push(entry);
    offset += entry.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

const IPC_D356 = 'C  netlist\nP  JOB   demo\n317GND     U1 -1 PA0300D0  PA X+001000Y+002000\n999\n';
const IPC_2581 = '<?xml version="1.0" encoding="UTF-8"?>\n<IPC-2581 revision="C">\n</IPC-2581>';

describe('validateDesignFile', () => {
  it.each<[DesignFileKind, Buffer, string, string]>([
    ['ipc2581', Buffer.from(IPC_2581), 'xml', 'application/xml'],
    ['ipc2581', Buffer.from('\uFEFF<IPC-2581 revision="C"></IPC-2581>'), 'xml', 'application/xml'],
    ['ipc_d356', Buffer.from(IPC_D356.replace(/\n/g, '\r\n')), 'ipc', 'text/plain'],
    ['pads_layout', Buffer.from('!PADS-POWERPCB-V9.0-MILS!\n*PART*\n'), 'asc', 'text/plain'],
    ['test_points', Buffer.from('Net,X,Y,Side\nGND,1,2,T\n'), 'csv', 'text/csv'],
    ['test_points', utf16le('Net\tX\tY\nGND\t1\t2\n'), 'csv', 'text/csv'],
    ['pcb_info', Buffer.from('Board size: 30 x 25 mm\nLayers: 2\n'), 'txt', 'text/plain'],
    [
      'schematic_svg',
      Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'),
      'svg',
      'image/svg+xml',
    ],
    ['schematic_svg', Buffer.from('<!-- page --><svg width="1"></svg>'), 'svg', 'image/svg+xml'],
    [
      'schematic_svg',
      Buffer.from('<?xml version="1.0"?>\n<!-- page -->\n<!DOCTYPE svg>\n<svg></svg>'),
      'svg',
      'image/svg+xml',
    ],
    [
      'schematic_svg',
      Buffer.from('<!-- page -->'.repeat(250) + '<svg></svg>'),
      'svg',
      'image/svg+xml',
    ],
    ['schematic_svg', zip(['P1.svg', 'pages/', 'pages/P2.SVG']), 'zip', 'application/zip'],
  ])('accepts a well-formed %s payload', (kind, buffer, extension, mimeType) => {
    expect(validateDesignFile(kind, buffer)).toEqual({ ok: true, format: { extension, mimeType } });
  });

  it.each<[string, DesignFileKind, Buffer]>([
    ['2-byte empty file', 'ipc2581', Buffer.from('{}')],
    ['XML without IPC-2581 root', 'ipc2581', Buffer.from('<?xml version="1.0"?><Other/>')],
    ['IPC-2581 root not at markup start', 'ipc2581', Buffer.from('junk <IPC-2581 revision="C">')],
    ['binary data', 'ipc2581', Buffer.from([0x3c, 0x00, 0x49, 0x50, 0x43])],
    ['invalid UTF-8', 'pcb_info', Buffer.from([0xc3, 0x28, 0x41, 0x42])],
    ['IPC-D-356A without header', 'ipc_d356', Buffer.from('317GND U1\n999\n')],
    ['IPC-D-356A unknown record', 'ipc_d356', Buffer.from('C hdr\nX bad\n999\n')],
    ['IPC-D-356A missing 999', 'ipc_d356', Buffer.from('C hdr\nP JOB x\n317GND U1\n')],
    ['IPC-D-356A single record', 'ipc_d356', Buffer.from('999\n')],
    ['PADS without header', 'pads_layout', Buffer.from('*PART*\nU1 QFN\n')],
    ['test points without delimiter', 'test_points', Buffer.from('just one column\n')],
    ['whitespace-only PCB info', 'pcb_info', Buffer.from('   \n\n  ')],
    ['HTML as SVG', 'schematic_svg', Buffer.from('<html><svg></svg></html>')],
    ['ZIP with non-SVG entry', 'schematic_svg', zip(['P1.svg', 'readme.txt'])],
    ['ZIP with only directories', 'schematic_svg', zip(['pages/'])],
    ['truncated ZIP', 'schematic_svg', zip(['P1.svg']).subarray(0, -10)],
    ['ZIP for PADS', 'pads_layout', zip(['layout.asc'])],
    ['ZIP for IPC-2581', 'ipc2581', zip(['a.xml'])],
  ])('rejects %s', (_label, kind, buffer) => {
    const result = validateDesignFile(kind, buffer);
    expect(result.ok).toBe(false);
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 (with BOM) and UTF-16 with BOMs', () => {
    expect(decodeText(Buffer.from('\uFEFFabc'))).toBe('abc');
    expect(decodeText(utf16le('a,b'))).toBe('a,b');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('a,b', 'utf16le').swap16()]);
    expect(decodeText(be)).toBe('a,b');
  });

  it('returns undefined for invalid UTF-8 or embedded NUL bytes', () => {
    expect(decodeText(Buffer.from([0xff, 0x41]))).toBeUndefined();
    expect(decodeText(Buffer.from('a\u0000b'))).toBeUndefined();
  });
});

describe('zipEntryNames', () => {
  it('lists central-directory names of a consistent archive', () => {
    expect(zipEntryNames(zip(['a.svg', 'b.svg']))).toEqual(['a.svg', 'b.svg']);
  });

  it.each([
    ['not a ZIP', Buffer.from('plain text that is long enough to look like a header')],
    ['empty central directory', zip([])],
    ['truncated archive', zip(['a.svg']).subarray(0, -5)],
  ])('returns undefined for %s', (_label, buffer) => {
    expect(zipEntryNames(buffer)).toBeUndefined();
  });

  it('returns undefined when a central entry overruns the directory', () => {
    const archive = zip(['a.svg']);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt16LE(500, central + 28);
    expect(zipEntryNames(archive)).toBeUndefined();
  });
});

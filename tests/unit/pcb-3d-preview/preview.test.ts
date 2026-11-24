import { crc32, deflateRawSync, inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { pcb3dPreviewTool as tool } from '../../../src/tools/L1_pcb_3d_preview.js';
import { getRequiredToolScopes, remoteRiskForTool } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { renderNativeObjPreview } from '../../../src/pcb-3d-preview/index.js';

const OBJ = [
  'mtllib board.mtl',
  'usemtl body',
  'v 0 0 0',
  'v 4 0 0',
  'v 4 3 0',
  'v 0 3 0',
  'v 0 0 2',
  'v 4 0 2',
  'v 4 3 2',
  'v 0 3 2',
  'f 1 2 3',
  'f 1 3 4',
  'f 5 7 6',
  'f 5 8 7',
  'f 1 5 6',
  'f 1 6 2',
  'f 2 6 7',
  'f 2 7 3',
  'f 3 7 8',
  'f 3 8 4',
  'f 4 8 5',
  'f 4 5 1',
].join('\n');
const MTL = 'newmtl body\nKd 0.2 0.7 0.3\n';

function archive(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, source] of entries) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(source);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function payload(obj = OBJ, mtl = MTL) {
  const bytes = archive([
    ['board.mtl', mtl],
    ['board.obj', obj],
  ]);
  return { base64: bytes.toString('base64'), byteLength: bytes.length };
}

describe('exported PCB geometry preview', () => {
  it('renders deterministic nonblank PNG pixels from a real triangle mesh', () => {
    const first = renderNativeObjPreview(payload(), 'isometric');
    const second = renderNativeObjPreview(payload(), 'isometric');
    expect(first.png.equals(second.png)).toBe(true);
    expect(first.vertexCount).toBe(8);
    expect(first.triangleCount).toBe(12);
    expect(first.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(first.png.readUInt32BE(16)).toBe(first.width);
    expect(first.png.readUInt32BE(20)).toBe(first.height);
    const idat: Buffer[] = [];
    for (let i = 8; i < first.png.length;) {
      const size = first.png.readUInt32BE(i);
      const type = first.png.toString('ascii', i + 4, i + 8);
      if (type === 'IDAT') idat.push(first.png.subarray(i + 8, i + 8 + size));
      i += size + 12;
    }
    const raw = inflateSync(Buffer.concat(idat));
    expect(raw.length).toBe(first.height * (first.width * 3 + 1));
    expect(new Set(raw).size).toBeGreaterThan(4);
  });

  it('uses a distinct underside camera without changing exported geometry', () => {
    const top = renderNativeObjPreview(payload(), 'isometric');
    const bottom = renderNativeObjPreview(payload(), 'underside');
    expect(top.sourceSha256).toBe(bottom.sourceSha256);
    expect(top.png.equals(bottom.png)).toBe(false);
  });

  it.each([
    ['invalid index', OBJ.replace('f 1 2 3', 'f 1 2 99')],
    ['non-finite vertex', OBJ.replace('v 0 0 0', 'v Infinity 0 0')],
    ['no triangles', 'mtllib board.mtl\nv 0 0 0'],
    ['external file', OBJ + '\ncall secret.obj'],
    ['different material file', OBJ.replace('board.mtl', 'other.mtl')],
  ])('rejects %s', (_label, obj) => {
    expect(() => renderNativeObjPreview(payload(obj), 'isometric')).toThrow();
  });

  it('rejects archive traversal, extra files, bad CRC and invalid base64', () => {
    const wrap = (bytes: Buffer) => ({
      base64: bytes.toString('base64'),
      byteLength: bytes.length,
    });
    expect(() =>
      renderNativeObjPreview(
        wrap(
          archive([
            ['../board.mtl', MTL],
            ['board.obj', OBJ],
          ]),
        ),
        'isometric',
      ),
    ).toThrow();
    expect(() =>
      renderNativeObjPreview(
        wrap(
          archive([
            ['board.mtl', MTL],
            ['board.obj', OBJ],
            ['extra.txt', 'x'],
          ]),
        ),
        'isometric',
      ),
    ).toThrow();
    const corrupt = archive([
      ['board.mtl', MTL],
      ['board.obj', OBJ],
    ]);
    corrupt[14] ^= 1;
    expect(() => renderNativeObjPreview(wrap(corrupt), 'isometric')).toThrow();
    expect(() => renderNativeObjPreview({ base64: '!!!!' }, 'isometric')).toThrow();
    expect(() => renderNativeObjPreview({ ...payload(), byteLength: 1 }, 'isometric')).toThrow();
  });
});

describe('PCB preview MCP contract', () => {
  const input = tool.inputSchema.parse({ projectId: 'p', pcbId: 'b' });
  it('keeps export authorization and returns an image from scoped native bytes', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ ...payload(), projectId: 'p', pcbId: 'b', autoGenerateModels: false });
    const result = tool.outputSchema.parse(
      await tool.handler({ bridge: { call } } as unknown as ToolContext, input),
    );
    expect(getRequiredToolScopes(tool)).toEqual(['export:write']);
    expect(remoteRiskForTool(tool)).toBe('export');
    expect(call).toHaveBeenCalledWith(
      'board.preview3d',
      { projectId: 'p', pcbId: 'b' },
      { timeoutMs: 60_000 },
    );
    expect(result).toMatchObject({
      preview_generated: true,
      native_capture: false,
      model_coverage: 'unverified',
    });
    expect(tool.imageContent?.(result)).toEqual([
      { data: result.image_base64, mimeType: 'image/png' },
    ]);
    expect(tool.imageContentOmitFields).toEqual(['image_base64']);
  });

  it.each([
    {},
    { projectId: 'other', pcbId: 'b', autoGenerateModels: false },
    { projectId: 'p', pcbId: 'other', autoGenerateModels: false },
    { projectId: 'p', pcbId: 'b', autoGenerateModels: true },
  ])('fails closed for missing or mismatched proof', async (proof) => {
    const call = vi.fn().mockResolvedValue({ ...payload(), ...proof });
    const result = await tool.handler({ bridge: { call } } as unknown as ToolContext, input);
    expect(result).toMatchObject({ preview_generated: false, not_available: true });
    expect(tool.imageContent?.(result)).toEqual([]);
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerExportTools } from '../../../src/tools/L1_export.js';
import { EnvSchema } from '../../../src/config/env.js';

const VALID_TGZ = Buffer.from(
  'H4sIAAAAAAAC/+3NMQqDQBBG4ak9xfYWjsuifbD3DANaBLIQdAWP72oj2EeQvK95w99MtDS91yoekd/QrAnhaHatqvfnve+1htaLU7nBMieb8nv5T333Kks3W/x+RjdYskIAAAAAAAAAAAAAAAAAAA+wAR47t0YAKAAA',
  'base64',
);
const VALID_ZIP = Buffer.from(
  'UEsDBBQAAAAIAFK4YV2xrdukFAAAABIAAAANAAAAbWF0cml4L21hdHJpePN3cdLWVihOzC3ISVVISSxJ5AIAUEsBAhQDFAAAAAgAUrhhXbGt26QUAAAAEgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hdHJpeC9tYXRyaXhQSwUGAAAAAAEAAQA7AAAAPwAAAAAA',
  'base64',
);

/** Minimal stored ZIP with the given entry names (for format checks only). */
function zipWithEntries(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from('x');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(1, 18);
    local.writeUInt32LE(1, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(1, 20);
    central.writeUInt32LE(1, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localEntry);
    offset += localEntry.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

describe('Export Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;
  let tmpArtifactDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerExportTools(registry, config);

    bridgeCall = vi.fn();
    tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-tools-'));

    context = {
      profile: 'pro',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: tmpArtifactDir,
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    } as unknown as ToolContext;
  });

  afterEach(() => {
    fs.rmSync(tmpArtifactDir, { recursive: true, force: true });
  });

  it('rejects blank project IDs for Gerber and pick-and-place exports at the public schema boundary', () => {
    for (const name of ['easyeda_export_gerbers', 'easyeda_export_pick_place']) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.safeParse({ projectId: '' }).success, name).toBe(false);
      expect(tool!.inputSchema.safeParse({ projectId: '   ' }).success, name).toBe(false);
    }
  });

  it('classifies filesystem exports as artifact writes without design-mutation confirmation', () => {
    for (const name of [
      'easyeda_export_gerbers',
      'easyeda_export_pick_place',
      'easyeda_export_pdf',
      'easyeda_export_netlist',
      'easyeda_export_odb',
      'easyeda_export_design_file',
    ]) {
      const tool = registry.get(name);
      expect(tool?.sideEffect, name).toBe('artifact-write');
      expect(tool?.confirmWrite, name).toBe(false);
    }

    expect(registry.get('easyeda_jlcpcb_quote_workflow')?.sideEffect).toBe('read-only');
    expect(registry.get('easyeda_production_qa_artifacts')?.sideEffect).toBe('read-only');
  });

  it('easyeda_export_gerbers warns with production review findings but still exports in warn mode', async () => {
    const tool = registry.get('easyeda_export_gerbers');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: Buffer.from('fake gerber zip bytes').toString('base64'),
      fileName: 'gerbers.zip',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      productionReview: {
        mode: 'warn',
        boardData: {
          hasOutline: true,
          hasLayerStack: true,
          hasNetClasses: true,
          hasClearanceRules: true,
          hasKeepoutAreas: true,
          hasPlacementZones: true,
          hasFiducials: true,
          mountingHoleCount: 4,
          manufacturingProcess: 'standard',
          hasQuantity: true,
          hasDrillFile: false,
        },
      },
    });

    expect(bridgeCall).toHaveBeenCalledWith('board.exportGerbers', {
      projectId: 'proj-123',
      drillFormat: undefined,
      excludeLayer: undefined,
      ledPanel: undefined,
    });
    expect(result?.exported).toBe(true);
    expect(result?.production_review?.passed).toBe(false);
    expect(result?.production_review?.errors[0].code).toBe('PCB_DRILL_FILE_MISSING');
    expect(result?.artifact_path).toBeTruthy();
    expect(fs.readFileSync(result!.artifact_path!, 'utf-8')).toBe('fake gerber zip bytes');
  });

  it('easyeda_export_gerbers blocks before bridge export when production review is in block mode', async () => {
    const tool = registry.get('easyeda_export_gerbers');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      productionReview: {
        mode: 'block',
        boardData: {
          hasOutline: true,
          hasLayerStack: true,
          hasNetClasses: true,
          hasClearanceRules: true,
          hasKeepoutAreas: true,
          hasPlacementZones: true,
          hasFiducials: true,
          mountingHoleCount: 4,
          manufacturingProcess: 'standard',
          hasQuantity: true,
          hasDrillFile: false,
        },
      },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.exported).toBe(false);
    expect(result?.blocked_by_production_review).toBe(true);
    expect(result?.production_review?.blocked).toBe(true);
  });

  it('easyeda_export_gerbers reports not_available when the bridge does not return file data', async () => {
    const tool = registry.get('easyeda_export_gerbers');
    bridgeCall.mockResolvedValue({});

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result?.exported).toBe(false);
    expect(result?.not_available).toBe(true);
    expect(result?.error).toBeTruthy();
  });

  it('easyeda_export_pick_place decodes the bridge payload and writes it to the artifact directory', async () => {
    const tool = registry.get('easyeda_export_pick_place');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: Buffer.from('ref,x,y,rotation,layer\nR1,1,2,0,top').toString('base64'),
      fileName: 'pick-place.csv',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });

    expect(bridgeCall).toHaveBeenCalledWith('export.pickPlace', {
      projectId: 'proj-123',
      format: 'csv',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      format: 'csv',
      exported: true,
    });
    expect(result?.file_path).toBeTruthy();
    expect(path.dirname(result!.file_path!)).toBe(path.resolve(tmpArtifactDir));
    expect(fs.readFileSync(result!.file_path!, 'utf-8')).toBe(
      'ref,x,y,rotation,layer\nR1,1,2,0,top',
    );
  });

  it('normalizes real EasyEDA UTF-16LE tab-separated pick-and-place into UTF-8 comma CSV', async () => {
    const native =
      'Designator\tDevice\tComment\r\n' +
      '"LED1"\t"KT-0603W"\t"white, LED"\r\n' +
      '"R1"\t"1 kΩ"\t"quoted ""value"""\r\n';
    bridgeCall.mockResolvedValue({
      base64: Buffer.from('\ufeff' + native, 'utf16le').toString('base64'),
      fileName: 'proj-123',
    });

    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    expect(result?.exported).toBe(true);
    expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-pick-place.csv'));
    const output = fs.readFileSync(result!.file_path!, 'utf8');
    expect(output).toBe(
      'Designator,Device,Comment\n' +
        'LED1,KT-0603W,"white, LED"\n' +
        'R1,1 kΩ,"quoted ""value"""\n',
    );
    expect(output).not.toContain('\u0000');
  });

  it('rejects unterminated quoted fields from native pick-and-place instead of exporting corrupt CSV', async () => {
    bridgeCall.mockResolvedValue({
      base64: Buffer.from('\ufeffDesignator\tDevice\r\n"LED1\tbroken', 'utf16le').toString(
        'base64',
      ),
    });
    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    expect(result?.exported).toBe(false);
    expect(result?.error).toMatch(/unterminated quoted field/);
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it('normalizes UTF-16LE pick-and-place with no TAB without inventing columns', async () => {
    bridgeCall.mockResolvedValue({
      base64: Buffer.from('\ufeffReference,Position\r\nR1,1\r\n', 'utf16le').toString('base64'),
    });
    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    expect(result?.exported).toBe(true);
    expect(fs.readFileSync(result!.file_path!, 'utf8')).toBe('Reference,Position\r\nR1,1\r\n');
  });

  it('fails closed when native pick-and-place returns no payload', async () => {
    bridgeCall.mockResolvedValue(undefined);
    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    expect(result?.exported).toBe(false);
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it('keeps quoted TABs and newlines inside UTF-16LE pick-and-place fields', async () => {
    bridgeCall.mockResolvedValue({
      base64: Buffer.from(
        '\ufeffReference\tComment\nLED1\t"line one\nline\ttwo"\nR1\t"value, 1k"',
        'utf16le',
      ).toString('base64'),
    });
    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    expect(result?.exported).toBe(true);
    expect(fs.readFileSync(result!.file_path!, 'utf8')).toBe(
      'Reference,Comment\nLED1,"line one\nline\ttwo"\nR1,"value, 1k"\n',
    );
  });

  it('supports requested TXT output from native UTF-16LE TSV with CR-only delimiters', async () => {
    bridgeCall.mockResolvedValue({
      base64: Buffer.from('\ufeffRef\tX\rR1\t1\r', 'utf16le').toString('base64'),
    });
    const result = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'txt',
    });
    expect(result?.exported).toBe(true);
    expect(fs.readFileSync(result!.file_path!, 'utf8')).toBe('Ref\tX\nR1\t1\n');
  });

  it('keeps extensionless native export filenames distinct across pick-and-place and Gerbers', async () => {
    bridgeCall.mockImplementation(async (method: string) => ({
      base64: Buffer.from(
        method === 'export.pickPlace' ? 'pick-place bytes' : 'gerber bytes',
      ).toString('base64'),
      fileName: 'proj-123',
    }));

    const pickPlace = await registry.get('easyeda_export_pick_place')!.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
    });
    const gerbers = await registry.get('easyeda_export_gerbers')!.handler(context, {
      projectId: 'proj-123',
    });

    expect(pickPlace?.exported).toBe(true);
    expect(gerbers?.exported).toBe(true);
    expect(pickPlace?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-pick-place.csv'));
    expect(gerbers?.artifact_path).toBe(path.join(tmpArtifactDir, 'proj-123-gerbers.zip'));
    expect(fs.readFileSync(pickPlace!.file_path!, 'utf8')).toBe('pick-place bytes');
    expect(fs.readFileSync(gerbers!.artifact_path!, 'utf8')).toBe('gerber bytes');
  });

  it('easyeda_export_pick_place writes to an explicit filePath within the artifact directory', async () => {
    const tool = registry.get('easyeda_export_pick_place');
    bridgeCall.mockResolvedValue({ base64: Buffer.from('data').toString('base64') });

    const explicitPath = path.join(tmpArtifactDir, 'nested', 'custom.csv');
    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
      filePath: explicitPath,
    });

    expect(result?.file_path).toBe(explicitPath);
    expect(fs.existsSync(explicitPath)).toBe(true);
  });

  it('easyeda_export_pick_place rejects a filePath that escapes the artifact directory', async () => {
    const tool = registry.get('easyeda_export_pick_place');
    bridgeCall.mockResolvedValue({ base64: Buffer.from('data').toString('base64') });

    const outsidePath = path.join(os.tmpdir(), 'outside-pick-place.csv');
    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      format: 'csv',
      filePath: outsidePath,
    });

    expect(result?.exported).toBe(false);
    expect(result?.not_available).toBe(true);
  });

  it('enforces containment against ARTIFACT_DIR derived from DATA_DIR', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-derived-data-'));
    try {
      const config = EnvSchema.parse({ NODE_ENV: 'test', DATA_DIR: dataDir });
      context.config.artifactDir = config.ARTIFACT_DIR;

      const tool = registry.get('easyeda_export_pick_place');
      bridgeCall.mockResolvedValue({ base64: Buffer.from('data').toString('base64') });

      const outsidePath = path.join(dataDir, 'outside-derived-artifact-dir.csv');
      const result = await tool?.handler(context, {
        projectId: 'proj-123',
        format: 'csv',
        filePath: outsidePath,
      });

      expect(result?.exported).toBe(false);
      expect(result?.not_available).toBe(true);
      expect(fs.existsSync(outsidePath)).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('easyeda_export_pdf decodes the bridge payload and writes it to the artifact directory', async () => {
    const tool = registry.get('easyeda_export_pdf');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64'),
      fileName: 'schematic.pdf',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      scope: 'schematic',
      orientation: 'landscape',
    });

    expect(bridgeCall).toHaveBeenCalledWith('export.pdf', {
      projectId: 'proj-123',
      scope: 'schematic',
      orientation: 'landscape',
      what: 'schematic',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      scope: 'schematic',
      orientation: 'landscape',
      exported: true,
    });
    expect(fs.readFileSync(result!.file_path!, 'utf-8')).toBe('%PDF-1.4 fake pdf bytes');
  });

  it('easyeda_export_pdf rejects an empty binary payload instead of reporting a successful export', async () => {
    const tool = registry.get('easyeda_export_pdf');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: '',
      fileName: 'schematic.pdf',
      mimeType: 'application/pdf',
      byteLength: 0,
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      scope: 'schematic',
      orientation: 'landscape',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      scope: 'schematic',
      exported: false,
      not_available: true,
    });
    expect(result?.file_path).toBeUndefined();
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it('easyeda_export_pdf rejects non-PDF binary data instead of writing a bogus .pdf artifact', async () => {
    const tool = registry.get('easyeda_export_pdf');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: Buffer.from('not actually a pdf').toString('base64'),
      fileName: 'schematic.pdf',
      mimeType: 'application/pdf',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      scope: 'schematic',
      orientation: 'landscape',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      scope: 'schematic',
      exported: false,
      not_available: true,
    });
    expect(result?.error).toContain('valid PDF');
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it('easyeda_export_netlist decodes a binary bridge payload and writes it to disk', async () => {
    const tool = registry.get('easyeda_export_netlist');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue({
      base64: Buffer.from('*NET GND R1-1 R2-1').toString('base64'),
      fileName: 'netlist.net',
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      format: 'pads',
    });

    expect(bridgeCall).toHaveBeenCalledWith('export.netlist', {
      projectId: 'proj-123',
      format: 'pads',
    });

    expect(result).toMatchObject({
      project_id: 'proj-123',
      format: 'pads',
      exported: true,
    });
    expect(fs.readFileSync(result!.file_path!, 'utf-8')).toBe('*NET GND R1-1 R2-1');
  });

  it('easyeda_export_netlist writes plain (non-binary) netlist data as JSON and surfaces net_count', async () => {
    const tool = registry.get('easyeda_export_netlist');
    bridgeCall.mockResolvedValue({ netCount: 12, nets: ['GND', 'VCC'] });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      format: 'pads',
    });

    expect(result?.exported).toBe(true);
    expect(result?.net_count).toBe(12);
    const written = JSON.parse(fs.readFileSync(result!.file_path!, 'utf-8'));
    expect(written).toEqual({ netCount: 12, nets: ['GND', 'VCC'] });
  });

  it('easyeda_export_netlist reports not_available when the bridge call fails', async () => {
    const tool = registry.get('easyeda_export_netlist');
    bridgeCall.mockRejectedValue(new Error('bridge offline'));

    const result = await tool?.handler(context, { projectId: 'proj-123', format: 'pads' });

    expect(result?.exported).toBe(false);
    expect(result?.not_available).toBe(true);
    expect(result?.error).toBe('bridge offline');
  });

  it('easyeda_export_odb writes the EasyEDA tgz with its extension and passes name and drill options', async () => {
    const tool = registry.get('easyeda_export_odb');
    const tgz = VALID_TGZ;
    bridgeCall.mockResolvedValue({ base64: tgz.toString('base64'), fileName: 'proj-123-odb' });

    const result = await tool?.handler(
      context,
      tool.inputSchema.parse({ projectId: 'proj-123', nonPlatedHoles: false }),
    );

    expect(bridgeCall).toHaveBeenCalledWith('export.odb', {
      projectId: 'proj-123',
      fileName: 'proj-123-odb',
      platedHoles: true,
      nonPlatedHoles: false,
    });
    expect(result).toMatchObject({ exported: true, format: 'tgz', byte_length: tgz.byteLength });
    expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-odb.tgz'));
    expect(fs.readFileSync(result!.file_path!)).toEqual(tgz);
  });

  it('easyeda_export_odb accepts a zip archive', async () => {
    const tool = registry.get('easyeda_export_odb');
    const zip = VALID_ZIP;
    bridgeCall.mockResolvedValue({ base64: zip.toString('base64'), fileName: 'odb.zip' });

    const result = await tool?.handler(context, tool.inputSchema.parse({ projectId: 'proj-123' }));

    expect(result).toMatchObject({ exported: true, format: 'zip' });
    expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-odb.zip'));
  });

  it('easyeda_export_odb refuses a payload that is no archive and writes nothing', async () => {
    const tool = registry.get('easyeda_export_odb');
    bridgeCall.mockResolvedValue({
      base64: Buffer.from('not an archive').toString('base64'),
      fileName: 'odb',
    });

    const result = await tool?.handler(context, tool.inputSchema.parse({ projectId: 'proj-123' }));

    expect(result).toMatchObject({ exported: false, not_available: true });
    expect(result?.error).toMatch(/ODB\+\+ archive/);
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it.each([
    ['truncated gzip', VALID_TGZ.subarray(0, -5)],
    ['gzip header only', Buffer.from([0x1f, 0x8b, 0x08])],
    ['truncated ZIP', VALID_ZIP.subarray(0, -15)],
    ['ZIP header only', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])],
  ])('easyeda_export_odb refuses %s and creates no artifact', async (_name, archive) => {
    const tool = registry.get('easyeda_export_odb');
    bridgeCall.mockResolvedValue({ base64: archive.toString('base64') });
    const result = await tool?.handler(context, tool!.inputSchema.parse({ projectId: 'proj-123' }));
    expect(result).toMatchObject({ exported: false, not_available: true });
    expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
  });

  it('keeps beta ODB++ export out of the default production profiles', () => {
    const tool = registry.get('easyeda_export_odb');
    expect(tool?.profile).toBe('experimental');
    expect(tool?.sideEffect).toBe('artifact-write');
  });

  it('easyeda_export_odb reports not_available when the bridge call fails', async () => {
    const tool = registry.get('easyeda_export_odb');
    bridgeCall.mockRejectedValue(new Error('Method not found: export.odb'));

    const result = await tool?.handler(context, tool.inputSchema.parse({ projectId: 'proj-123' }));

    expect(result).toMatchObject({
      exported: false,
      not_available: true,
      error: 'Method not found: export.odb',
    });
  });

  describe('easyeda_export_design_file', () => {
    const ipcText =
      'C  IPC-D-356A netlist\nP  JOB   proj-123\n317GND     U1 -1 PA0300D0  PA X+001000Y+002000X0600Y0600R000 S0\n999\n';
    const ipc2581 = '<?xml version="1.0"?>\n<IPC-2581 revision="C"><Content/></IPC-2581>\n';
    const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');
    const parse = (input: Record<string, unknown>) =>
      registry.get('easyeda_export_design_file')!.inputSchema.parse(input);
    const run = (input: Record<string, unknown>, ctx: ToolContext = context) =>
      registry.get('easyeda_export_design_file')!.handler(ctx, parse(input));
    const hostedContext = () =>
      ({
        ...context,
        config: { ...context.config, MCP_BRIDGE_BACKEND: 'remote_relay' },
      }) as unknown as ToolContext;

    it('is an experimental artifact-write tool (beta native APIs)', () => {
      const tool = registry.get('easyeda_export_design_file');
      expect(tool?.profile).toBe('experimental');
      expect(tool?.sideEffect).toBe('artifact-write');
      expect(tool?.confirmWrite).toBe(false);
    });

    it('writes the IPC-D-356A file named by project and kind with a long timeout', async () => {
      bridgeCall.mockResolvedValue({ base64: b64(ipcText), fileName: 'proj-123-ipc_d356' });

      const result = await run({ projectId: 'proj-123', kind: 'ipc_d356' });

      expect(bridgeCall).toHaveBeenCalledWith(
        'export.designFile',
        {
          projectId: 'proj-123',
          kind: 'ipc_d356',
          fileName: 'proj-123-ipc_d356',
          unit: 'mm',
          oemNumber: 'Manufacturer Part',
        },
        { timeoutMs: 5 * 60 * 1000 },
      );
      expect(result).toMatchObject({
        exported: true,
        kind: 'ipc_d356',
        delivery: 'file',
        mime_type: 'text/plain',
      });
      expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-ipc_d356.ipc'));
      expect(fs.readFileSync(result!.file_path!, 'utf-8')).toBe(ipcText);
      expect(result?.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('passes IPC-2581 unit and OEM number options through', async () => {
      bridgeCall.mockResolvedValue({ base64: b64(ipc2581) });

      const result = await run({
        projectId: 'proj-123',
        kind: 'ipc2581',
        unit: 'inch',
        oemNumber: 'Supplier Part',
      });

      expect(bridgeCall.mock.calls[0][1]).toMatchObject({
        unit: 'inch',
        oemNumber: 'Supplier Part',
      });
      expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-ipc2581.xml'));
    });

    it('saves a multi-page schematic SVG archive with a .zip extension', async () => {
      const zip = zipWithEntries(['Sheet_1.svg', 'Sheet_2.svg']);
      bridgeCall.mockResolvedValue({ base64: zip.toString('base64'), fileName: 'schematic.zip' });

      const result = await run({ projectId: 'proj-123', kind: 'schematic_svg' });

      expect(result).toMatchObject({ exported: true, mime_type: 'application/zip' });
      expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-schematic_svg.zip'));
    });

    it('saves the native PADS archive (layout, logic schematic, decals) with a .zip extension', async () => {
      const zip = zipWithEntries([
        'proj/Board1/PCB1.asc',
        'proj/Board1/Sch/Sch.txt',
        'proj/proj.c',
        'proj/proj.d',
      ]);
      bridgeCall.mockResolvedValue({ base64: zip.toString('base64'), fileName: 'pads.zip' });

      const result = await run({ projectId: 'proj-123', kind: 'pads_layout' });

      expect(result).toMatchObject({ exported: true, mime_type: 'application/zip' });
      expect(result?.file_path).toBe(path.join(tmpArtifactDir, 'proj-123-pads_layout.zip'));
    });

    it.each([
      ['missing payload', 'ipc2581', null],
      ['empty base64', 'ipc2581', { base64: '' }],
      ['invalid base64', 'ipc2581', { base64: 'not*base64' }],
      ['2-byte empty IPC-2581 file', 'ipc2581', { base64: b64('{}') }],
      [
        'HTML error page as IPC-2581',
        'ipc2581',
        { base64: b64('<html><body>error</body></html>') },
      ],
      ['IPC-D-356A content as IPC-2581', 'ipc2581', { base64: b64(ipcText) }],
      ['IPC-2581 XML as IPC-D-356A', 'ipc_d356', { base64: b64(ipc2581) }],
      [
        'truncated IPC-D-356A without 999',
        'ipc_d356',
        { base64: b64(ipcText.replace('999\n', '')) },
      ],
      [
        'ZIP for a text-only kind',
        'ipc_d356',
        { base64: zipWithEntries(['a.ipc']).toString('base64') },
      ],
      [
        'PADS ZIP without a .asc layout',
        'pads_layout',
        { base64: zipWithEntries(['proj/Sch.txt']).toString('base64') },
      ],
      [
        'ZIP with non-SVG entries',
        'schematic_svg',
        { base64: zipWithEntries(['a.png']).toString('base64') },
      ],
      ['binary data as test points', 'test_points', { base64: b64(Buffer.from([0, 1, 2, 3, 4])) }],
    ])('refuses %s and creates no artifact', async (_label, kind, reply) => {
      bridgeCall.mockResolvedValue(reply);

      const result = await run({ projectId: 'proj-123', kind });

      expect(result).toMatchObject({ exported: false, not_available: true, kind });
      expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
    });

    it('refuses a target path outside the artifact directory', async () => {
      bridgeCall.mockResolvedValue({ base64: b64(ipcText) });

      const result = await run({
        projectId: 'proj-123',
        kind: 'ipc_d356',
        filePath: path.join(os.tmpdir(), 'outside.ipc'),
      });

      expect(result).toMatchObject({ exported: false, not_available: true });
      expect(result?.error).toMatch(/inside the artifact directory/);
    });

    it('returns validated bytes inline without touching the artifact directory', async () => {
      bridgeCall.mockResolvedValue({ base64: b64(ipcText) });

      const result = await run({ projectId: 'proj/123', kind: 'ipc_d356', delivery: 'inline' });

      expect(result).toMatchObject({
        exported: true,
        delivery: 'inline',
        file_name: 'proj_123-ipc_d356.ipc',
        mime_type: 'text/plain',
        content_base64: b64(ipcText),
        byte_length: Buffer.byteLength(ipcText),
      });
      expect(result?.file_path).toBeUndefined();
      expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
    });

    it('defaults to inline delivery in hosted Cloud mode', async () => {
      bridgeCall.mockResolvedValue({ base64: b64(ipcText) });

      const result = await run({ projectId: 'proj-123', kind: 'ipc_d356' }, hostedContext());

      expect(result).toMatchObject({ exported: true, delivery: 'inline' });
      expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
    });

    it.each([
      ['file delivery in hosted Cloud', { delivery: 'file' }, true],
      ['filePath with inline delivery', { delivery: 'inline', filePath: 'x.ipc' }, false],
    ])('rejects %s before generating', async (_label, extra, hosted) => {
      const result = await run(
        { projectId: 'proj-123', kind: 'ipc_d356', ...extra },
        hosted ? hostedContext() : context,
      );

      expect(result).toMatchObject({ exported: false, not_available: true });
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmpArtifactDir)).toEqual([]);
    });

    it('refuses inline payloads above 1 MiB', async () => {
      const big = '<?xml version="1.0"?><IPC-2581 revision="C">' + 'x'.repeat(1024 * 1024);
      bridgeCall.mockResolvedValue({ base64: b64(big) });

      const result = await run({ projectId: 'p', kind: 'ipc2581', delivery: 'inline' });

      expect(result).toMatchObject({ exported: false, not_available: true });
      expect(result?.error).toMatch(/1 MiB/);
    });

    it('reports a bridge failure as not_available', async () => {
      bridgeCall.mockRejectedValue(
        new Error('ipc_d356 export requires the PCB document to be focused.'),
      );

      const result = await run({ projectId: 'proj-123', kind: 'ipc_d356' });

      expect(result).toMatchObject({ exported: false, not_available: true });
      expect(result?.error).toMatch(/PCB document/);
    });

    it('rejects unknown kinds, blank project IDs and unknown options at the schema boundary', () => {
      const tool = registry.get('easyeda_export_design_file')!;
      expect(tool.inputSchema.safeParse({ projectId: 'p', kind: 'placePcbOrder' }).success).toBe(
        false,
      );
      expect(tool.inputSchema.safeParse({ projectId: ' ', kind: 'ipc_d356' }).success).toBe(false);
      expect(
        tool.inputSchema.safeParse({ projectId: 'p', kind: 'ipc2581', unit: 'mil' }).success,
      ).toBe(false);
      expect(
        tool.inputSchema.safeParse({ projectId: 'p', kind: 'ipc2581', delivery: 'email' }).success,
      ).toBe(false);
    });
  });
});

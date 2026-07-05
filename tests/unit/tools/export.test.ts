import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerExportTools } from '../../../src/tools/L1_export.js';
import { EnvSchema } from '../../../src/config/env.js';

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
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerBomCoreTools } from '../../../src/tools/L1_bom_core.js';
import { registerBomSourcingTools } from '../../../src/tools/L1_bom_sourcing.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('BOM Tools Sourcing & Validate', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;
  let getPartDetailMock: any;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test', JLCSEARCH_ENABLED: 'true' });
    registerBomCoreTools(registry, config);
    registerBomSourcingTools(registry, config);

    bridgeCall = vi.fn();
    getPartDetailMock = vi.fn();

    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
      vendors: {
        lcsc: {
          getPartDetail: getPartDetailMock,
        } as any,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('easyeda_bom_sourcing should query LCSC client and return correct sourcing data', async () => {
    const tool = registry.get('easyeda_bom_sourcing');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue([
      { reference: 'R1', value: '10k', lcsc: 'C12345', quantity: 1 },
      { reference: 'C1', value: '100nF', lcsc: 'C67890', quantity: 2 },
    ]);

    getPartDetailMock.mockImplementation(async (lcscCode: string) => {
      if (lcscCode === 'C12345') {
        return {
          lcsc: 'C12345',
          stockCount: 1500,
          price: '0.015',
          leadTime: 2,
        };
      }
      return null;
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
      suppliers: ['lcsc'],
    });

    expect(bridgeCall).toHaveBeenCalledWith('bom.generate', {
      projectId: 'proj-123',
      format: 'json',
      groupBy: 'lcsc',
    });

    expect(result).toBeDefined();
    expect(result.project_id).toBe('proj-123');
    expect(result.total_parts).toBe(2);
    expect(result.parts[0]).toMatchObject({
      reference: 'R1',
      value: '10k',
      lcsc: 'C12345',
      sourcing: [
        {
          supplier: 'lcsc',
          in_stock: true,
          quantity_available: 1500,
          unit_price: 0.015,
          currency: 'USD',
          lead_time_days: 2,
        },
      ],
    });
    expect(result.parts[1]?.sourcing).toHaveLength(0);
  });

  it('easyeda_bom_validate should categorize missing, invalid, and obsolete parts', async () => {
    const tool = registry.get('easyeda_bom_validate');
    expect(tool).toBeDefined();

    bridgeCall.mockResolvedValue([
      { reference: 'R1', value: '10k' }, // Missing LCSC
      { reference: 'C1', value: '100nF', lcsc: 'C99999' }, // Invalid
      { reference: 'U1', value: 'MCU', lcsc: 'C55555' }, // Obsolete
      { reference: 'Q1', value: 'MOSFET', lcsc: 'C11111' }, // Valid
    ]);

    getPartDetailMock.mockImplementation(async (lcscCode: string) => {
      if (lcscCode === 'C55555') {
        return { lcsc: 'C55555', discontinued: true };
      }
      if (lcscCode === 'C11111') {
        return { lcsc: 'C11111', discontinued: false, stock: 100 };
      }
      return null; // C99999 is invalid
    });

    const result = await tool?.handler(context, {
      projectId: 'proj-123',
    });

    expect(result).toBeDefined();
    expect(result.project_id).toBe('proj-123');
    expect(result.total_parts).toBe(4);
    expect(result.missing_lcsc).toContain('R1');
    expect(result.invalid_lcsc).toContain('C1');
    expect(result.obsolete).toContain('U1');
    expect(result.valid_count).toBe(1);
    expect(result.validated).toBe(true);
  });

  it('easyeda_bom_validate should return not_available when the bridge call fails', async () => {
    const tool = registry.get('easyeda_bom_validate');
    bridgeCall.mockRejectedValue(new Error('bridge offline'));

    const result = await tool?.handler(context, { projectId: 'proj-123' });

    expect(result.validated).toBe(false);
    expect(result.not_available).toBe(true);
    expect(result.error).toBe('bridge offline');
  });

  describe('easyeda_bom_generate', () => {
    it('returns formatted entries on success', async () => {
      const tool = registry.get('easyeda_bom_generate');
      bridgeCall.mockResolvedValue([
        { reference: 'R1', value: '10k', footprint: '0603', lcsc: 'C1', quantity: 2 },
      ]);

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'json',
        groupBy: 'value',
      });

      expect(bridgeCall).toHaveBeenCalledWith('bom.generate', {
        projectId: 'proj-1',
        format: 'json',
        groupBy: 'value',
      });
      expect(result.total_entries).toBe(1);
      expect(result.entries[0]).toMatchObject({ reference: 'R1', value: '10k', quantity: 2 });
    });

    it('returns not_available when the bridge call fails', async () => {
      const tool = registry.get('easyeda_bom_generate');
      bridgeCall.mockRejectedValue(new Error('no active project'));

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'json',
        groupBy: 'value',
      });

      expect(result.not_available).toBe(true);
      expect(result.total_entries).toBe(0);
      expect(result.error).toBe('no active project');
    });
  });

  describe('easyeda_bom_export', () => {
    let tmpArtifactDir: string;

    beforeEach(() => {
      tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-export-'));
      context.config.artifactDir = tmpArtifactDir;
    });

    afterEach(() => {
      fs.rmSync(tmpArtifactDir, { recursive: true, force: true });
    });

    it('exports the BOM to a file inside the artifact directory', async () => {
      const tool = registry.get('easyeda_bom_export');
      bridgeCall.mockResolvedValue({ entryCount: 3 });
      const filePath = path.join(tmpArtifactDir, 'bom.csv');

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'csv',
        filePath,
      });

      expect(result.exported).toBe(true);
      expect(result.entry_count).toBe(3);
    });

    it('creates missing parent directories before exporting', async () => {
      const tool = registry.get('easyeda_bom_export');
      bridgeCall.mockResolvedValue({ entryCount: 1 });
      const filePath = path.join(tmpArtifactDir, 'nested', 'dir', 'bom.csv');

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'csv',
        filePath,
      });

      expect(result.exported).toBe(true);
      expect(fs.existsSync(path.dirname(filePath))).toBe(true);
    });

    it('rejects a file path that escapes the artifact directory', async () => {
      const tool = registry.get('easyeda_bom_export');
      const outsidePath = path.join(os.tmpdir(), 'outside-bom.csv');

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'csv',
        filePath: outsidePath,
      });

      expect(result.exported).toBe(false);
      expect(result.not_available).toBe(true);
      expect(bridgeCall).not.toHaveBeenCalled();
    });

    it('returns not_available when the bridge export call fails', async () => {
      const tool = registry.get('easyeda_bom_export');
      bridgeCall.mockRejectedValue(new Error('export failed'));
      const filePath = path.join(tmpArtifactDir, 'bom.csv');

      const result = await tool?.handler(context, {
        projectId: 'proj-1',
        format: 'csv',
        filePath,
      });

      expect(result.exported).toBe(false);
      expect(result.not_available).toBe(true);
      expect(result.error).toBe('export failed');
    });
  });

  describe('easyeda_bom_sourcing edge cases', () => {
    it('returns an empty parts list when the BOM has no entries', async () => {
      const tool = registry.get('easyeda_bom_sourcing');
      bridgeCall.mockResolvedValue([]);

      const result = await tool?.handler(context, { projectId: 'proj-1' });

      expect(result).toEqual({ project_id: 'proj-1', parts: [], total_parts: 0 });
    });

    it('returns not_available when the bridge call fails', async () => {
      const tool = registry.get('easyeda_bom_sourcing');
      bridgeCall.mockRejectedValue(new Error('bridge offline'));

      const result = await tool?.handler(context, { projectId: 'proj-1' });

      expect(result.not_available).toBe(true);
      expect(result.parts).toEqual([]);
    });
  });

  describe('easyeda_bom_quality_report', () => {
    it('returns an empty report when the BOM has no entries', async () => {
      const tool = registry.get('easyeda_bom_quality_report');
      bridgeCall.mockResolvedValue([]);

      const result = await tool?.handler(context, { projectId: 'proj-1' });

      expect(result.total_entries).toBe(0);
      expect(result.entries).toEqual([]);
      expect(result.has_supplier_errors).toBe(false);
    });

    it('generates a quality report for BOM entries with no vendor clients configured', async () => {
      const tool = registry.get('easyeda_bom_quality_report');
      bridgeCall.mockResolvedValue([
        { reference: 'R1', value: '10k', footprint: '0603', quantity: 1 },
      ]);
      context.vendors = { lcsc: null, jlcpcb: null, mouser: null, digikey: null };

      const result = await tool?.handler(context, { projectId: 'proj-1' });

      expect(result.bom_id).toBe('proj-1');
      expect(result.total_entries).toBe(1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].reference).toBe('R1');
    });

    it('returns not_available when the bridge call fails', async () => {
      const tool = registry.get('easyeda_bom_quality_report');
      bridgeCall.mockRejectedValue(new Error('bridge offline'));

      const result = await tool?.handler(context, { projectId: 'proj-1' });

      expect(result.not_available).toBe(true);
      expect(result.entries).toEqual([]);
      expect(result.error).toBe('bridge offline');
    });
  });
});

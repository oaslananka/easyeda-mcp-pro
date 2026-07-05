import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerCatalogTools } from '../../../src/tools/L1_catalog.js';
import { EnvSchema } from '../../../src/config/env.js';
import { type VerifiedDeviceRecord } from '../../../src/storage/types.js';

function createFakeStorage() {
  const records = new Map<string, VerifiedDeviceRecord>();
  return {
    upsertVerifiedDevice: vi.fn((record: Omit<VerifiedDeviceRecord, 'createdAt' | 'updatedAt'>) => {
      const now = new Date().toISOString();
      records.set(record.lcscId, {
        ...record,
        createdAt: records.get(record.lcscId)?.createdAt ?? now,
        updatedAt: now,
      });
    }),
    getVerifiedDevice: vi.fn((lcscId: string) => records.get(lcscId) ?? null),
    listVerifiedDevices: vi.fn((status?: VerifiedDeviceRecord['status']) => {
      const all = Array.from(records.values());
      return status ? all.filter((r) => r.status === status) : all;
    }),
    deleteVerifiedDevice: vi.fn((lcscId: string) => records.delete(lcscId)),
  };
}

describe('Catalog Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;
  let getPartDetailMock: any;
  let fakeStorage: ReturnType<typeof createFakeStorage>;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerCatalogTools(registry, config);

    bridgeCall = vi.fn();
    getPartDetailMock = vi.fn();
    fakeStorage = createFakeStorage();

    context = {
      profile: 'pro',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
      vendors: {
        lcsc: { getPartDetail: getPartDetailMock } as any,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
      storage: fakeStorage as any,
    };
  });

  describe('easyeda_catalog_verify_device', () => {
    it('resolves and caches a device when both sources match', async () => {
      const tool = registry.get('easyeda_catalog_verify_device');
      expect(tool).toBeDefined();

      getPartDetailMock.mockResolvedValue({
        lcsc: 'C25804',
        manufacturer: '0603WAF1002T5E',
        category: 'resistors',
        package: '0603',
        stock: 1000,
        inStock: true,
        classification: 'basic',
      });
      bridgeCall.mockResolvedValue([
        { symbol: { name: 'RES-0603' }, footprint: { name: 'R0603' } },
      ]);

      const result = await tool?.handler(context, { lcscId: 'C25804', confirmWrite: true });

      expect(result.status).toBe('resolved');
      expect(result.valid).toBe(true);
      expect(result.cached).toBe(true);
      expect(result.entry.symbolRef).toBe('SYM:RES-0603');
      expect(fakeStorage.upsertVerifiedDevice).toHaveBeenCalledWith(
        expect.objectContaining({ lcscId: 'C25804', status: 'resolved' }),
      );
    });

    it('reports not_available and does not cache when resolution fails entirely', async () => {
      const tool = registry.get('easyeda_catalog_verify_device');
      getPartDetailMock.mockResolvedValue(null);
      context.bridge = { connected: false, call: bridgeCall };

      const result = await tool?.handler(context, { lcscId: 'C000000', confirmWrite: true });

      expect(result.not_available).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.error).toBeTruthy();
      expect(fakeStorage.upsertVerifiedDevice).not.toHaveBeenCalled();
    });

    it('does not cache when storage is unavailable but still returns the result', async () => {
      const tool = registry.get('easyeda_catalog_verify_device');
      getPartDetailMock.mockResolvedValue({
        lcsc: 'C1',
        manufacturer: 'X',
        category: 'capacitors',
        package: '0402',
        stock: 1,
        inStock: true,
      });
      bridgeCall.mockResolvedValue([]);
      context.storage = undefined;

      const result = await tool?.handler(context, { lcscId: 'C1', confirmWrite: true });

      expect(result.cached).toBe(false);
      expect(result.status).toBe('unresolved');
    });
  });

  describe('easyeda_catalog_list', () => {
    it('lists cached devices', async () => {
      fakeStorage.upsertVerifiedDevice({
        lcscId: 'C1',
        entryJson: JSON.stringify({
          id: 'device-lcsc-c1',
          displayName: 'C1',
          category: 'passive',
          manufacturer: 'X',
          mpn: 'X',
          package: '0402',
          symbolRef: 'SYM:X',
          footprintRef: 'FOOT:X',
          pinMapping: [],
          lifecycleStatus: 'active',
        }),
        status: 'resolved',
        errorCount: 0,
        warningCount: 0,
      });

      const tool = registry.get('easyeda_catalog_list');
      const result = await tool?.handler(context, {});

      expect(result.total).toBe(1);
      expect(result.devices[0]).toMatchObject({ lcsc_id: 'C1', status: 'resolved' });
      expect(result.devices[0]?.entry).toMatchObject({ id: 'device-lcsc-c1', category: 'passive' });
    });

    it('filters by status', async () => {
      fakeStorage.upsertVerifiedDevice({
        lcscId: 'C1',
        entryJson: '{}',
        status: 'resolved',
        errorCount: 0,
        warningCount: 0,
      });
      fakeStorage.upsertVerifiedDevice({
        lcscId: 'C2',
        entryJson: '{}',
        status: 'unresolved',
        errorCount: 1,
        warningCount: 0,
      });

      const tool = registry.get('easyeda_catalog_list');
      const result = await tool?.handler(context, { status: 'unresolved' });

      expect(result.total).toBe(1);
      expect(result.devices[0]?.lcsc_id).toBe('C2');
    });

    it('reports not_available when storage is unavailable', async () => {
      context.storage = undefined;
      const tool = registry.get('easyeda_catalog_list');
      const result = await tool?.handler(context, {});

      expect(result.not_available).toBe(true);
      expect(result.devices).toEqual([]);
    });
  });
});

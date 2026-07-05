import { describe, it, expect, vi } from 'vitest';
import { resolvePartSourcing } from '../../../src/vendors/sourcing-facade.js';
import { type ToolContext } from '../../../src/tools/types.js';

function vendors(overrides: Partial<ToolContext['vendors']> = {}): ToolContext['vendors'] {
  return { lcsc: null, jlcpcb: null, mouser: null, digikey: null, ...overrides };
}

describe('resolvePartSourcing', () => {
  it('returns no results when no vendors are configured', async () => {
    const results = await resolvePartSourcing(vendors(), { lcsc: 'C1', mpn: 'MPN1' });
    expect(results).toEqual([]);
  });

  it('queries LCSC keyless-first when an LCSC code is known', async () => {
    const getPartDetail = vi.fn().mockResolvedValue({
      lcsc: 'C1',
      stockCount: 100,
      price: '0.01',
      classification: 'basic',
    });
    const results = await resolvePartSourcing(vendors({ lcsc: { getPartDetail } as any }), {
      lcsc: 'C1',
    });

    expect(getPartDetail).toHaveBeenCalledWith('C1');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      supplier: 'lcsc',
      tier: 'keyless',
      found: true,
      in_stock: true,
      classification: 'basic',
    });
  });

  it('skips the keyless LCSC tier when keylessSourcingEnabled is false', async () => {
    const getPartDetail = vi.fn().mockResolvedValue({ lcsc: 'C1', stockCount: 100 });
    const results = await resolvePartSourcing(
      vendors({ lcsc: { getPartDetail } as any }),
      { lcsc: 'C1' },
      { keylessSourcingEnabled: false },
    );

    expect(getPartDetail).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('does not query Mouser/DigiKey when no MPN is known', async () => {
    const searchByPartNumber = vi.fn();
    const results = await resolvePartSourcing(vendors({ mouser: { searchByPartNumber } as any }), {
      lcsc: 'C1',
    });

    expect(searchByPartNumber).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('queries Mouser as an authenticated-tier result when an MPN is known', async () => {
    const searchByPartNumber = vi
      .fn()
      .mockResolvedValue([
        { manufacturer: 'MPN1', availability: 42, priceBreaks: [{ price: 1.5 }] },
      ]);
    const results = await resolvePartSourcing(vendors({ mouser: { searchByPartNumber } as any }), {
      mpn: 'MPN1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ supplier: 'mouser', tier: 'authenticated', found: true });
  });

  it('honors an explicit suppliers filter', async () => {
    const getPartDetail = vi.fn().mockResolvedValue({ lcsc: 'C1', stockCount: 100 });
    const searchByPartNumber = vi
      .fn()
      .mockResolvedValue([{ manufacturer: 'MPN1', availability: 5 }]);

    const results = await resolvePartSourcing(
      vendors({ lcsc: { getPartDetail } as any, mouser: { searchByPartNumber } as any }),
      { lcsc: 'C1', mpn: 'MPN1' },
      { suppliers: ['mouser'] },
    );

    expect(getPartDetail).not.toHaveBeenCalled();
    expect(searchByPartNumber).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.supplier).toBe('mouser');
  });

  it('includes a not-found result rather than omitting it', async () => {
    const getPartDetail = vi.fn().mockResolvedValue(null);
    const results = await resolvePartSourcing(vendors({ lcsc: { getPartDetail } as any }), {
      lcsc: 'C1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ supplier: 'lcsc', found: false, in_stock: false });
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  LcscAdapter,
  MouserAdapter,
  DigiKeyAdapter,
  createAdapters,
  availableAdapters,
  classifySupplierFailure,
} from '../../../src/bom-quality/adapter.js';
import { EasyEdaMcpError } from '../../../src/schemas/common.js';

// ── LCSC adapter ───────────────────────────────────────────────────────────

describe('LcscAdapter', () => {
  it('returns null when client is null', async () => {
    const adapter = new LcscAdapter(null);
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.queryPart({ lcsc: 'C12345' })).resolves.toBeNull();
  });

  it('returns null when no identifier is provided', async () => {
    const client = { getPartDetail: vi.fn() } as any;
    const adapter = new LcscAdapter(client);
    await expect(adapter.queryPart({})).resolves.toBeNull();
  });

  it('returns null when only mpn is provided (LCSC requires lcsc code)', async () => {
    const client = { getPartDetail: vi.fn() } as any;
    const adapter = new LcscAdapter(client);
    await expect(adapter.queryPart({ mpn: 'ABC-123' })).resolves.toBeNull();
  });

  it('returns found=false for a part that does not exist', async () => {
    const client = { getPartDetail: vi.fn().mockResolvedValue(null) };
    const adapter = new LcscAdapter(client as any);
    const result = await adapter.queryPart({ lcsc: 'C99999' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(false);
    expect(result!.supplier).toBe('lcsc');
    expect(result!.status).toBe('no_match');
    expect(result!.confidence).toBe('medium');
  });

  it('returns found=true with part details for a valid part', async () => {
    const client = {
      getPartDetail: vi.fn().mockResolvedValue({
        lcsc: 'C12345',
        manufacturer: 'Texas Instruments',
        description: 'Op-Amp',
        stock: 5000,
        price: 0.15,
        stockCount: 5000,
        leadTime: 3,
        discontinued: false,
        priceBreaks: [{ quantity: 100, unitPrice: 0.12 }],
      }),
    };
    const adapter = new LcscAdapter(client as any);
    const result = await adapter.queryPart({ lcsc: 'C12345' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(true);
    expect(result!.status).toBe('found');
    expect(result!.source).toBe('lcsc:jlcsearch-or-official-api');
    expect(result!.lcsc).toBe('C12345');
    expect(result!.manufacturer).toBe('Texas Instruments');
    expect(result!.stock).toBe(5000);
    expect(result!.unitPrice).toBe(0.12);
    expect(result!.lifecycle).toBe('active');
    expect(result!.confidence).toBe('high');
    expect(result!.queriedAt).toBeTruthy();
  });

  it('detects discontinued parts', async () => {
    const client = {
      getPartDetail: vi.fn().mockResolvedValue({
        lcsc: 'C55555',
        manufacturer: 'Old Corp',
        discontinued: true,
        stock: 0,
      }),
    };
    const adapter = new LcscAdapter(client as any);
    const result = await adapter.queryPart({ lcsc: 'C55555' });
    expect(result!.lifecycle).toBe('discontinued');
  });

  it('returns low-confidence result on API error (non-throwing)', async () => {
    const client = {
      getPartDetail: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const adapter = new LcscAdapter(client as any);
    const result = await adapter.queryPart({ lcsc: 'C12345' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(false);
    expect(result!.status).toBe('unavailable');
    expect(result!.source).toBe('lcsc:jlcsearch-or-official-api');
    expect(result!.fromCache).toBe(false);
    expect(result!.cacheAgeSeconds).toBe(0);
    expect(result!.confidence).toBe('low');
  });
});

// ── Mouser adapter ─────────────────────────────────────────────────────────

describe('MouserAdapter', () => {
  it('returns null when client is null', async () => {
    const adapter = new MouserAdapter(null);
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.queryPart({ mpn: 'ABC-123' })).resolves.toBeNull();
  });

  it('returns null when no mpn is provided', async () => {
    const client = { searchByPartNumber: vi.fn() } as any;
    const adapter = new MouserAdapter(client);
    await expect(adapter.queryPart({})).resolves.toBeNull();
  });

  it('returns found=true with part details on match', async () => {
    const client = {
      searchByPartNumber: vi.fn().mockResolvedValue([
        {
          mouserNumber: '123-MFR',
          manufacturer: 'Texas Instruments',
          description: 'Precision Op-Amp',
          availability: 2500,
          leadTime: '5',
          priceBreaks: [{ quantity: 1, price: 2.5 }],
          rohs: true,
        },
      ]),
    };
    const adapter = new MouserAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'OPA-123' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(true);
    expect(result!.status).toBe('found');
    expect(result!.source).toBe('mouser:search-api');
    expect(result!.manufacturer).toBe('Texas Instruments');
    expect(result!.stock).toBe(2500);
    expect(result!.unitPrice).toBe(2.5);
    expect(result!.leadTimeDays).toBe(5);
    expect(result!.confidence).toBe('high');
  });

  it('returns found=false when no results', async () => {
    const client = {
      searchByPartNumber: vi.fn().mockResolvedValue([]),
    };
    const adapter = new MouserAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'UNKNOWN' });
    expect(result!.found).toBe(false);
    expect(result!.status).toBe('no_match');
    expect(result!.confidence).toBe('medium');
  });

  it('gracefully handles API errors', async () => {
    const client = {
      searchByPartNumber: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const adapter = new MouserAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'XYZ' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(false);
    expect(result!.status).toBe('unavailable');
    expect(result!.source).toBe('mouser:search-api');
    expect(result!.confidence).toBe('low');
  });
});

// ── DigiKey adapter ────────────────────────────────────────────────────────

describe('DigiKeyAdapter', () => {
  it('returns null when client is null', async () => {
    const adapter = new DigiKeyAdapter(null);
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.queryPart({ mpn: 'ABC-123' })).resolves.toBeNull();
  });

  it('returns null when no mpn is provided', async () => {
    const client = { searchByKeyword: vi.fn() } as any;
    const adapter = new DigiKeyAdapter(client);
    await expect(adapter.queryPart({})).resolves.toBeNull();
  });

  it('returns found=true with part details on keyword match', async () => {
    const client = {
      searchByKeyword: vi.fn().mockResolvedValue([
        {
          digiKeyPartNumber: 'DK-123',
          manufacturerPartNumber: 'MFR-456',
          manufacturer: 'Microchip',
          description: 'ATmega328',
          quantityAvailable: 1000,
          unitPrice: 3.45,
          rohsStatus: 'RoHS Compliant',
        },
      ]),
    };
    const adapter = new DigiKeyAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'MFR-456' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(true);
    expect(result!.status).toBe('found');
    expect(result!.source).toBe('digikey:product-search-api');
    // Since mpn matches, confidence should be high
    expect(result!.confidence).toBe('high');
    expect(result!.stock).toBe(1000);
    expect(result!.unitPrice).toBe(3.45);
  });

  it('returns medium confidence when mpn does not match exactly', async () => {
    const client = {
      searchByKeyword: vi.fn().mockResolvedValue([
        {
          digiKeyPartNumber: 'DK-789',
          manufacturerPartNumber: 'DIFFERENT-999',
          manufacturer: 'Some Corp',
          description: 'Generic part',
          quantityAvailable: 500,
          unitPrice: 1.0,
          rohsStatus: 'RoHS Compliant',
        },
      ]),
    };
    const adapter = new DigiKeyAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'MY-MPN' });
    expect(result!.found).toBe(true);
    expect(result!.confidence).toBe('medium');
  });

  it('gracefully handles API errors', async () => {
    const client = {
      searchByKeyword: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const adapter = new DigiKeyAdapter(client as any);
    const result = await adapter.queryPart({ mpn: 'XYZ' });
    expect(result).not.toBeNull();
    expect(result!.found).toBe(false);
    expect(result!.status).toBe('timeout');
    expect(result!.source).toBe('digikey:product-search-api');
    expect(result!.confidence).toBe('low');
  });
});

// ── Failure classification ─────────────────────────────────────────────────

describe('classifySupplierFailure', () => {
  it('classifies rate limits', () => {
    const result = classifySupplierFailure(
      new EasyEdaMcpError({
        code: 'RATE_LIMITED',
        message: 'rate limit exceeded',
        suggestion: 'try later',
        retryable: true,
      }),
    );
    expect(result.status).toBe('rate_limited');
  });

  it('classifies missing credentials as unauthorized without leaking secrets', () => {
    const result = classifySupplierFailure(
      new EasyEdaMcpError({
        code: 'CREDENTIALS_MISSING',
        message: 'apiKey=super-secret-token is missing',
        suggestion: 'configure credentials',
        retryable: false,
      }),
    );
    expect(result.status).toBe('unauthorized');
    expect(result.reason).not.toContain('super-secret-token');
  });

  it('classifies syntax errors as invalid responses', () => {
    const result = classifySupplierFailure(new SyntaxError('Unexpected token in JSON'));
    expect(result.status).toBe('invalid_response');
  });

  it('classifies timeout-like errors', () => {
    const result = classifySupplierFailure(new Error('request timeout after 30000ms'));
    expect(result.status).toBe('timeout');
  });
});

// ── Factory functions ──────────────────────────────────────────────────────

describe('createAdapters / availableAdapters', () => {
  it('creates adapters for all vendor clients', () => {
    const adapters = createAdapters({
      lcsc: {} as any,
      mouser: {} as any,
      digikey: {} as any,
    });
    // Should have lcsc, mouser, digikey
    expect(adapters.lcsc).toBeInstanceOf(LcscAdapter);
    expect(adapters.mouser).toBeInstanceOf(MouserAdapter);
    expect(adapters.digikey).toBeInstanceOf(DigiKeyAdapter);
  });

  it('availableAdapters returns only available (non-null-client) adapters', () => {
    const adapters = createAdapters({
      lcsc: {} as any,
      mouser: null,
      digikey: {} as any,
    });
    // lcsc and digikey have clients; mouser is null
    const available = availableAdapters(adapters);
    expect(available.length).toBe(2);
  });

  it('availableAdapters filters out null-client adapters', () => {
    // Verify all three adapters are created and check availability
    const adapters = createAdapters({
      lcsc: null,
      mouser: null,
      digikey: null,
    });
    expect(adapters.lcsc.isAvailable()).toBe(false);
    expect(adapters.mouser.isAvailable()).toBe(false);
    expect(adapters.digikey.isAvailable()).toBe(false);
    expect(availableAdapters(adapters)).toHaveLength(0);
  });
});

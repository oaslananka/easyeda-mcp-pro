import { describe, it, expect, vi } from 'vitest';
import { ingestDeviceFromLcsc } from '../../../src/catalog/ingest.js';
import { CatalogError } from '../../../src/catalog/errors.js';
import { UNRESOLVED_REF_PREFIX } from '../../../src/catalog/schema.js';
import { type ToolContext } from '../../../src/tools/types.js';

function makeCtx(overrides: {
  lcscDetail?: unknown;
  lcscThrows?: boolean;
  bridgeConnected?: boolean;
  bridgeResult?: unknown;
  bridgeThrows?: boolean;
}): Pick<ToolContext, 'bridge' | 'vendors'> {
  const getPartDetail = vi.fn(async () => {
    if (overrides.lcscThrows) throw new Error('vendor unavailable');
    return overrides.lcscDetail ?? null;
  });
  const call = vi.fn(async () => {
    if (overrides.bridgeThrows) throw new Error('METHOD_NOT_FOUND');
    return overrides.bridgeResult ?? [];
  });

  return {
    bridge: {
      connected: overrides.bridgeConnected ?? true,
      call: call as unknown as ToolContext['bridge']['call'],
    },
    vendors: {
      lcsc:
        overrides.lcscDetail === undefined && !overrides.lcscThrows
          ? null
          : ({ getPartDetail } as any),
      jlcpcb: null,
      mouser: null,
      digikey: null,
    },
  };
}

describe('ingestDeviceFromLcsc', () => {
  it('resolves a device when both the LCSC tier and the EasyEDA library match', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C25804',
        manufacturer: '0603WAF1002T5E',
        description: 'Thick film resistor',
        stock: 1000,
        stockCount: 1000,
        price: '0.001',
        category: 'resistors',
        package: '0603',
        inStock: true,
        classification: 'basic',
      },
      bridgeResult: [
        {
          symbol: { name: 'RES-0603', uuid: 'sym-uuid', libraryUuid: 'lib-uuid' },
          footprint: { name: 'R0603', uuid: 'foot-uuid', libraryUuid: 'lib-uuid' },
          description: 'Resistor 0603',
        },
      ],
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C25804');

    expect(result.status).toBe('resolved');
    expect(result.validation.valid).toBe(true);
    expect(result.provenance).toEqual({
      symbolFootprintSource: 'easyeda-library',
      metadataSource: 'keyless-lcsc',
    });
    expect(result.entry.symbolRef).toBe('SYM:RES-0603');
    expect(result.entry.footprintRef).toBe('FOOT:R0603');
    expect(result.entry.category).toBe('passive');
    expect(result.entry.manufacturer).toBe('0603WAF1002T5E');
    expect(result.entry.lcsc).toBe('C25804');
    expect(
      result.entry.metadata.some((m) => m.key === 'symbolUuid' && m.value === 'sym-uuid'),
    ).toBe(true);
  });

  it('marks symbol/footprint as unresolved when the EasyEDA library has no match', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C111111',
        manufacturer: 'SOME-MCU-1',
        category: 'microcontrollers',
        package: 'QFN-32',
        stock: 10,
        inStock: true,
      },
      bridgeResult: [],
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C111111');

    expect(result.status).toBe('unresolved');
    expect(result.entry.symbolRef).toBe(`${UNRESOLVED_REF_PREFIX}C111111`);
    expect(result.entry.footprintRef).toBe(`${UNRESOLVED_REF_PREFIX}C111111`);
    // microcontroller category requires symbol/footprint/pin map — all three should fail.
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_SYMBOL')).toBe(true);
    expect(result.validation.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_FOOTPRINT')).toBe(
      true,
    );
    expect(result.validation.errors.some((e) => e.code === 'DEVICE_MISSING_PIN_MAP')).toBe(true);
  });

  it('returns partial status when the EasyEDA library matches but validation still fails', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C222222',
        manufacturer: 'SOME-MCU-2',
        category: 'microcontrollers',
        package: 'QFN-32',
        stock: 10,
        inStock: true,
      },
      bridgeResult: [
        {
          symbol: { name: 'MCU-SYM', uuid: 'sym-uuid' },
          footprint: { name: 'QFN32', uuid: 'foot-uuid' },
        },
      ],
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C222222');

    // Symbol/footprint resolved, but pin map is still empty (no data source for it) —
    // microcontroller requires a pin map, so validation fails despite the library match.
    expect(result.status).toBe('partial');
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => e.code === 'DEVICE_MISSING_PIN_MAP')).toBe(true);
    expect(result.validation.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_SYMBOL')).toBe(false);
  });

  it('degrades gracefully when the bridge is disconnected', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C333333',
        manufacturer: 'GENERIC-PART',
        category: 'capacitors',
        package: '0402',
        stock: 5,
        inStock: true,
      },
      bridgeConnected: false,
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C333333');
    expect(result.status).toBe('unresolved');
    expect(result.provenance.symbolFootprintSource).toBe('unresolved');
  });

  it('degrades gracefully when the bridge call throws (method unsupported/restricted)', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C444444',
        manufacturer: 'GENERIC-PART-2',
        category: 'capacitors',
        package: '0402',
        stock: 5,
        inStock: true,
      },
      bridgeThrows: true,
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C444444');
    expect(result.status).toBe('unresolved');
    expect(result.provenance.symbolFootprintSource).toBe('unresolved');
  });

  it('degrades gracefully when the keyless LCSC tier is unavailable but the EasyEDA library matches', async () => {
    const ctx = makeCtx({
      lcscThrows: true,
      bridgeResult: [{ symbol: { name: 'SYM-X' }, footprint: { name: 'FOOT-X' } }],
    });

    const result = await ingestDeviceFromLcsc(ctx, 'C555555');
    expect(result.provenance.metadataSource).toBe('unavailable');
    // manufacturer/mpn fall back to the normalized LCSC id when no vendor metadata is available.
    expect(result.entry.mpn).toBe('C555555');
    expect(result.entry.manufacturer).toBe('C555555');
    expect(result.entry.symbolRef).toBe('SYM:SYM-X');
  });

  it('throws DEVICE_RESOLUTION_FAILED when neither source resolves anything', async () => {
    const ctx = makeCtx({ bridgeConnected: false });

    await expect(ingestDeviceFromLcsc(ctx, 'C999999')).rejects.toMatchObject({
      code: 'DEVICE_RESOLUTION_FAILED',
    });
    await expect(ingestDeviceFromLcsc(ctx, 'C999999')).rejects.toBeInstanceOf(CatalogError);
  });

  it('normalizes an LCSC id without a leading C', async () => {
    const ctx = makeCtx({
      lcscDetail: {
        lcsc: 'C25804',
        manufacturer: 'SOME-RES',
        category: 'resistors',
        package: '0603',
        stock: 10,
        inStock: true,
      },
    });

    const result = await ingestDeviceFromLcsc(ctx, '25804');
    expect(result.entry.lcsc).toBe('C25804');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { verifyWireInventoryReadback } from '../src/schematic-wire-inventory.js';

const wire = (id: string, x = 0) => ({ primitiveId: id, line: [x, 0, x + 10, 0], net: '' });
const deps = (
  items: unknown[] = [wire('old')],
  ids: unknown[] = ['old'],
  overrides: Record<string, unknown> = {},
) => ({
  getAll: vi.fn(async () => items),
  getAllPrimitiveId: vi.fn(async () => ids),
  ...overrides,
});

const verify = (api: ReturnType<typeof deps>, first: unknown[], wait = vi.fn(async () => {})) =>
  verifyWireInventoryReadback({
    wireApi: api,
    firstWires: first,
    extractPrimitiveId: (w) => (w as { primitiveId: string }).primitiveId,
    readState: (w, key) => (w as Record<string, unknown>)[key.toLowerCase()],
    settle: wait,
  });

describe('bounded production wire inventory verification (#945)', () => {
  it('accepts independently matching IDs and geometry after two reads', async () => {
    const api = deps();
    const wait = vi.fn(async () => {});
    await expect(verify(api, [wire('old')], wait)).resolves.toEqual([wire('old')]);
    expect(api.getAll).toHaveBeenCalledOnce();
    expect(api.getAllPrimitiveId).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('rejects a stale getAll batch when IDs already include a GUI-created wire', async () => {
    await expect(verify(deps([], ['new']), [])).rejects.toThrow(/mismatch/i);
  });

  it('rejects a newly appearing GUI wire between bounded reads', async () => {
    const api = deps([wire('old'), wire('gui-new')], ['old', 'gui-new'], {
      getAllPrimitiveId: vi
        .fn()
        .mockResolvedValueOnce(['old'])
        .mockResolvedValueOnce(['old', 'gui-new']),
    });
    await expect(verify(api, [wire('old')])).rejects.toThrow(/changed|mismatch/i);
  });

  it('rejects a GUI wire moved in between snapshot reads even if its ID is unchanged', async () => {
    const api = deps([wire('old', 10)], ['old']);
    await expect(verify(api, [wire('old', 0)])).rejects.toThrow(/changed/i);
  });

  it('fails closed when the full primitive-ID API is unavailable', async () => {
    const api = deps([wire('old')], ['old'], { getAllPrimitiveId: undefined });
    await expect(verify(api, [wire('old')])).rejects.toThrow(/unavailable/i);
  });

  it('fails closed if a getter throws instead of treating a missing wire as safe', async () => {
    const api = deps([wire('old')], ['old'], {
      getAllPrimitiveId: vi.fn().mockRejectedValue(new Error('GUI cache stale')),
    });
    await expect(verify(api, [wire('old')])).rejects.toThrow(/GUI cache stale/);
  });

  it('fails closed for duplicate IDs or missing geometry', async () => {
    await expect(
      verify(deps([wire('same'), wire('same')], ['same', 'same']), [wire('same'), wire('same')]),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      verify(deps([{ primitiveId: 'bad' }], ['bad']), [{ primitiveId: 'bad' }]),
    ).rejects.toThrow(/geometry/i);
  });
});

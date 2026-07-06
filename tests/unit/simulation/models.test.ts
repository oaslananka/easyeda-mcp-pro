import { describe, expect, it } from 'vitest';
import { DIODE_MODELS, getDiodeModel, listDiodeModels } from '../../../src/simulation/models.js';

describe('diode/LED model library', () => {
  it('lists every registered model with source and caveat text', () => {
    const models = listDiodeModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    for (const model of models) {
      expect(model.source.length).toBeGreaterThan(0);
      expect(model.caveat.length).toBeGreaterThan(0);
      expect(Object.keys(model.params).length).toBeGreaterThan(0);
    }
  });

  it('resolves the generic LED model by name', () => {
    const led = getDiodeModel('generic-led-red');
    expect(led.name).toBe('generic-led-red');
    expect(led.params.IS).toBeDefined();
  });

  it('resolves the generic silicon switching diode model by name', () => {
    const diode = getDiodeModel('generic-silicon-switching');
    expect(diode.params.RS).toBe(0.568);
  });

  it('throws a helpful error for an unknown model name', () => {
    expect(() => getDiodeModel('does-not-exist')).toThrow(/Unknown diode\/LED model/);
    expect(() => getDiodeModel('does-not-exist')).toThrow(/generic-silicon-switching/);
  });

  it("keeps the DIODE_MODELS registry keyed by each entry's own name", () => {
    for (const [key, entry] of Object.entries(DIODE_MODELS)) {
      expect(entry.name).toBe(key);
    }
  });
});

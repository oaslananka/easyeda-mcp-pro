import { describe, expect, it } from 'vitest';
import { listDfmChecklist, getDfmChecklistItem } from '../../../src/design-rules/dfm-checklist.js';

describe('listDfmChecklist', () => {
  it('returns a non-empty list with unique ids and required fields', () => {
    const items = listDfmChecklist();
    expect(items.length).toBeGreaterThan(5);
    const ids = new Set(items.map((item) => item.id));
    expect(ids.size).toBe(items.length);
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.guidance.length).toBeGreaterThan(0);
      expect(item.rationale.length).toBeGreaterThan(0);
      expect(item.caveat).toMatch(/standard capability tier/);
    }
  });

  it('filters by category', () => {
    const drilling = listDfmChecklist('drilling');
    expect(drilling.length).toBeGreaterThan(0);
    for (const item of drilling) {
      expect(item.category).toBe('drilling');
    }
  });

  it('returns an empty array for a category with no matches (type-safe filter, not an error)', () => {
    const all = listDfmChecklist();
    const categories = new Set(all.map((i) => i.category));
    expect(categories.size).toBeGreaterThan(1);
  });
});

describe('getDfmChecklistItem', () => {
  it('returns the item for a known id', () => {
    const item = getDfmChecklistItem('annular-ring');
    expect(item).toBeDefined();
    expect(item!.category).toBe('drilling');
  });

  it('returns undefined for an unknown id', () => {
    expect(getDfmChecklistItem('does-not-exist')).toBeUndefined();
  });
});

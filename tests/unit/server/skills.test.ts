import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILL_NAMES, loadBundledSkills } from '../../../src/server/skills.js';

describe('packaged Skills over MCP', () => {
  it('loads only the audited canonical skills with stable metadata', async () => {
    const catalog = await loadBundledSkills();
    expect(BUNDLED_SKILL_NAMES).toEqual(['design-validation', 'easyeda-component-review']);
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.map((skill) => skill.frontmatter.name).sort()).toEqual(
      BUNDLED_SKILL_NAMES,
    );
    expect(catalog.entries.every((skill) => skill.uri.startsWith('skill://'))).toBe(true);
  });

  it('does not expose unrelated skills', async () => {
    const catalog = await loadBundledSkills();
    expect(JSON.stringify(catalog.entries)).not.toContain('easyeda-professional-layout');
    expect(JSON.stringify(catalog.entries)).not.toContain('component-search');
  });
});

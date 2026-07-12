import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const distributions = [
  'skills/easyeda-professional-layout/SKILL.md',
  '.agents/skills/easyeda-professional-layout/SKILL.md',
  '.claude/skills/easyeda-professional-layout/SKILL.md',
  '.codex/skills/easyeda-professional-layout/SKILL.md',
];
const policyIds = [
  'PAGE_GEOMETRY_REQUIRED',
  'TITLE_BLOCK_KEEP_OUT',
  'RENDERED_BOUNDS_ONLY',
  'NO_BLIND_RETRY',
  'STAGED_PREVIEW_READBACK_QA',
  'CONNECTIVITY_FINGERPRINT_REQUIRED',
  'NO_SAVE_WITH_CRITICALS',
];

describe('professional layout skill distributions', () => {
  it.each(distributions)('%s contains the equivalent safety contract', (relativePath) => {
    const content = readFileSync(resolve(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
    expect(content).toMatch(/^---\nname: easyeda-professional-layout\n/);
    for (const policyId of policyIds) expect(content).toContain(policyId);
    for (const numericDefault of ['100 mil', '150 mil', '50 mil', '25 mil', '75 mil']) {
      expect(content).toContain(numericDefault);
    }
    expect(content.toLowerCase()).toMatch(/geometry/);
    expect(content.toLowerCase()).toMatch(/readback/);
    expect(content.toLowerCase()).toMatch(/fingerprint/);
  });

  it('publishes Codex UI metadata with an explicit skill invocation', () => {
    const metadata = readFileSync(
      resolve(ROOT, 'skills/easyeda-professional-layout/agents/openai.yaml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(metadata).toContain("display_name: 'EasyEDA Professional Layout'");
    expect(metadata).toContain('$easyeda-professional-layout');
  });
});

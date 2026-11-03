import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { BUNDLED_SKILL_NAMES, loadBundledSkills } from '../../../src/server/skills.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const router = 'skills/design-validation/references/engineering-review.md';
const tick = String.fromCharCode(96);
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const canonical = read(router);
const phases = [
  'Requirements',
  'Component/datasheet',
  'Schematic/ERC',
  'Power/placement',
  'Routing/DRC',
  'DFM/DFT and insulation',
  'Documented review',
];

describe('canonical on-demand engineering skill routing', () => {
  it('routes seven phases through existing audited MCP skills', async () => {
    expect(BUNDLED_SKILL_NAMES).toEqual(['design-validation', 'easyeda-component-review']);
    expect((await loadBundledSkills()).entries).toHaveLength(2);
    expect(canonical).toContain('**on-demand**');
    phases.forEach((phase, index) => {
      expect(
        canonical
          .split('\n')
          .some(
            (line) =>
              line.startsWith('| ') && line.split('|')[1]?.trim() === index + 1 + '. ' + phase,
          ),
      ).toBe(true);
    });
    expect(canonical).toMatch(/Select only the phases relevant/);
  });

  it('uses only registered MCP tools and real lookup topics', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    const pattern = new RegExp(tick + '(easyeda_[a-z0-9_]+)' + tick, 'g');
    const names = [...canonical.matchAll(pattern)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of new Set(names)) {
      expect(registry.get(name), name + ' not registered').toBeDefined();
    }
    const lookup = registry.get('easyeda_design_rules_lookup');
    expect(lookup).toBeDefined();
    for (const topic of [
      'trace-current-review',
      'protocol-routing',
      'decoupling',
      'bulk-capacitance',
      'clearance',
      'isolation-emc-review',
      'dfm-checklist',
    ]) {
      expect(canonical).toContain(tick + topic + tick);
      const input: Record<string, unknown> = { topic };
      if (topic === 'isolation-emc-review') input.review = {};
      if (topic === 'clearance') Object.assign(input, { voltageV: 12, location: 'external' });
      if (topic === 'bulk-capacitance') input.loadA = 1;
      if (topic === 'trace-current-review') input.currentA = 1;
      expect(lookup!.inputSchema.safeParse(input).success, topic).toBe(true);
    }
  });

  it.each([
    ['exact voltage', 'Schematic/ERC', 'easyeda_semantic_erc_validate', 'datasheetConstraints'],
    ['coarse native DRC', 'Routing/DRC', 'easyeda_drc_run', 'aggregate'],
    ['trace current', 'Routing/DRC', 'easyeda_design_rules_lookup', 'trace-current-review'],
    [
      'insulation ESD',
      'DFM/DFT and insulation',
      'easyeda_design_rules_lookup',
      'isolation-emc-review',
    ],
    [
      'manufacturer profile',
      'DFM/DFT and insulation',
      'easyeda_pcb_production_review',
      'manufacturerProfile',
    ],
    ['focused tab', 'Requirements', 'easyeda_bridge_status', 'focused document'],
    ['human signoff', 'Documented review', 'easyeda_engineering_review', 'human engineer'],
  ])('routes %s to the documented phase', (_case, phase, tool, evidence) => {
    const row = canonical
      .split('\n')
      .find((line) => line.startsWith('| ') && line.split('|')[1]?.trim().endsWith(phase));
    expect(row, 'missing ' + phase).toBeDefined();
    expect(row).toContain(tick + tool + tick);
    expect(canonical).toContain(evidence);
  });

  it('separates enforced gates from advice, evidence and unknowns', () => {
    for (const term of [
      '**Enforced by current MCP tool contracts:**',
      '**Advisory skill guidance, not independently enforced:**',
      'UNKNOWN',
      'WARNING',
      'No native confirmation',
      'readback',
      'user write approval',
      'remote approval',
      'surface creepage',
      'through-air',
      'not authenticated',
    ])
      expect(canonical.toLowerCase()).toContain(term.toLowerCase());
    expect(canonical).toContain('stays unapproved');
  });

  it('keeps OpenCode full skill mirrors exactly equal to canonical skills', () => {
    for (const name of ['design-validation', 'easyeda-workflow']) {
      expect(read('.opencode/skills/' + name + '/SKILL.md')).toBe(
        read('skills/' + name + '/SKILL.md'),
      );
      expect(read('skills/' + name + '/SKILL.md')).toContain('references/engineering-review.md');
    }
    expect(read('skills/easyeda-workflow/SKILL.md')).toContain('A timeout is not proof of failure');
    expect(read('skills/easyeda-workflow/SKILL.md')).toContain('check_collisions');
  });

  it('keeps existing runtime wrappers and their write authorization gates', () => {
    for (const name of ['easyeda-component-review', 'easyeda-professional-layout'])
      expect(read('skills/' + name + '/SKILL.md')).toContain(router);
    for (const runtime of ['.agents', '.claude', '.codex', '.opencode']) {
      const wrapper = read(runtime + '/skills/easyeda-component-review/SKILL.md');
      expect(wrapper).toContain('skills/easyeda-component-review/SKILL.md');
      expect(wrapper).toContain(router);
      expect(wrapper).toContain('write authorization');
    }
    for (const runtime of ['.agents', '.claude', '.codex']) {
      const wrapper = read(runtime + '/skills/easyeda-professional-layout/SKILL.md');
      for (const id of [
        'PAGE_GEOMETRY_REQUIRED',
        'TITLE_BLOCK_KEEP_OUT',
        'NO_BLIND_RETRY',
        'CONNECTIVITY_FINGERPRINT_REQUIRED',
        'NO_SAVE_WITH_CRITICALS',
      ])
        expect(wrapper).toContain(id);
      expect(wrapper).toContain(router);
    }
    expect(read('skills/easyeda-component-review/SKILL.md')).toContain('Personal Device approval');
  });

  it('links only to existing, source-specific engineering contracts', () => {
    for (const path of [
      'docs/datasheet-electrical-review.md',
      'docs/isolation-emc-evidence-review.md',
      'docs/manufacturer-process-profile-review.md',
      'docs/professional-schematic-layout.md',
      'skills/easyeda-component-review/references/review-process.md',
    ]) {
      expect(canonical).toContain(tick + path + tick);
      expect(read(path).length).toBeGreaterThan(100);
    }
    expect(read('README.md')).toContain(router);
    expect(read('docs/agent-runtime-config.md')).toContain(router);
  });
});

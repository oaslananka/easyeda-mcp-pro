import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ISSUE_FORMS = ['bug_report.yml', 'feature_request.yml'] as const;
const RESERVED_DROPDOWN_OPTIONS = new Set(['none', 'n/a']);

function readIssueTemplate(name: string): string {
  return readFileSync(resolve('.github', 'ISSUE_TEMPLATE', name), 'utf8');
}

describe('GitHub issue forms', () => {
  it.each(ISSUE_FORMS)('%s starts as an issue form, not Markdown frontmatter', (name) => {
    const source = readIssueTemplate(name);
    expect(source.trimStart().startsWith('---')).toBe(false);
    expect(source.trimStart().startsWith('name:')).toBe(true);
    expect(source).toMatch(/^description:/m);
    expect(source).toMatch(/^body:/m);
  });

  it.each(ISSUE_FORMS)('%s does not use reserved dropdown option values', (name) => {
    const source = readIssueTemplate(name);
    const optionValues = [...source.matchAll(/^\s+-\s+([^:][^\n]*)$/gm)].map((match) =>
      match[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase(),
    );
    for (const value of optionValues) {
      expect(RESERVED_DROPDOWN_OPTIONS.has(value ?? '')).toBe(false);
    }
  });
});

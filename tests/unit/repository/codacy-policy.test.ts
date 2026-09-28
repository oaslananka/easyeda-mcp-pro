import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readConfig = (): string =>
  readFileSync(resolve('.codacy.yml'), 'utf8').replace(/\r\n/g, '\n');

describe('Codacy repository policy', () => {
  it('keeps generated and packaged artifacts out of analysis', () => {
    const config = readConfig();
    expect(config.startsWith('---\n')).toBe(true);
    for (const path of [
      'node_modules/**',
      'dist/**',
      'easyeda-bridge-extension/dist/**',
      'coverage/**',
      'easyeda-bridge-extension/coverage/**',
      'docs/.vitepress/**',
      'artifacts/**',
      '**/*.eext',
      '**/*.tgz',
    ]) {
      expect(config).toContain("'" + path + "'");
    }
  });

  it('does not globally exclude source or test trees', () => {
    const config = readConfig();
    expect(config).not.toContain("'src/**'");
    expect(config).not.toContain("'tests/**'");
    expect(config).not.toContain("'easyeda-bridge-extension/src/**'");
    expect(config).not.toContain("'easyeda-bridge-extension/tests/**'");
  });
});

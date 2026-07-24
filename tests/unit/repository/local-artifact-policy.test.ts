import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('local repository artifact policy', () => {
  it('excludes project-local pnpm stores from Git and repository-wide formatting', () => {
    for (const path of ['.gitignore', '.prettierignore']) {
      const entries = read(path)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(entries).toContain('.pnpm-store/');
    }
  });
});

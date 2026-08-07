import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), 'utf8');
}

async function markdownFiles(root: string): Promise<string[]> {
  const directory = resolve(repoRoot, root);
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => resolve(directory, entry))
    .filter((path) => !path.includes('/.vitepress/dist/'));
}

describe('documentation lifecycle policy', () => {
  it('keeps temporary implementation plans out of durable public docs', async () => {
    const plansRoot = resolve(repoRoot, 'docs/superpowers/plans');
    const entries = await readdir(plansRoot, { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      },
    );

    expect(entries).toEqual([]);
  });

  it('documents where durable decisions, evidence, and temporary plans belong', async () => {
    const contributing = await read('CONTRIBUTING.md');

    expect(contributing).toContain('Documentation lifecycle');
    expect(contributing).toContain('temporary implementation plans');
    expect(contributing).toContain('existing canonical documentation');
    expect(contributing).toContain('docs/evidence/');
    expect(contributing).toContain('issue or pull request');
  });

  it('leaves no canonical documentation links to removed working plans', async () => {
    const files = [
      resolve(repoRoot, 'README.md'),
      resolve(repoRoot, 'CONTRIBUTING.md'),
      resolve(repoRoot, 'SECURITY.md'),
      ...(await markdownFiles('docs')),
    ];
    const references: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      if (/superpowers\/plans\/20\d{2}-\d{2}-\d{2}-/.test(content)) references.push(file);
    }

    expect(references).toEqual([]);
  });

  it('does not publish superpowers working artifacts through VitePress', async () => {
    const vitepress = await read('docs/.vitepress/config.ts');

    expect(vitepress).toContain("srcExclude: ['superpowers/**']");
    expect(vitepress).not.toContain("link: '/superpowers/");
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('npm CLI binary metadata', () => {
  it('declares a Node shebang for Windows npx execution', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    const source = await readFile(join(process.cwd(), 'src', 'index.ts'), 'utf8');

    expect(packageJson.bin).toEqual({ 'easyeda-mcp-pro': 'dist/index.js' });
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

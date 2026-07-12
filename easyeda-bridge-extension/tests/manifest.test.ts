import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('extension manifest activation', () => {
  it('loads the bridge entry at EasyEDA startup so auto-connect can run without a menu click', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'extension.json'), 'utf8')) as {
      activationEvents?: { onStartupFinished?: boolean };
    };

    expect(manifest.activationEvents?.onStartupFinished).toBe(true);
  });
});

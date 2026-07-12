import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('EasyEDA WebSocket lifecycle', () => {
  it('never fires the open hook from a timer before the real connected callback', () => {
    const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

    expect(source).toContain('sysWs.register(');
    expect(source).toContain('fireOpen,');
    expect(source).not.toContain('setTimeout(fireOpen');
    expect(source).not.toContain('EASYEDA_REGISTER_OPEN_FALLBACK_MS');
  });
});

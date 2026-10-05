import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

async function read(relativePath: string) {
  return readFile(resolve(ROOT, relativePath), 'utf8');
}

describe('hierarchical agent instructions', () => {
  it('declares root scope and nested boundaries', async () => {
    const root = await read('AGENTS.md');

    expect(root).toContain('## Scope and precedence');
    expect(root).toContain('pnpm verify:fast');
    expect(root).toContain('pnpm verify');
    expect(root).toContain('explicit user approval');
    expect(root).toContain('`skills/` is the canonical repository source');

    for (const path of [
      'src/tools/AGENTS.md',
      'src/remote/AGENTS.md',
      'easyeda-bridge-extension/AGENTS.md',
      '.github/AGENTS.md',
    ]) {
      expect(root).toContain(`\`${path}\``);
      await expect(read(path)).resolves.toBeTruthy();
    }
  });

  it('protects tool authorization metadata', async () => {
    const tools = await read('src/tools/AGENTS.md');

    for (const marker of [
      'Tool metadata is not decorative',
      '`sideEffect`',
      '`confirmWrite`',
      'Remote relay risk derives from this metadata',
      'Read back project state before retrying',
    ]) {
      expect(tools).toContain(marker);
    }
  });

  it('protects remote approval and replay invariants', async () => {
    const remote = await read('src/remote/AGENTS.md');

    for (const marker of [
      'untrusted-network boundary',
      'user identity',
      'extension session',
      'canonical input hash',
      'replay after consumption',
      'fail closed',
    ]) {
      expect(remote).toContain(marker);
    }
  });

  it('protects extension transport and mutation boundaries', async () => {
    const extension = await read('easyeda-bridge-extension/AGENTS.md');

    for (const marker of [
      '`src/index.ts`',
      'Local `ws://` connectivity',
      'Do not broaden local `ws://`',
      'outcome unknown until read back',
      'pnpm verify:extension',
    ]) {
      expect(extension).toContain(marker);
    }
  });

  it('protects CI and supply-chain assurance', async () => {
    const github = await read('.github/AGENTS.md');

    for (const marker of [
      '`quality (24)`',
      'least-privilege',
      'SHA-pinned',
      'Codecov upload telemetry is',
      'SBOM generation and retention',
      'stable MCP Registry promotion rules',
    ]) {
      expect(github).toContain(marker);
    }
  });
});

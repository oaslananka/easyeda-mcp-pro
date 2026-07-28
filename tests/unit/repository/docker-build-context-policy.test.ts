import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

function activeDockerignorePatterns(): string[] {
  return read('.dockerignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('Docker build-context policy', () => {
  it('uses a default-deny allowlist with explicit local-state exclusions', () => {
    const patterns = activeDockerignorePatterns();

    expect(patterns[0]).toBe('**');
    for (const required of [
      '!Dockerfile',
      '!.dockerignore',
      '!package.json',
      '!pnpm-lock.yaml',
      '!pnpm-workspace.yaml',
      '!tsconfig.json',
      '!tsconfig.build.json',
      '!config/runtime-policy.json',
      'config/**',
      '!scripts/check-runtime.mjs',
      '!scripts/clean.mjs',
      '!scripts/sync-versions.mjs',
      'scripts/**',
      '!src/**',
      'easyeda-bridge-extension/**',
      '!easyeda-bridge-extension/package.json',
      '!easyeda-bridge-extension/tsconfig.json',
      '!easyeda-bridge-extension/extension.json',
      '!easyeda-bridge-extension/README.md',
      '!easyeda-bridge-extension/CHANGELOG.md',
      '!easyeda-bridge-extension/images/**',
      '!easyeda-bridge-extension/src/**',
      '!easyeda-bridge-extension/scripts/build.mjs',
      '!easyeda-bridge-extension/scripts/package.mjs',
      '!easyeda-bridge-extension/scripts/archive.mjs',
      '!easyeda-bridge-extension/scripts/checksums.mjs',
      '!easyeda-bridge-extension/scripts/reproducible-time.mjs',
      'easyeda-bridge-extension/scripts/**',
      '**/.git',
      '**/.git/**',
      '**/node_modules',
      '**/node_modules/**',
      '**/.pnpm-store',
      '**/.pnpm-store/**',
      '**/coverage',
      '**/coverage/**',
      '**/reports',
      '**/reports/**',
      '**/.easyeda-mcp-pro',
      '**/.easyeda-mcp-pro/**',
      '**/dist',
      '**/dist/**',
      '**/*.log',
      '**/*.tmp',
      '**/*.temp',
      '**/*.tgz',
      '**/*.tar',
      '**/*.tar.gz',
      '**/*.zip',
      '**/*.eext',
      '**/.env',
      '**/.env.*',
      '!.env.example',
    ]) {
      expect(patterns, `missing Docker context policy pattern: ${required}`).toContain(required);
    }

    expect(patterns).not.toContain('!scripts/**');
    expect(patterns).not.toContain('!easyeda-bridge-extension/**');
    expect(patterns.at(-1)).toBe('!.env.example');
  });

  it('copies runtime artifacts only from the builder stage', () => {
    const dockerfile = read('Dockerfile');
    const localCopyLines = dockerfile
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('COPY ') && !line.includes('--from='));

    expect(dockerfile).not.toMatch(/^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*\.\s+/m);
    expect(localCopyLines.join('\n')).not.toMatch(
      /(?:^|\s)(?:dist|node_modules|coverage|reports|\.easyeda-mcp-pro)(?:\/|\s|$)|\.(?:eext|zip|tgz)(?:\s|$)/,
    );
    expect(dockerfile).toContain('COPY --from=builder --chown=node:node /app/dist ./dist');
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=node:node /app/easyeda-bridge-extension.eext ./easyeda-bridge-extension.eext',
    );
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=node:node /app/easyeda-bridge-extension.checksums.json ./easyeda-bridge-extension.checksums.json',
    );
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=node:node /app/node_modules ./node_modules',
    );
  });
});

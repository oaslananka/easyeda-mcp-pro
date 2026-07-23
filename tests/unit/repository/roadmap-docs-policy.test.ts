import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string =>
  readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('repository roadmap and CDP documentation policy', () => {
  it('publishes a current, safety-scoped CDP bridge guide', () => {
    const path = 'docs/guide/cdp-bridge.md';
    expect(existsSync(resolve(repoRoot, path))).toBe(true);
    const guide = read(path);

    expect(guide).toContain('EASYEDA_BRIDGE=cdp');
    expect(guide).toContain('EASYEDA_CDP_URL=http://127.0.0.1:9222');
    expect(guide).toContain('EASYEDA_CDP_ALLOW_WRITES=true');
    expect(guide).toContain('EASYEDA_CDP_ALLOW_UNMAPPED_WRITES=true');
    expect(guide).toMatch(/loopback/i);
    expect(guide).toMatch(/bridge extension.*recommended/i);
    expect(guide).toMatch(/disposable/i);
    expect(guide).not.toContain('First-pass mapped calls');
    expect(guide).not.toContain('Deliberately blocked until mapped');
  });

  it('documents active milestone and branch lifecycle conventions', () => {
    const path = 'docs/ROADMAP.md';
    expect(existsSync(resolve(repoRoot, path))).toBe(true);
    const roadmap = read(path);

    expect(roadmap).toContain('v0.37.0 — Maintainability and operational consistency');
    expect(roadmap).toContain(
      'v1.0 readiness — Governance, release quality, and ecosystem confidence',
    );
    expect(roadmap).toContain('`v<target> — <outcome>`');
    expect(roadmap).toMatch(/close.*milestone.*shipped/i);
    expect(roadmap).toContain('release-please--branches--main--components--easyeda-mcp-pro');
    expect(roadmap).toMatch(/active release pull request/i);
  });

  it('links both guides from public navigation and the README', () => {
    const vitepress = read('docs/.vitepress/config.ts');
    const readme = read('README.md');

    expect(vitepress).toContain("link: '/guide/cdp-bridge'");
    expect(vitepress).toContain("link: '/ROADMAP'");
    expect(readme).toContain('docs/guide/cdp-bridge.md');
    expect(readme).toContain('docs/ROADMAP.md');
  });
});

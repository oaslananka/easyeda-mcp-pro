import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n') : '';
};

describe('Mergify repository policy', () => {
  it('uses a conservative in-place merge queue without automatic merging', () => {
    const mergify = readText('.mergify.yml');

    expect(mergify).toContain('merge_queue:');
    expect(mergify).toContain('mode: serial');
    expect(mergify).toContain('max_parallel_checks: 1');
    expect(mergify).toContain('status_comments: outcomes');
    expect(mergify).toContain('queue_controls_comment: true');
    expect(mergify).toContain('queue_rules:');
    expect(mergify).toContain('batch_size: 1');
    expect(mergify).toContain('merge_method: squash');
    expect(mergify).toContain('update_method: merge');
    expect(mergify).toContain('base = main');
    expect(mergify).toContain('-draft');
    expect(mergify).toContain('-conflict');

    expect(mergify).not.toMatch(/^\s+merge_conditions:/m);
    expect(mergify).not.toMatch(/^\s+autoqueue:/m);
    expect(mergify).not.toMatch(/^\s+allow_inplace_checks:/m);
    expect(mergify).not.toMatch(/^\s+max_checks_retries:\s*[1-9]/m);
    expect(mergify).not.toMatch(/^\s+auto_merge_conditions:/m);
  });

  it('reports merge protections as a check without auto-merge', () => {
    const mergify = readText('.mergify.yml');

    expect(mergify).toContain('merge_protections_settings:');
    expect(mergify).toContain('reporting_method: check-runs');
    expect(mergify).toContain('post_comment: false');
    expect(mergify).toContain('merge_protections:');
    expect(mergify).toContain('name: Main pull request readiness');
    expect(mergify).not.toMatch(/^pull_request_rules:/m);
  });

  it('treats the Mergify configuration as critical automation', () => {
    const policy = JSON.parse(readText('config/repository-governance.json')) as {
      criticalPaths: Record<string, string[]>;
    };
    const codeowners = readText('.github/CODEOWNERS');

    expect(Object.values(policy.criticalPaths).flat()).toContain('/.mergify.yml');
    expect(codeowners).toContain('/.mergify.yml @oaslananka');
  });
});

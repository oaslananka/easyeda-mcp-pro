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

interface GovernancePolicy {
  schemaVersion: number;
  owners: string[];
  criticalPaths: Record<string, string[]>;
  branchProtection: {
    requiredChecks: string[];
    strictStatusChecks: boolean;
    requiredApprovals: number;
    requireCodeOwnerReviews: boolean;
    dismissStaleReviews: boolean;
    requireLastPushApproval: boolean;
    requireConversationResolution: boolean;
    enforceAdmins: boolean;
    requireLinearHistory: boolean;
    allowForcePushes: boolean;
    allowDeletions: boolean;
  };
  reviewPolicy: {
    independentReview: string;
    soloMaintainerLimitation: string;
    automatedFindingDisposition: string;
    emergencyException: string;
  };
}

const readPolicy = (): GovernancePolicy =>
  JSON.parse(readText('config/repository-governance.json')) as GovernancePolicy;

describe('repository governance policy', () => {
  it('maps every critical path to an explicit CODEOWNER', () => {
    const policy = readPolicy();
    const codeowners = readText('.github/CODEOWNERS');

    expect(policy.schemaVersion).toBe(1);
    expect(policy.owners).toEqual(['@oaslananka']);

    for (const paths of Object.values(policy.criticalPaths)) {
      for (const path of paths) {
        expect(codeowners).toContain(`${path} @oaslananka`);
      }
    }
  });

  it('records the enforceable main-branch protection baseline', () => {
    const policy = readPolicy();

    expect(policy.branchProtection).toEqual({
      requiredChecks: [
        'quality (24)',
        'codeql',
        'Socket Security: Project Report',
        'dependency-review',
      ],
      strictStatusChecks: true,
      requiredApprovals: 0,
      requireCodeOwnerReviews: false,
      dismissStaleReviews: false,
      requireLastPushApproval: false,
      requireConversationResolution: true,
      enforceAdmins: true,
      requireLinearHistory: true,
      allowForcePushes: false,
      allowDeletions: false,
    });
  });

  it('documents independent review, automated findings, and emergency exceptions', () => {
    const policy = readPolicy();
    const governance = readText('docs/REPOSITORY_GOVERNANCE.md');
    const contributing = readText('CONTRIBUTING.md');
    const security = readText('SECURITY.md');
    const pullRequestTemplate = readText('.github/pull_request_template.md');

    expect(policy.reviewPolicy.independentReview).toBe('required-when-eligible-reviewer-exists');
    expect(policy.reviewPolicy.soloMaintainerLimitation).toBe('publicly-documented');
    expect(policy.reviewPolicy.automatedFindingDisposition).toBe(
      'resolve-or-explicitly-disposition',
    );
    expect(policy.reviewPolicy.emergencyException).toBe('public-rationale-and-follow-up-review');

    expect(governance).toContain('Critical-path ownership');
    expect(governance).toContain('Independent human review');
    expect(governance).toContain('solo-maintainer enforcement limitation');
    expect(governance).toContain('Bot and agent findings');
    expect(governance).toContain('Emergency exception');
    expect(governance).toContain('public rationale');
    expect(governance).toContain('two business days');
    expect(governance).toContain('No repository ruleset currently overlaps');

    expect(contributing).toContain('[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)');
    expect(security).toContain('[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)');
    expect(pullRequestTemplate).toContain('## Critical-path review');
    expect(pullRequestTemplate).toContain('## Automated review disposition');
    expect(pullRequestTemplate).toContain('Emergency exception evidence');
  });
});

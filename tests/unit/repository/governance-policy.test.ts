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
  liveStateVerifiedAt: string;
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
  repositoryRulesets: {
    active: boolean;
    authority: string;
    name: string;
    target: string;
    include: string[];
    bypassActors: unknown[];
  };
  reviewPolicy: {
    independentReview: string;
    soloMaintainerLimitation: string;
    automatedFindingDisposition: string;
    emergencyException: string;
    activation: {
      trigger: string;
      accountableOwner: string;
      deadlineBusinessDays: number;
      targetBranchProtection: {
        requiredApprovals: number;
        requireCodeOwnerReviews: boolean;
        dismissStaleReviews: boolean;
        requireLastPushApproval: boolean;
      };
      verification: string[];
    };
  };
  continuity: {
    operatingModel: string;
    currentBusFactor: number;
    minimumMaintainersForIndependentReview: number;
    successorStatus: string;
    humanApprovalRequired: boolean;
    confidentialRecoveryRecord: {
      required: boolean;
      storage: string;
      plaintextSecretsInRepository: boolean;
    };
    recovery: {
      runbook: string;
      exerciseEvidence: string;
      branchProtectionEvidence: string;
      reviewCadenceDays: number;
      lastExerciseAt: string;
      exerciseStatus: string;
    };
    requiredSuccessorEvidence: string[];
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

    expect(policy.liveStateVerifiedAt).toBe('2026-08-10');
    expect(policy.branchProtection).toEqual({
      requiredChecks: [
        'quality (24)',
        'codeql',
        'Socket Security: Project Report',
        'dependency-review',
        'codecov/patch',
        'SonarCloud Code Analysis',
        'Mergify Merge Protections',
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
    expect(policy.repositoryRulesets).toEqual({
      active: true,
      authority: 'repository-ruleset',
      name: 'main-protection',
      target: 'branch',
      include: ['~DEFAULT_BRANCH'],
      bypassActors: [],
    });
  });

  it('defines a fail-safe activation target for a second eligible maintainer', () => {
    const policy = readPolicy();

    expect(policy.reviewPolicy.activation).toEqual({
      trigger: 'second-eligible-human-maintainer-has-review-access',
      accountableOwner: '@oaslananka',
      deadlineBusinessDays: 2,
      targetBranchProtection: {
        requiredApprovals: 1,
        requireCodeOwnerReviews: true,
        dismissStaleReviews: true,
        requireLastPushApproval: true,
      },
      verification: [
        'verify-live-collaborator-permission',
        'apply-main-branch-protection-target',
        'verify-owner-authored-test-pr-is-reviewable',
        'update-liveStateVerifiedAt',
      ],
    });
    expect(policy.continuity.operatingModel).toBe('solo-maintainer');
    expect(policy.continuity.currentBusFactor).toBe(1);
    expect(policy.continuity.minimumMaintainersForIndependentReview).toBe(2);
    expect(policy.continuity.successorStatus).toBe('not-designated');
    expect(policy.continuity.humanApprovalRequired).toBe(false);
    expect(policy.continuity.confidentialRecoveryRecord).toEqual({
      required: true,
      storage: 'offline-encrypted',
      plaintextSecretsInRepository: false,
    });
    expect(policy.continuity.requiredSuccessorEvidence).toContain(
      'github-admin-or-maintain-access',
    );
  });

  it('records a tested solo-maintainer recovery path without repository secrets', () => {
    const policy = readPolicy();
    const recovery = readText(policy.continuity.recovery.runbook);
    const exercise = JSON.parse(readText(policy.continuity.recovery.exerciseEvidence)) as {
      status: string;
      nonDestructive: boolean;
      release: { version: string; workflowRun: string };
      outcomes: Record<string, string>;
    };
    const branchEvidence = JSON.parse(
      readText(policy.continuity.recovery.branchProtectionEvidence),
    ) as {
      verifiedAt: string;
      branchProtection: GovernancePolicy['branchProtection'];
    };

    expect(policy.continuity.recovery.reviewCadenceDays).toBe(180);
    expect(policy.continuity.recovery.lastExerciseAt).toBe('2026-07-25');
    expect(policy.continuity.recovery.exerciseStatus).toBe('passed');
    expect(recovery).toContain('# Solo-maintainer continuity and release recovery');
    expect(recovery).toContain('Never store plaintext credentials');
    expect(recovery).toContain('Immutable release tags');
    expect(recovery).toContain('npm recovery');
    expect(recovery).toContain('GitHub Container Registry recovery');
    expect(recovery).toContain('MCP Registry recovery');
    expect(recovery).toContain('Ownership transfer');
    expect(recovery).toContain('Branch protection recovery');
    expect(exercise.status).toBe('passed');
    expect(exercise.nonDestructive).toBe(true);
    expect(exercise.release.version).toBe('0.35.3');
    expect(exercise.release.workflowRun).toContain('/actions/runs/30134300353');
    expect(exercise.outcomes.npm).toBe('passed');
    expect(exercise.outcomes.githubRelease).toBe('passed');
    expect(exercise.outcomes.ghcr).toBe('passed');
    expect(exercise.outcomes.mcpRegistry).toBe('passed');
    expect(branchEvidence.verifiedAt).toBe(policy.liveStateVerifiedAt);
    expect(branchEvidence.branchProtection).toEqual(policy.branchProtection);
  });

  it('does not retain governance links to the deleted audit issue', () => {
    for (const path of [
      'docs/REPOSITORY_GOVERNANCE.md',
      'docs/MAINTAINER_CONTINUITY.md',
      'docs/REMOTE_RELAY_STATUS.md',
      'docs/SOLO_MAINTAINER_RECOVERY.md',
    ]) {
      expect(readText(path), path).not.toContain('issues/399');
      expect(readText(path), path).not.toContain('issue #399');
    }
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
    expect(governance).toContain(
      '`main-protection` repository ruleset is the canonical enforcement mechanism',
    );
    expect(governance).not.toContain('No repository ruleset currently overlaps');

    expect(contributing).toContain('[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)');
    expect(security).toContain('[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)');
    expect(pullRequestTemplate).toContain('## Critical-path review');
    expect(pullRequestTemplate).toContain('## Automated review disposition');
    expect(pullRequestTemplate).toContain('Emergency exception evidence');
  });
});

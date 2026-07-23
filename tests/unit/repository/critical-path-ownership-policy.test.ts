import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;

interface GovernancePolicy {
  version: number;
  repository: string;
  defaultBranch: string;
  enforcementMode: string;
  eligibleMaintainers: number;
  independentReview: {
    currentRequiredApprovals: number;
    activateAtEligibleMaintainers: number;
    targetRequiredApprovals: number;
    requireCodeOwnerReview: boolean;
    dismissStaleReviews: boolean;
    requireLastPushApproval: boolean;
  };
  branchProtection: {
    strictStatusChecks: boolean;
    enforceAdmins: boolean;
    requireConversationResolution: boolean;
    allowForcePushes: boolean;
    allowDeletions: boolean;
    requiredChecks: string[];
  };
  emergencyException: {
    publicRationaleRequired: boolean;
    securityEmbargoAllowed: boolean;
    followUpReviewBusinessDays: number;
  };
  reviewDisposition: {
    botAndAgentCommentsRequired: boolean;
    unresolvedThreadsBlockMerge: boolean;
  };
}

const expectedCodeOwnerRules = [
  '/.github/CODEOWNERS @oaslananka',
  '/.github/workflows/ @oaslananka',
  '/SECURITY.md @oaslananka',
  '/docs/REPOSITORY_GOVERNANCE.md @oaslananka',
  '/config/repository-governance-policy.json @oaslananka',
  '/release-please-config.json @oaslananka',
  '/.release-please-manifest.json @oaslananka',
  '/scripts/release-channel-policy.mjs @oaslananka',
  '/scripts/sync-versions.mjs @oaslananka',
  '/src/server/transports/ @oaslananka',
  '/src/remote/ @oaslananka',
  '/src/bridge/ @oaslananka',
  '/src/config/env.ts @oaslananka',
  '/src/safety/ @oaslananka',
  '/src/transactions/ @oaslananka',
  '/src/tools/L1_schematic_write.ts @oaslananka',
  '/src/tools/L1_schematic_batch.ts @oaslananka',
  '/src/tools/L1_pcb_write.ts @oaslananka',
  '/src/tools/L1_transactions.ts @oaslananka',
  '/easyeda-bridge-extension/src/ @oaslananka',
];

describe('critical-path ownership policy', () => {
  it('routes every critical path through explicit CODEOWNERS rules', () => {
    const codeowners = readText('.github/CODEOWNERS');
    for (const rule of expectedCodeOwnerRules) {
      expect(codeowners).toContain(rule);
      const [pattern] = rule.split(' ');
      expect(existsSync(resolve(repoRoot, pattern.replace(/^\//, '').replace(/\/$/, '')))).toBe(
        true,
      );
    }
  });

  it('records the live solo-maintainer branch-protection posture and activation target', () => {
    const policy = readJson<GovernancePolicy>('config/repository-governance-policy.json');

    expect(policy).toMatchObject({
      version: 1,
      repository: 'oaslananka/easyeda-mcp-pro',
      defaultBranch: 'main',
      enforcementMode: 'classic-branch-protection-solo-maintainer',
      eligibleMaintainers: 1,
      independentReview: {
        currentRequiredApprovals: 0,
        activateAtEligibleMaintainers: 2,
        targetRequiredApprovals: 1,
        requireCodeOwnerReview: false,
        dismissStaleReviews: false,
        requireLastPushApproval: false,
      },
      branchProtection: {
        strictStatusChecks: true,
        enforceAdmins: true,
        requireConversationResolution: true,
        allowForcePushes: false,
        allowDeletions: false,
      },
      emergencyException: {
        publicRationaleRequired: true,
        securityEmbargoAllowed: true,
        followUpReviewBusinessDays: 2,
      },
      reviewDisposition: {
        botAndAgentCommentsRequired: true,
        unresolvedThreadsBlockMerge: true,
      },
    });
    expect(policy.branchProtection.requiredChecks).toEqual([
      'quality (24)',
      'codeql',
      'Socket Security: Project Report',
      'dependency-review',
    ]);
    const governance = readText('docs/REPOSITORY_GOVERNANCE.md');
    for (const check of policy.branchProtection.requiredChecks) {
      expect(governance).toContain(`\`${check}\``);
    }
  });

  it('documents review enforcement, bot disposition, and emergency exceptions', () => {
    const governance = readText('docs/REPOSITORY_GOVERNANCE.md');

    expect(governance).toContain('Critical-path ownership and review');
    expect(governance).toContain('independent human review');
    expect(governance).toContain('two eligible maintainers');
    expect(governance).toContain('require code-owner review');
    expect(governance).toContain('dismiss stale approvals');
    expect(governance).toContain('require approval of the most recent push');
    expect(governance).toContain('Bot and agent findings');
    expect(governance).toContain('explicitly dispositioned');
    expect(governance).toContain('public rationale');
    expect(governance).toContain('two business days');
    expect(governance).toContain('private GitHub Security Advisory');
  });

  it('links contributors and security reporters to the governance rules', () => {
    expect(readText('CONTRIBUTING.md')).toContain(
      '[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)',
    );
    expect(readText('SECURITY.md')).toContain(
      '[Repository Governance](docs/REPOSITORY_GOVERNANCE.md)',
    );
    const readme = readText('README.md');
    expect(readme).toContain('current solo-maintainer review mode');
    expect(readme).not.toContain('Governance policy requires code reviews');
    expect(readText('docs/.vitepress/config.ts')).toContain("link: '/REPOSITORY_GOVERNANCE'");
    const template = readText('.github/pull_request_template.md');
    expect(template).toContain('Human reviews, inline conversations, bot/agent comments');
    expect(template).toContain('explicitly dispositioned with evidence');
    expect(template).toContain('Critical-path ownership and independent-review requirements');
  });
});

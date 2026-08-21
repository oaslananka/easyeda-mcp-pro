import { pathToFileURL } from 'node:url';

import { createAndUploadReport } from '@codecov/bundle-analyzer';

const BUNDLE_DIRECTORIES = ['easyeda-bridge-extension/dist'];
const BUNDLE_NAME = 'easyeda-bridge-extension';
const IGNORE_PATTERNS = ['*.map', '*.json'];
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PR_PATTERN = /^[1-9]\d*$/;

const requiredValue = (env, key) => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for Codecov Bundle Analysis`);
  return value;
};

export function readBundleUploadMetadata(env = process.env) {
  const token = requiredValue(env, 'CODECOV_TOKEN');
  const slug = requiredValue(env, 'CODECOV_BUNDLE_SLUG');
  const sha = requiredValue(env, 'CODECOV_BUNDLE_SHA');
  const branch = requiredValue(env, 'CODECOV_BUNDLE_BRANCH');
  const prValue = env.CODECOV_BUNDLE_PR?.trim();

  if (!SLUG_PATTERN.test(slug)) {
    throw new Error('CODECOV_BUNDLE_SLUG must be an owner/repository slug');
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('CODECOV_BUNDLE_SHA must be an exact 40-character commit SHA');
  }
  if (prValue && !PR_PATTERN.test(prValue)) {
    throw new Error('CODECOV_BUNDLE_PR must be a positive pull request number');
  }

  return {
    token,
    slug,
    sha,
    branch,
    ...(prValue ? { pr: prValue } : {}),
  };
}

export async function runBundleAnalysis({
  env = process.env,
  uploader = createAndUploadReport,
} = {}) {
  const { token, slug, sha, branch, pr } = readBundleUploadMetadata(env);
  const hadGitHubActions = Object.hasOwn(env, 'GITHUB_ACTIONS');
  const githubActionsValue = env.GITHUB_ACTIONS;

  // @codecov/bundle-analyzer@2.0.1 currently fails to obtain a pre-signed
  // Bundle Analysis URL when it selects its GitHub Actions provider
  // (https://github.com/codecov/codecov-action/issues/1946). The same
  // analyzer succeeds through its local provider, so mask only the provider
  // discriminator while preserving exact GitHub metadata via uploadOverrides.
  delete env.GITHUB_ACTIONS;
  try {
    return await uploader(
      BUNDLE_DIRECTORIES,
      {
        uploadToken: token,
        bundleName: BUNDLE_NAME,
        enableBundleAnalysis: true,
        uploadOverrides: {
          slug,
          sha,
          branch,
          ...(pr ? { pr } : {}),
        },
      },
      { ignorePatterns: IGNORE_PATTERNS },
    );
  } finally {
    if (hadGitHubActions) env.GITHUB_ACTIONS = githubActionsValue;
    else delete env.GITHUB_ACTIONS;
  }
}

/* c8 ignore start -- exercised by the real trusted GitHub Actions upload. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runBundleAnalysis();
    console.log('Codecov Bundle Analysis upload completed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */

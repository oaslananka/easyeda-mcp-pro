import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG_PREFIX = 'easyeda-mcp-pro-v';
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const HOUR_MS = 60 * 60 * 1000;
const PUBLISH_JOB_NAME = 'Gate and publish immutable release';

function resolveGitExecutable(platform = process.platform) {
  let candidates;
  if (platform === 'win32') {
    candidates = [
      String.raw`C:\Program Files\Git\cmd\git.exe`,
      String.raw`C:\Program Files\Git\bin\git.exe`,
    ];
  } else if (platform === 'darwin') {
    candidates = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  } else {
    candidates = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
  }
  const executable = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!executable) {
    throw new Error(`Git executable was not found in the fixed allowlist for ${platform}.`);
  }
  return executable;
}

const GIT_EXECUTABLE = resolveGitExecutable();

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
const ADDITIONAL_RC_REQUIRED_ROOTS = [
  'src/index.ts',
  'src/cli',
  'src/config',
  'src/easyeda-runtime',
  'src/export-manifest',
  'src/live',
  'src/safety',
  'src/storage',
  'config/runtime-policy.json',
  'scripts/check-runtime.mjs',
  'easyeda-bridge-extension/scripts',
  'easyeda-bridge-extension/extension.json',
];

const RUNTIME_PROMOTION_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'server.json',
  '.claude-plugin/plugin.json',
  'config/runtime-policy.json',
  'scripts/check-runtime.mjs',
  'easyeda-bridge-extension/package.json',
  'easyeda-bridge-extension/extension.json',
]);

function isRuntimePromotionPath(path) {
  return (
    RUNTIME_PROMOTION_PATHS.has(path) ||
    path.startsWith('src/') ||
    path.startsWith('easyeda-bridge-extension/src/') ||
    path.startsWith('easyeda-bridge-extension/scripts/')
  );
}

function normalizeJsonVersionOnly(path, source) {
  if (source === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (
    path === 'package.json' ||
    path === '.claude-plugin/plugin.json' ||
    path === 'easyeda-bridge-extension/extension.json'
  ) {
    value.version = '<release-managed-version>';
  } else if (path === 'server.json') {
    value.version = '<release-managed-version>';
    if (Array.isArray(value.packages) && value.packages[0]) {
      value.packages[0].version = '<release-managed-version>';
    }
  } else {
    return undefined;
  }
  return JSON.stringify(value);
}

function normalizeReleaseManagedSource(path, source) {
  if (source === undefined) return undefined;
  const json = normalizeJsonVersionOnly(path, source);
  if (json !== undefined) return json;
  if (path === 'src/config/version.ts') {
    return source.replace(/(SERVER_VERSION\s*=\s*')[^']+(')/, '$1<release-managed-version>$2');
  }
  if (path === 'easyeda-bridge-extension/src/index.ts') {
    return source.replace(/(extensionVersion:\s*')[^']+(',)/, '$1<release-managed-version>$2');
  }
  return undefined;
}

export function validateEmergencySoakOverride({
  enabled,
  mode,
  eventName,
  releaseKind,
  evidenceUrl,
}) {
  if (!enabled) return false;
  if (mode !== 'publish' || eventName !== 'workflow_dispatch') {
    throw new Error('Emergency soak override requires a manual workflow dispatch.');
  }
  if (releaseKind !== 'patch') {
    throw new Error('Emergency soak override is limited to stable patch releases.');
  }
  if (!evidenceUrl) {
    throw new Error('Emergency soak override requires a public evidence URL.');
  }
  return true;
}

function sourcesDifferBeyondReleaseManagedVersion({ path, candidateSource, targetSource }) {
  if (candidateSource === targetSource) return false;
  const normalizedCandidate = normalizeReleaseManagedSource(path, candidateSource);
  const normalizedTarget = normalizeReleaseManagedSource(path, targetSource);
  if (normalizedCandidate === undefined || normalizedTarget === undefined) return true;
  return normalizedCandidate !== normalizedTarget;
}

function pathMatchesRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

export function filterPostCandidateRuntimeChanges(changes) {
  return changes
    .filter(({ path }) => isRuntimePromotionPath(path))
    .filter(sourcesDifferBeyondReleaseManagedVersion)
    .map(({ path }) => path)
    .sort(compareStrings);
}

export function filterReleaseCandidateRequiredChanges(changes, sensitiveRoots) {
  return changes
    .filter(({ path }) => sensitiveRoots.some((root) => pathMatchesRoot(path, root)))
    .filter(sourcesDifferBeyondReleaseManagedVersion)
    .map(({ path }) => path)
    .sort(compareStrings);
}

export function validatePatchCandidateRequirement({ releaseKind, candidateTag, sensitiveChanges }) {
  if (releaseKind !== 'patch' || candidateTag) return false;
  if (sensitiveChanges.length > 0) {
    throw new Error(
      `Patch release changes release-candidate-required paths and requires a numbered release candidate: ${sensitiveChanges.join(', ')}.`,
    );
  }
  return true;
}

function parseStableVersion(version) {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid stable version: ${version || '<empty>'}.`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function releaseKind(targetVersion, previousStableVersion) {
  if (!previousStableVersion) return 'major';
  const target = parseStableVersion(targetVersion);
  const previous = parseStableVersion(previousStableVersion);
  if (compareStableVersions(targetVersion, previousStableVersion) <= 0) {
    throw new Error(`Stable release ${targetVersion} must be newer than ${previousStableVersion}.`);
  }
  if (target.major !== previous.major) return 'major';
  if (target.minor !== previous.minor) return 'minor';
  if (target.patch !== previous.patch) return 'patch';
  throw new Error(`Unable to classify stable release ${targetVersion}.`);
}

function isoTimestamp(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not a valid timestamp: ${value}.`);
  return timestamp;
}

export function evaluateStableSoak({
  targetVersion,
  previousStableVersion,
  candidateVersion = null,
  candidatePublishedAt = null,
  baselineCommitAt = null,
  now,
}) {
  const kind = releaseKind(targetVersion, previousStableVersion);
  let requiredHours;
  let startTimestamp;

  if (candidateVersion) {
    const escapedTargetVersion = targetVersion.replaceAll('.', String.raw`\.`);
    const candidatePattern = new RegExp(String.raw`^${escapedTargetVersion}-rc\.[1-9]\d*$`);
    if (!candidatePattern.test(candidateVersion)) {
      throw new Error(
        `Release candidate ${candidateVersion} does not belong to stable ${targetVersion}.`,
      );
    }
    requiredHours = kind === 'major' ? 168 : 72;
    startTimestamp = isoTimestamp(candidatePublishedAt, 'Candidate publication completion');
  } else {
    if (kind !== 'patch') {
      throw new Error(
        `${kind} stable release ${targetVersion} requires a numbered release candidate.`,
      );
    }
    requiredHours = 24;
    startTimestamp = isoTimestamp(baselineCommitAt, 'Patch main-soak baseline');
  }

  const nowTimestamp = isoTimestamp(now, 'Current time');
  const eligibleTimestamp = startTimestamp + requiredHours * HOUR_MS;
  return {
    eligible: nowTimestamp >= eligibleTimestamp,
    requiredHours,
    eligibleAt: new Date(eligibleTimestamp).toISOString(),
  };
}

export function selectLatestReleaseCandidate(tags, targetVersion) {
  const escaped = targetVersion.replaceAll('.', String.raw`\.`);
  const pattern = new RegExp(String.raw`^${RELEASE_TAG_PREFIX}${escaped}-rc\.([1-9]\d*)$`);
  let best = null;
  let bestNumber = -1;
  for (const tag of tags) {
    const match = pattern.exec(tag);
    if (!match) continue;
    const candidateNumber = Number(match[1]);
    if (candidateNumber > bestNumber) {
      best = tag;
      bestNumber = candidateNumber;
    }
  }
  return best;
}

export function selectCandidatePublicationRun(runs, candidateCommit) {
  return (
    runs
      .filter(
        (run) =>
          run.event === 'workflow_dispatch' &&
          run.conclusion === 'success' &&
          run.head_sha === candidateCommit &&
          run.publication_job_conclusion === 'success' &&
          Number.isFinite(Date.parse(run.updated_at)),
      )
      .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))[0] ?? null
  );
}

function git(root, args) {
  return execFileSync(GIT_EXECUTABLE, args, { cwd: root, encoding: 'utf8' }).trim();
}

function listTags(root) {
  const output = git(root, ['tag', '--list', `${RELEASE_TAG_PREFIX}*`]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function stableVersionFromTag(tag) {
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(RELEASE_TAG_PREFIX.length);
  return STABLE_VERSION_PATTERN.test(version) ? version : null;
}

function previousStableVersion(tags, targetVersion) {
  return (
    tags
      .map(stableVersionFromTag)
      .filter((version) => version && compareStableVersions(version, targetVersion) < 0)
      .sort(compareStableVersions)
      .at(-1) ?? null
  );
}

function readPackageVersion(root) {
  return JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version;
}

function readPackageVersionAtRef(root, ref) {
  const source = git(root, ['show', `${ref}:package.json`]);
  return JSON.parse(source).version;
}

function commitTimestamp(root, ref) {
  return git(root, ['show', '-s', '--format=%cI', ref]);
}

function readFileAtRef(root, ref, path) {
  try {
    return execFileSync(GIT_EXECUTABLE, ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function listChangedSources(root, baseRef, targetRef) {
  const output = git(root, ['diff', '--name-only', baseRef, targetRef]);
  const paths = output ? output.split('\n').filter(Boolean) : [];
  return paths.map((path) => ({
    path,
    candidateSource: readFileAtRef(root, baseRef, path),
    targetSource: readFileAtRef(root, targetRef, path),
  }));
}

function postCandidateRuntimeChanges(root, candidateCommit, targetRef) {
  return filterPostCandidateRuntimeChanges(listChangedSources(root, candidateCommit, targetRef));
}

function releaseCandidateRequiredRoots(root) {
  const source = JSON.parse(readFileSync(`${root}/config/easyeda-compatibility.json`, 'utf8'));
  const configured = source?.releaseGate?.sensitivePaths;
  if (!Array.isArray(configured) || configured.some((path) => typeof path !== 'string' || !path)) {
    throw new Error(
      'EasyEDA compatibility releaseGate.sensitivePaths must be a non-empty string array.',
    );
  }
  return [...new Set([...configured, ...ADDITIONAL_RC_REQUIRED_ROOTS])].sort(compareStrings);
}

function patchCandidateRequirement({
  root,
  releaseKind,
  previousVersion,
  candidateTag,
  targetRef,
}) {
  if (releaseKind !== 'patch' || candidateTag) return false;
  if (!previousVersion) throw new Error('Patch release requires a previous stable version.');
  const previousTag = `${RELEASE_TAG_PREFIX}${previousVersion}`;
  const changes = listChangedSources(root, previousTag, targetRef);
  const sensitiveChanges = filterReleaseCandidateRequiredChanges(
    changes,
    releaseCandidateRequiredRoots(root),
  );
  return validatePatchCandidateRequirement({ releaseKind, candidateTag, sensitiveChanges });
}

function githubApiHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'easyeda-mcp-pro-release-soak-policy',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchGithubJson({ url, token, fetchImpl, label }) {
  const response = await fetchImpl(url, {
    headers: githubApiHeaders(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  return response.json();
}

async function publicationJobConclusion({ repository, runId, token, fetchImpl }) {
  const url = new URL(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs`);
  url.searchParams.set('filter', 'latest');
  url.searchParams.set('per_page', '100');
  const body = await fetchGithubJson({
    url,
    token,
    fetchImpl,
    label: 'GitHub Actions publication-job lookup',
  });
  if (!Array.isArray(body.jobs)) {
    throw new TypeError('GitHub Actions publication-job lookup returned an invalid response.');
  }
  return body.jobs.find((job) => job.name === PUBLISH_JOB_NAME)?.conclusion ?? null;
}

async function listPublicationRuns({ repository, candidateCommit, token, fetchImpl }) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY is required to verify release-candidate publication.');
  }
  const url = new URL(
    `https://api.github.com/repos/${repository}/actions/workflows/publish-release.yml/runs`,
  );
  url.searchParams.set('event', 'workflow_dispatch');
  url.searchParams.set('status', 'success');
  url.searchParams.set('head_sha', candidateCommit);
  url.searchParams.set('per_page', '100');
  const body = await fetchGithubJson({
    url,
    token,
    fetchImpl,
    label: 'GitHub Actions publication lookup',
  });
  if (!Array.isArray(body.workflow_runs)) {
    throw new TypeError('GitHub Actions publication lookup returned an invalid response.');
  }
  return Promise.all(
    body.workflow_runs.map(async (run) => ({
      ...run,
      publication_job_conclusion: await publicationJobConclusion({
        repository,
        runId: run.id,
        token,
        fetchImpl,
      }),
    })),
  );
}

function resolveTargetContext({ root, mode, releaseChannel, releaseTag, targetRef, baseRef }) {
  if (mode === 'pull_request') {
    if (!baseRef) throw new Error('BASE_REF is required for pull-request release-soak checks.');
    const targetVersion = readPackageVersion(root);
    const baseVersion = readPackageVersionAtRef(root, baseRef);
    if (targetVersion === baseVersion || !STABLE_VERSION_PATTERN.test(targetVersion)) {
      return { applicable: false };
    }
    return { applicable: true, targetVersion, baselineRef: baseRef };
  }
  if (mode !== 'publish') throw new Error(`Unsupported release soak mode: ${mode}.`);
  if (releaseChannel !== 'stable') return { applicable: false };
  if (!releaseTag.startsWith(RELEASE_TAG_PREFIX)) {
    throw new Error(`Invalid stable release tag: ${releaseTag || '<empty>'}.`);
  }
  const targetVersion = releaseTag.slice(RELEASE_TAG_PREFIX.length);
  parseStableVersion(targetVersion);
  return { applicable: true, targetVersion, baselineRef: targetRef };
}

function resolveReleaseContext({ root, targetVersion }) {
  const tags = listTags(root);
  const previousVersion = previousStableVersion(tags, targetVersion);
  return {
    previousVersion,
    releaseKind: releaseKind(targetVersion, previousVersion),
    candidateTag: selectLatestReleaseCandidate(tags, targetVersion),
  };
}

function assertCandidateAncestor(root, candidateTag, candidateCommit, targetRef) {
  try {
    git(root, ['merge-base', '--is-ancestor', candidateCommit, targetRef]);
  } catch {
    throw new Error(`${candidateTag} is not an ancestor of ${targetRef}.`);
  }
}

function assertNoPostCandidateRuntimeChanges(root, candidateTag, candidateCommit, targetRef) {
  const runtimeChanges = postCandidateRuntimeChanges(root, candidateCommit, targetRef);
  if (runtimeChanges.length === 0) return;
  throw new Error(
    `Runtime changes after ${candidateTag} require a new release candidate: ${runtimeChanges.join(', ')}.`,
  );
}

async function resolveCandidateEvidence({
  root,
  candidateTag,
  targetRef,
  repository,
  token,
  fetchImpl,
}) {
  if (!candidateTag) return { candidateVersion: null, candidatePublishedAt: null };
  const candidateCommit = git(root, ['rev-parse', `${candidateTag}^{commit}`]);
  assertCandidateAncestor(root, candidateTag, candidateCommit, targetRef);
  assertNoPostCandidateRuntimeChanges(root, candidateTag, candidateCommit, targetRef);
  const runs = await listPublicationRuns({ repository, candidateCommit, token, fetchImpl });
  const publicationRun = selectCandidatePublicationRun(runs, candidateCommit);
  if (!publicationRun) {
    throw new Error(
      `No successful Publish Release workflow-dispatch run found for ${candidateTag}.`,
    );
  }
  return {
    candidateVersion: candidateTag.slice(RELEASE_TAG_PREFIX.length),
    candidatePublishedAt: publicationRun.updated_at,
  };
}

function assertEligible(targetVersion, result) {
  if (result.eligible) return;
  throw new Error(
    `Stable ${targetVersion} soak is incomplete: requires ${result.requiredHours} hours and is eligible at ${result.eligibleAt}.`,
  );
}

function emergencyResult({ targetVersion, previousVersion, candidateTag, now }) {
  return {
    applicable: true,
    targetVersion,
    previousStableVersion: previousVersion,
    candidateTag,
    eligible: true,
    requiredHours: 0,
    eligibleAt: now,
    emergencyOverride: true,
  };
}

function resolveVerifyOptions(options) {
  return {
    root: process.cwd(),
    mode: 'publish',
    releaseChannel: '',
    releaseTag: '',
    targetRef: 'HEAD',
    baseRef: '',
    repository: '',
    token: '',
    eventName: '',
    evidenceUrl: '',
    emergencySoakOverride: false,
    now: new Date().toISOString(),
    fetchImpl: fetch,
    ...options,
  };
}

export async function verifyStableSoak(options) {
  const {
    root,
    mode,
    releaseChannel,
    releaseTag,
    targetRef,
    baseRef,
    repository,
    token,
    eventName,
    evidenceUrl,
    emergencySoakOverride,
    now,
    fetchImpl,
  } = resolveVerifyOptions(options);
  const target = resolveTargetContext({
    root,
    mode,
    releaseChannel,
    releaseTag,
    targetRef,
    baseRef,
  });
  if (!target.applicable) return target;

  const release = resolveReleaseContext({ root, targetVersion: target.targetVersion });
  const emergencyOverride = validateEmergencySoakOverride({
    enabled: emergencySoakOverride,
    mode,
    eventName,
    releaseKind: release.releaseKind,
    evidenceUrl,
  });
  const deferPatchSoak = patchCandidateRequirement({
    root,
    releaseKind: release.releaseKind,
    previousVersion: release.previousVersion,
    candidateTag: release.candidateTag,
    targetRef,
  });
  if (mode === 'pull_request' && deferPatchSoak) {
    return { applicable: false, reason: 'patch-soak-is-enforced-after-merge' };
  }

  const evidence = await resolveCandidateEvidence({
    root,
    candidateTag: release.candidateTag,
    targetRef,
    repository,
    token,
    fetchImpl,
  });
  if (emergencyOverride) {
    return emergencyResult({
      targetVersion: target.targetVersion,
      previousVersion: release.previousVersion,
      candidateTag: release.candidateTag,
      now,
    });
  }

  const result = evaluateStableSoak({
    targetVersion: target.targetVersion,
    previousStableVersion: release.previousVersion,
    candidateVersion: evidence.candidateVersion,
    candidatePublishedAt: evidence.candidatePublishedAt,
    baselineCommitAt: release.candidateTag ? null : commitTimestamp(root, target.baselineRef),
    now,
  });
  assertEligible(target.targetVersion, result);
  return {
    applicable: true,
    targetVersion: target.targetVersion,
    previousStableVersion: release.previousVersion,
    candidateTag: release.candidateTag,
    ...result,
  };
}

export async function runCli(env = process.env) {
  const result = await verifyStableSoak({
    mode: env.RELEASE_SOAK_MODE || 'publish',
    releaseChannel: env.RELEASE_CHANNEL || '',
    releaseTag: env.RELEASE_TAG || '',
    targetRef: env.TARGET_REF || 'HEAD',
    baseRef: env.BASE_REF || '',
    repository: env.GITHUB_REPOSITORY || '',
    token: env.GITHUB_TOKEN || '',
    eventName: env.GITHUB_EVENT_NAME || '',
    evidenceUrl: env.EVIDENCE_URL || '',
    emergencySoakOverride: env.EMERGENCY_SOAK_OVERRIDE === 'true',
    now: env.RELEASE_SOAK_NOW || new Date().toISOString(),
  });
  if (!result.applicable) {
    console.log('Stable release soak gate not applicable.');
    return;
  }
  if (result.emergencyOverride) {
    console.log(
      `Stable ${result.targetVersion} emergency patch soak override accepted from manual dispatch.`,
    );
    return;
  }
  console.log(
    `Stable ${result.targetVersion} soak gate passed; eligible since ${result.eligibleAt}.`,
  );
}

/* c8 ignore start -- exercised through workflow policy and unit orchestration tests. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */

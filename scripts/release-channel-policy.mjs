import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_PATTERN = /^easyeda-mcp-pro-v\d+\.\d+\.\d+$/;
const PRERELEASE_TAG_PATTERN = /^easyeda-mcp-pro-v\d+\.\d+\.\d+-rc\.[1-9]\d*$/;
const RELEASE_COMMIT_PATTERN =
  /^chore\(main\): release easyeda-mcp-pro (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;
const EVIDENCE_URL_PATTERN =
  /^https:\/\/github\.com\/oaslananka\/easyeda-mcp-pro\/(issues|pull)\/\d+$/;

function classifyTag(tag) {
  if (STABLE_TAG_PATTERN.test(tag)) {
    return { releaseChannel: 'stable', npmDistTag: 'latest' };
  }
  if (PRERELEASE_TAG_PATTERN.test(tag)) {
    return { releaseChannel: 'prerelease', npmDistTag: 'next' };
  }
  throw new Error('Invalid tag. Use easyeda-mcp-pro-vX.Y.Z or easyeda-mcp-pro-vX.Y.Z-rc.N.');
}

function disabledPlan() {
  return {
    releaseRun: false,
    releaseTag: '',
    releaseChannel: '',
    npmDistTag: '',
    targetRef: '',
    createGithubRelease: false,
    evidenceUrl: '',
  };
}

export function resolveReleaseChannel({
  eventName,
  refName = '',
  commitSubject = '',
  headSha = '',
  packageVersion = '',
  manifestVersion = '',
  tagExists = false,
  manualTag = '',
  manualChannel = '',
  evidenceUrl = '',
}) {
  if (eventName === 'push') {
    const match = RELEASE_COMMIT_PATTERN.exec(commitSubject);
    if (!match) return disabledPlan();
    if (refName !== 'main') throw new Error('Automatic publication requires main.');

    const version = match[1];
    if (packageVersion !== version || manifestVersion !== version) {
      throw new Error(
        `Automatic release metadata drift: commit=${version}, package=${packageVersion || '<empty>'}, manifest=${manifestVersion || '<empty>'}.`,
      );
    }

    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error(
        'Automatic publication requires the exact 40-character candidate commit SHA.',
      );
    }

    const releaseTag = `easyeda-mcp-pro-v${version}`;
    return {
      releaseRun: true,
      releaseTag,
      releaseChannel: 'stable',
      npmDistTag: 'latest',
      targetRef: tagExists ? releaseTag : headSha,
      createGithubRelease: !tagExists,
      evidenceUrl: '',
    };
  }

  if (eventName !== 'workflow_dispatch') {
    throw new Error(`Unsupported release event: ${eventName || '<empty>'}.`);
  }
  if (refName !== 'main') throw new Error('Manual publication must be dispatched from main.');
  if (!EVIDENCE_URL_PATTERN.test(evidenceUrl)) {
    throw new Error('Manual releases require a public easyeda-mcp-pro issue or PR evidence URL.');
  }

  const { releaseChannel, npmDistTag } = classifyTag(manualTag);
  if (manualChannel !== releaseChannel) {
    throw new Error(
      `Requested channel ${manualChannel || '<empty>'} does not match ${manualTag} (${releaseChannel}).`,
    );
  }

  return {
    releaseRun: true,
    releaseTag: manualTag,
    releaseChannel,
    npmDistTag,
    targetRef: manualTag,
    createGithubRelease: false,
    evidenceUrl,
  };
}

function appendKeyValues(path, values, appendFile) {
  if (!path) throw new Error('GitHub Actions output path is unavailable.');
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
  appendFile(path, `${body}\n`, 'utf8');
}

export function runCli(env = process.env, appendFile = appendFileSync) {
  const result = resolveReleaseChannel({
    eventName: env.EVENT_NAME ?? '',
    refName: env.REF_NAME ?? '',
    commitSubject: env.COMMIT_SUBJECT ?? '',
    headSha: env.HEAD_SHA ?? '',
    packageVersion: env.PACKAGE_VERSION ?? '',
    manifestVersion: env.MANIFEST_VERSION ?? '',
    tagExists: env.TAG_EXISTS === 'true',
    manualTag: env.MANUAL_TAG ?? '',
    manualChannel: env.MANUAL_CHANNEL ?? '',
    evidenceUrl: env.EVIDENCE_URL ?? '',
  });

  appendKeyValues(
    env.GITHUB_ENV,
    {
      RELEASE_RUN: result.releaseRun,
      RELEASE_TAG: result.releaseTag,
      RELEASE_CHANNEL: result.releaseChannel,
      NPM_DIST_TAG: result.npmDistTag,
      TARGET_REF: result.targetRef,
      CREATE_GITHUB_RELEASE: result.createGithubRelease,
      EVIDENCE_URL: result.evidenceUrl,
    },
    appendFile,
  );
  appendKeyValues(
    env.GITHUB_OUTPUT,
    {
      release_run: result.releaseRun,
      release_tag: result.releaseTag,
      release_channel: result.releaseChannel,
      npm_dist_tag: result.npmDistTag,
      target_ref: result.targetRef,
      create_github_release: result.createGithubRelease,
      evidence_url: result.evidenceUrl,
    },
    appendFile,
  );

  if (result.releaseRun && env.EVENT_NAME === 'workflow_dispatch') {
    appendFile(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Manual release evidence',
        '',
        `- Channel: \`${result.releaseChannel}\``,
        `- Tag: \`${result.releaseTag}\``,
        `- Evidence: ${result.evidenceUrl}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

/* c8 ignore start -- exercised by the child-process bootstrap test. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_PATTERN = /^easyeda-mcp-pro-v\d+\.\d+\.\d+$/;
const PRERELEASE_TAG_PATTERN = /^easyeda-mcp-pro-v\d+\.\d+\.\d+-rc\.[1-9]\d*$/;
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

export function resolveReleaseChannel({
  eventName,
  releaseCreated = '',
  generatedTag = '',
  manualTag = '',
  manualChannel = '',
  evidenceUrl = '',
}) {
  if (eventName === 'push' && releaseCreated !== 'true') {
    return {
      releaseRun: false,
      releaseTag: '',
      releaseChannel: '',
      npmDistTag: '',
    };
  }

  const isManual = eventName === 'workflow_dispatch';
  if (eventName !== 'push' && !isManual) {
    throw new Error(`Unsupported release event: ${eventName || '<empty>'}.`);
  }
  if (isManual && !EVIDENCE_URL_PATTERN.test(evidenceUrl)) {
    throw new Error('Manual releases require a public easyeda-mcp-pro issue or PR evidence URL.');
  }

  const releaseTag = isManual ? manualTag : generatedTag;
  const requestedChannel = isManual ? manualChannel : 'stable';
  const { releaseChannel, npmDistTag } = classifyTag(releaseTag);

  if (!isManual && releaseChannel !== 'stable') {
    throw new Error('Release Please is stable-only; prereleases require workflow_dispatch.');
  }
  if (requestedChannel !== releaseChannel) {
    throw new Error(
      `Requested channel ${requestedChannel || '<empty>'} does not match ${releaseTag} (${releaseChannel}).`,
    );
  }

  return {
    releaseRun: true,
    releaseTag,
    releaseChannel,
    npmDistTag,
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
    releaseCreated: env.RELEASE_CREATED ?? '',
    generatedTag: env.GENERATED_TAG ?? '',
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
    },
    appendFile,
  );
  appendKeyValues(
    env.GITHUB_OUTPUT,
    {
      release_run: result.releaseRun,
      release_tag: result.releaseTag,
      release_channel: result.releaseChannel,
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
        `- Evidence: ${env.EVIDENCE_URL}`,
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

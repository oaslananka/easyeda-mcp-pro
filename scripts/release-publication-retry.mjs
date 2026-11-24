import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function decodeNpmView(output) {
  if (!String(output ?? '').trim()) return null;
  const value = JSON.parse(output);
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function decideReleaseCreation({
  tag,
  targetSha,
  existingTagSha = null,
  existingRelease = null,
  channel,
}) {
  if (!/^easyeda-mcp-pro-v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(tag)) {
    throw new Error('Invalid release tag.');
  }
  if (!SHA_PATTERN.test(targetSha)) throw new Error('Expected immutable source SHA.');
  if (existingTagSha !== null && existingTagSha !== targetSha) {
    throw new Error('Existing release tag points to a different source commit.');
  }
  if (!existingRelease) return 'create';
  if (!existingTagSha) throw new Error('Existing GitHub Release has no verified tag.');
  if (
    existingRelease.tagName !== tag ||
    existingRelease.targetCommitish !== targetSha ||
    existingRelease.isDraft !== false ||
    existingRelease.isPrerelease !== (channel === 'prerelease')
  ) {
    throw new Error('Existing GitHub Release identity or classification mismatch.');
  }
  return 'reuse';
}

export async function waitForNpmVisibility({
  probe,
  delay = (ms) => sleep(ms),
  attempts = 25,
  intervalMs = 30_000,
  pending = () => 'npm version',
}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid retry budget.');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await probe()) return attempt;
    if (attempt < attempts) await delay(intervalMs);
  }
  throw new Error(pending() + ' not visible after ' + attempts + ' bounded attempts.');
}

function command(name, args) {
  return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function optionalRelease(tag) {
  try {
    return JSON.parse(
      command('gh', [
        'release',
        'view',
        tag,
        '--json',
        'tagName,targetCommitish,isDraft,isPrerelease',
      ]),
    );
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    if (/release not found|HTTP 404|Not Found/i.test(stderr)) return null;
    throw error;
  }
}

function existingTagSha(tag) {
  try {
    return command('git', ['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}']);
  } catch {
    return null;
  }
}

export function ensureRelease(env = process.env) {
  const tag = env.RELEASE_TAG;
  const targetSha = command('git', ['rev-parse', env.TARGET_REF + '^{commit}']);
  command('git', ['fetch', '--force', '--tags', 'origin']);
  const decision = decideReleaseCreation({
    tag,
    targetSha,
    existingTagSha: existingTagSha(tag),
    existingRelease: optionalRelease(tag),
    channel: env.RELEASE_CHANNEL,
  });
  if (decision === 'reuse') {
    console.log('Verified existing immutable GitHub Release ' + tag + '; no duplicate creation.');
    return;
  }
  command('gh', [
    'release',
    'create',
    tag,
    '--repo',
    env.GITHUB_REPOSITORY,
    '--target',
    targetSha,
    '--title',
    'easyeda-mcp-pro v' + tag.replace('easyeda-mcp-pro-v', ''),
    '--generate-notes',
  ]);
  console.log('Created commit-bound release ' + tag + '.');
}

function npmLookup(args) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
}

function lookupNpm(runNpm, args, allowMissing = false) {
  const response = runNpm([
    'view',
    ...args,
    '--json',
    '--prefer-online',
    '--fetch-retries=0',
    '--fetch-timeout=10000',
    '--registry=https://registry.npmjs.org/',
  ]);
  if (response.status === 0 && !response.error && !response.signal) {
    const value = decodeNpmView(response.stdout);
    if (allowMissing && value === null) throw new Error('Invalid npm metadata response.');
    return value;
  }
  if (
    allowMissing &&
    !response.error &&
    !response.signal &&
    /\bcode E404\b/i.test(response.stderr ?? '')
  ) {
    return null;
  }
  throw new Error(
    'npm lookup failed unexpectedly: ' +
      String(response.error?.message ?? response.stderr).slice(0, 240),
  );
}

function validateNpmIdentity(metadata, { version, commitSha, tarball }) {
  if (
    metadata?.version !== version ||
    metadata.gitHead !== commitSha ||
    metadata['dist.tarball'] !== tarball ||
    typeof metadata['dist.integrity'] !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata['dist.integrity'])
  ) {
    throw new Error('npm package identity mismatch (version, source, tarball or integrity).');
  }
}

function fetchTarballHead(url) {
  return fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    credentials: 'omit',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function waitForPublishedNpm(
  env = process.env,
  {
    manifest = JSON.parse(command('node', ['-p', 'JSON.stringify(require("./package.json"))'])),
    runNpm = npmLookup,
    headTarball = fetchTarballHead,
    delay,
    log = console.log,
    attempts,
    intervalMs,
  } = {},
) {
  const { name, version } = manifest;
  const tag = env.NPM_DIST_TAG;
  const commitSha = env.RELEASE_COMMIT_SHA;
  if (
    name !== 'easyeda-mcp-pro' ||
    !/^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(version) ||
    tag !== (version.includes('-rc.') ? 'next' : 'latest') ||
    !SHA_PATTERN.test(commitSha ?? '')
  ) {
    throw new Error('Invalid npm publication identity.');
  }
  const tarball = 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz';
  let phase = '';
  function markPending(next, detail = '') {
    if (phase !== next) log('Waiting for npm ' + next + (detail ? ': ' + detail : '') + '.');
    phase = next;
    return false;
  }
  const attempt = await waitForNpmVisibility({
    attempts,
    intervalMs,
    delay,
    pending: () => 'npm ' + phase,
    probe: async () => {
      const metadata = lookupNpm(
        runNpm,
        [name + '@' + version, 'version', 'gitHead', 'dist.tarball', 'dist.integrity'],
        true,
      );
      if (metadata === null) return markPending('metadata');
      validateNpmIdentity(metadata, { version, commitSha, tarball });
      const distTag = lookupNpm(runNpm, [name, 'dist-tags.' + tag]);
      if (distTag !== null && typeof distTag !== 'string') {
        throw new Error('Invalid npm dist-tag response.');
      }
      if (distTag !== version) return markPending('dist-tag ' + tag);
      const response = await headTarball(tarball);
      if (response.status === 404) {
        const age = response.headers.get('age');
        const detail = age && /^\d+$/.test(age) ? 'HTTP 404, cache age ' + age + 's' : 'HTTP 404';
        return markPending('tarball', detail);
      }
      if (response.status !== 200) {
        throw new Error('Unexpected npm tarball HTTP status ' + response.status + '.');
      }
      return true;
    },
  });
  log(
    'npm ' +
      name +
      '@' +
      version +
      ' visible with ' +
      tag +
      ' and canonical tarball on attempt ' +
      attempt +
      '.',
  );
  return attempt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'ensure-release') ensureRelease();
    else if (process.argv[2] === 'wait-npm') await waitForPublishedNpm();
    else throw new Error('Expected ensure-release or wait-npm mode.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

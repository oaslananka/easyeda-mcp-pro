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
  attempts = 20,
  intervalMs = 15_000,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid retry budget.');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await probe()) return attempt;
    if (attempt < attempts) await delay(intervalMs);
  }
  throw new Error('npm version not visible after ' + attempts + ' bounded attempts.');
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

export async function waitForPublishedNpm(env = process.env) {
  const manifest = JSON.parse(command('node', ['-p', 'JSON.stringify(require("./package.json"))']));
  const version = manifest.version;
  const name = manifest.name;
  const tag = env.NPM_DIST_TAG;
  const runNpm = (args) =>
    spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      encoding: 'utf8',
      timeout: 15_000,
      shell: process.platform === 'win32',
    });
  const attempt = await waitForNpmVisibility({
    probe: () => {
      const response = runNpm([
        'view',
        name + '@' + version,
        'version',
        '--json',
        '--fetch-retries=0',
        '--fetch-timeout=10000',
      ]);
      if (response.status === 0) return decodeNpmView(response.stdout) === version;
      if (/E404|404 Not Found|No match found for version/i.test(response.stderr ?? ''))
        return false;
      throw new Error(
        'npm lookup failed unexpectedly: ' +
          String(response.error?.message ?? response.stderr).slice(0, 240),
      );
    },
  });
  try {
    await waitForNpmVisibility({
      probe: () => {
        const distTag = runNpm([
          'view',
          name,
          'dist-tags.' + tag,
          '--json',
          '--fetch-retries=0',
          '--fetch-timeout=10000',
        ]);
        if (distTag.status !== 0) {
          throw new Error(
            'npm dist-tag lookup failed unexpectedly: ' +
              String(distTag.error?.message ?? distTag.stderr).slice(0, 240),
          );
        }
        return decodeNpmView(distTag.stdout) === version;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('npm version not visible after ')) {
      throw new Error('npm ' + tag + ' dist-tag mismatch.', { cause: error });
    }
    throw error;
  }
  console.log(
    'npm ' + name + '@' + version + ' visible with ' + tag + ' on attempt ' + attempt + '.',
  );
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

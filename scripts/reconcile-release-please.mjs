import { execFileSync } from 'node:child_process';
import { parsePendingRelease, verifyReleaseIdentity } from './reconcile-release-please-lib.mjs';
const repo = process.env.GITHUB_REPOSITORY;
if (!/^[-\w]+\/[-\w.]+$/.test(repo ?? '')) {
  throw new Error('GITHUB_REPOSITORY must be an exact owner/repository identifier');
}
if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to reconcile release labels');
function ghJson(...args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
}
function gitCommitForTag(tag) {
  return execFileSync('git', ['rev-parse', 'refs/tags/' + tag + '^{commit}'], {
    encoding: 'utf8',
  }).trim();
}
function publishedNpmVersion(version) {
  return execFileSync('npm', ['view', 'easyeda-mcp-pro@' + version, 'version', '--json'], {
    encoding: 'utf8',
  })
    .trim()
    .replace(/^"|"$/g, '');
}
const pages = ghJson(
  '--paginate',
  '--slurp',
  'repos/' + repo + '/issues?state=closed&labels=autorelease%3A%20pending&per_page=100',
);
for (const issue of pages.flat()) {
  if (!issue.pull_request) continue;
  const pull = ghJson('repos/' + repo + '/pulls/' + issue.number);
  const candidate = parsePendingRelease(issue, pull);
  if (!candidate) continue;
  const release = ghJson('repos/' + repo + '/releases/tags/' + candidate.tag);
  verifyReleaseIdentity(
    candidate,
    release,
    gitCommitForTag(candidate.tag),
    publishedNpmVersion(candidate.version),
  );
  if (process.env.RECONCILE_DRY_RUN === 'true') {
    console.log(
      'Dry run: verified publication for PR #' + candidate.number + '; no labels changed.',
    );
    continue;
  }
  execFileSync('gh', [
    'api',
    '-X',
    'POST',
    'repos/' + repo + '/issues/' + candidate.number + '/labels',
    '-f',
    'labels[]=autorelease: tagged',
  ]);
  execFileSync('gh', [
    'api',
    '-X',
    'DELETE',
    'repos/' + repo + '/issues/' + candidate.number + '/labels/autorelease%3A%20pending',
  ]);
  console.log('Verified published ' + candidate.tag + '; reconciled PR #' + candidate.number);
}
console.log('Merged release PR lifecycle reconciliation complete.');

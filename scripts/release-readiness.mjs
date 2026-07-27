import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SAFE_TARGET_REF_RE = /^[A-Za-z0-9._/@{}^~:+-]{1,200}$/;
const NO_GIT_REASON =
  'Git metadata is unavailable. Run this check from a complete Git checkout before publishing.';

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(comparePaths);
}

function isSafeTargetRef(value) {
  return typeof value === 'string' && SAFE_TARGET_REF_RE.test(value) && !value.startsWith('-');
}

function validateCompatibilityEvidence(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return 'Compatibility evidence must be a JSON object.';
  }
  const releaseGate = source.releaseGate;
  if (!releaseGate || typeof releaseGate !== 'object' || Array.isArray(releaseGate)) {
    return 'Compatibility evidence releaseGate is missing or malformed.';
  }
  if (
    !Array.isArray(releaseGate.sensitivePaths) ||
    !releaseGate.sensitivePaths.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && !entry.includes('\0'),
    )
  ) {
    return 'Compatibility evidence sensitivePaths must contain non-empty strings.';
  }
  if (
    !Number.isInteger(releaseGate.requiredFreshLiveRecords) ||
    releaseGate.requiredFreshLiveRecords < 1
  ) {
    return 'Compatibility evidence requiredFreshLiveRecords must be a positive integer.';
  }
  if (!Array.isArray(source.records) || source.records.length === 0) {
    return 'Compatibility evidence must contain at least one live record.';
  }
  for (const record of source.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return 'Compatibility evidence contains a malformed live record.';
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      return 'Compatibility evidence record id must be a non-empty string.';
    }
    if (!COMMIT_RE.test(record.server?.commit ?? '')) {
      return `Compatibility evidence record ${record.id} must reference a full Git commit.`;
    }
  }
  return undefined;
}

export async function loadCompatibilityEvidence({ root }) {
  const sourcePath = resolve(root, 'config/easyeda-compatibility.json');
  let text;
  try {
    text = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { ok: false, reason: 'Compatibility evidence is missing.' };
    }
    return { ok: false, reason: 'Compatibility evidence could not be read.' };
  }

  let source;
  try {
    source = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Compatibility evidence is not valid JSON.' };
  }

  const validationError = validateCompatibilityEvidence(source);
  if (validationError) return { ok: false, reason: validationError };
  return { ok: true, source };
}

export function resolveGitBinary() {
  const candidates =
    process.platform === 'win32'
      ? [
          resolve(
            process.env.ProgramFiles ?? String.raw`C:\Program Files`,
            'Git',
            'cmd',
            'git.exe',
          ),
          resolve(
            process.env.ProgramFiles ?? String.raw`C:\Program Files`,
            'Git',
            'bin',
            'git.exe',
          ),
        ]
      : ['/usr/bin/git', '/usr/local/bin/git'];
  return candidates.find((candidate) => existsSync(candidate));
}

function runGit({ gitBinary, root, args }) {
  if (!gitBinary) return { status: null, stdout: '' };
  const result = spawnSync(gitBinary, ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout?.trim() ?? '',
  };
}

function createUnavailableRecords(source, reason) {
  return (source?.records ?? []).map((record) => ({
    id: record.id,
    evidenceCommit: record.server.commit,
    status: 'unavailable',
    changedFiles: [],
    reason,
  }));
}

function createUnavailableReport({ source, targetRef, reason, records }) {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    reason,
    targetRef,
    headCommit: null,
    requiredFreshLiveRecords: source?.releaseGate?.requiredFreshLiveRecords ?? 1,
    freshRecords: 0,
    sensitivePaths: source?.releaseGate?.sensitivePaths ?? [],
    records: records ?? createUnavailableRecords(source, reason),
  };
}

function resolveCommit({ gitBinary, root, ref }) {
  const result = runGit({
    gitBinary,
    root,
    args: ['rev-parse', '--verify', `${ref}^{commit}`],
  });
  return result.status === 0 && COMMIT_RE.test(result.stdout) ? result.stdout : undefined;
}

function listChangedFiles({ gitBinary, root, base, head, paths }) {
  const result = runGit({
    gitBinary,
    root,
    args: ['diff', '--name-only', `${base}..${head}`, '--', ...paths],
  });
  if (result.status !== 0) return undefined;
  return result.stdout ? result.stdout.split('\n').filter(Boolean).sort(comparePaths) : [];
}

function listDirtyFiles({ gitBinary, root, paths }) {
  const worktree = runGit({
    gitBinary,
    root,
    args: ['diff', '--name-only', '--', ...paths],
  });
  const index = runGit({
    gitBinary,
    root,
    args: ['diff', '--cached', '--name-only', '--', ...paths],
  });
  if (worktree.status !== 0 || index.status !== 0) return undefined;
  return uniqueSorted(`${worktree.stdout}\n${index.stdout}`.split('\n').filter(Boolean));
}

function inspectRecord({ record, gitBinary, root, headCommit, paths, dirtyFiles }) {
  const evidenceCommit = resolveCommit({
    gitBinary,
    root,
    ref: record.server.commit,
  });
  if (!evidenceCommit) {
    return {
      id: record.id,
      evidenceCommit: record.server.commit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'The recorded evidence commit is unavailable in this Git checkout.',
    };
  }

  const ancestor = runGit({
    gitBinary,
    root,
    args: ['merge-base', '--is-ancestor', evidenceCommit, headCommit],
  });
  if (ancestor.status === 1) {
    return {
      id: record.id,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'The evidence commit is not an ancestor of the release candidate.',
    };
  }
  if (ancestor.status !== 0) {
    return {
      id: record.id,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'The evidence ancestry could not be verified.',
    };
  }

  const changedFiles = listChangedFiles({
    gitBinary,
    root,
    base: evidenceCommit,
    head: headCommit,
    paths,
  });
  if (!changedFiles) {
    return {
      id: record.id,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'Compatibility-sensitive changes could not be compared.',
    };
  }

  const combined = uniqueSorted([...changedFiles, ...dirtyFiles]);
  return {
    id: record.id,
    evidenceCommit,
    status: combined.length === 0 ? 'current' : 'stale',
    changedFiles: combined,
    reason:
      combined.length === 0
        ? 'No compatibility-sensitive file changed after the live evidence commit.'
        : 'Compatibility-sensitive files changed after the live evidence commit.',
  };
}

export async function inspectCompatibilityFreshness({
  root,
  targetRef = 'HEAD',
  gitBinary = resolveGitBinary(),
}) {
  const evidence = await loadCompatibilityEvidence({ root });
  if (!evidence.ok) {
    return createUnavailableReport({
      source: undefined,
      targetRef,
      reason: evidence.reason,
      records: [],
    });
  }
  const source = evidence.source;

  if (!isSafeTargetRef(targetRef)) {
    return createUnavailableReport({
      source,
      targetRef: '<invalid>',
      reason: 'The requested target ref is invalid.',
    });
  }

  const repository = runGit({
    gitBinary,
    root,
    args: ['rev-parse', '--is-inside-work-tree'],
  });
  if (repository.status !== 0 || repository.stdout !== 'true') {
    return createUnavailableReport({ source, targetRef, reason: NO_GIT_REASON });
  }

  const headCommit = resolveCommit({ gitBinary, root, ref: targetRef });
  if (!headCommit) {
    return createUnavailableReport({
      source,
      targetRef,
      reason: 'The requested target ref could not be resolved to a Git commit.',
    });
  }

  const paths = source.releaseGate.sensitivePaths;
  const dirtyFiles = targetRef === 'HEAD' ? listDirtyFiles({ gitBinary, root, paths }) : [];
  if (!dirtyFiles) {
    return createUnavailableReport({
      source,
      targetRef,
      reason: 'Compatibility-sensitive working tree changes could not be inspected.',
    });
  }

  const records = source.records.map((record) =>
    inspectRecord({ record, gitBinary, root, headCommit, paths, dirtyFiles }),
  );
  const requiredFreshLiveRecords = source.releaseGate.requiredFreshLiveRecords;
  const freshRecords = records.filter((record) => record.status === 'current').length;
  let status = 'unavailable';
  let reason = 'Required live compatibility evidence could not be verified.';
  if (freshRecords >= requiredFreshLiveRecords) {
    status = 'current';
    reason = 'Required live compatibility evidence is current.';
  } else if (records.some((record) => record.status === 'stale')) {
    status = 'stale';
    reason = 'Compatibility-sensitive files changed after live evidence.';
  }

  return {
    schemaVersion: 1,
    status,
    reason,
    targetRef,
    headCommit,
    requiredFreshLiveRecords,
    freshRecords,
    sensitivePaths: paths,
    records,
  };
}

export { NO_GIT_REASON };

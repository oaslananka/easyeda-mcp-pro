import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SAFE_TARGET_REF_RE = /^[A-Za-z0-9._/@{}^~:+-]{1,200}$/;
const NO_GIT_REASON =
  'Git metadata is unavailable. Run this check from a complete Git checkout before publishing.';
const RELEASE_MANAGED_EXTENSION_VERSION_PATH = 'easyeda-bridge-extension/src/index.ts';
const EXTENSION_VERSION_LITERAL_RE = /extensionVersion:\s*'([^']+)',/g;

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

function validateCompatibilitySnapshot({ snapshot, sensitivePaths, recordId }) {
  if (snapshot === undefined) return undefined;
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    snapshot.algorithm !== 'git-tree-sha1' ||
    !snapshot.paths ||
    typeof snapshot.paths !== 'object' ||
    Array.isArray(snapshot.paths)
  ) {
    return `Compatibility evidence record ${recordId} has a malformed compatibility snapshot.`;
  }
  const expectedPaths = uniqueSorted(sensitivePaths);
  const snapshotPaths = uniqueSorted(Object.keys(snapshot.paths));
  if (JSON.stringify(snapshotPaths) !== JSON.stringify(expectedPaths)) {
    return `Compatibility evidence record ${recordId} snapshot paths must match releaseGate.sensitivePaths.`;
  }
  if (!snapshotPaths.every((path) => COMMIT_RE.test(snapshot.paths[path] ?? ''))) {
    return `Compatibility evidence record ${recordId} snapshot paths must reference full Git tree objects.`;
  }
  return undefined;
}

function validateReleaseGate(releaseGate) {
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
  return undefined;
}

function validateCompatibilityRecord({ record, sensitivePaths }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return 'Compatibility evidence contains a malformed live record.';
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return 'Compatibility evidence record id must be a non-empty string.';
  }
  if (!COMMIT_RE.test(record.server?.commit ?? '')) {
    return `Compatibility evidence record ${record.id} must reference a full Git commit.`;
  }
  return validateCompatibilitySnapshot({
    snapshot: record.server?.compatibilitySnapshot,
    sensitivePaths,
    recordId: record.id,
  });
}

function validateCompatibilityEvidence(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return 'Compatibility evidence must be a JSON object.';
  }
  const releaseGateError = validateReleaseGate(source.releaseGate);
  if (releaseGateError) return releaseGateError;
  if (!Array.isArray(source.records) || source.records.length === 0) {
    return 'Compatibility evidence must contain at least one live record.';
  }
  for (const record of source.records) {
    const recordError = validateCompatibilityRecord({
      record,
      sensitivePaths: source.releaseGate.sensitivePaths,
    });
    if (recordError) return recordError;
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

function readFileAtCommit({ gitBinary, root, commit, path }) {
  const result = runGit({ gitBinary, root, args: ['show', `${commit}:${path}`] });
  return result.status === 0 ? result.stdout : undefined;
}

function parseSingleExtensionVersion(source) {
  if (typeof source !== 'string') return undefined;
  const matches = [...source.matchAll(EXTENSION_VERSION_LITERAL_RE)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function normalizeReleaseManagedExtensionVersion(source) {
  return source.replace(/(extensionVersion:\s*')[^']+(',)/, '$1<release-managed-version>$2');
}

function isStablePromotionVersionPair({ evidenceVersion, targetVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion ?? '')) return false;
  if (!evidenceVersion?.startsWith(`${targetVersion}-`)) return false;
  const prerelease = evidenceVersion.slice(targetVersion.length + 1);
  return /^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(prerelease);
}

function isStablePromotionSourceOnly({ evidenceSource, targetSource }) {
  const evidenceVersion = parseSingleExtensionVersion(evidenceSource);
  const targetVersion = parseSingleExtensionVersion(targetSource);
  if (!isStablePromotionVersionPair({ evidenceVersion, targetVersion })) return false;

  return (
    normalizeReleaseManagedExtensionVersion(evidenceSource) ===
    normalizeReleaseManagedExtensionVersion(targetSource)
  );
}

function isReleaseManagedStablePromotionOnly({ gitBinary, root, base, head, path }) {
  if (path !== RELEASE_MANAGED_EXTENSION_VERSION_PATH) return false;
  const evidenceSource = readFileAtCommit({ gitBinary, root, commit: base, path });
  const targetSource = readFileAtCommit({ gitBinary, root, commit: head, path });
  if (evidenceSource === undefined || targetSource === undefined) return false;

  return isStablePromotionSourceOnly({ evidenceSource, targetSource });
}

function filterReleaseManagedStablePromotion({ gitBinary, root, base, head, changedFiles }) {
  return changedFiles.filter(
    (path) => !isReleaseManagedStablePromotionOnly({ gitBinary, root, base, head, path }),
  );
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

function resolveSensitivePathTrees({ gitBinary, root, commit, paths }) {
  const trees = {};
  for (const path of paths) {
    const result = runGit({
      gitBinary,
      root,
      args: ['rev-parse', '--verify', `${commit}:${path}`],
    });
    if (result.status !== 0 || !COMMIT_RE.test(result.stdout)) return undefined;
    trees[path] = result.stdout;
  }
  return trees;
}

function listSnapshotDifferences({ recordedTrees, actualTrees, paths }) {
  return paths.filter((path) => recordedTrees[path] !== actualTrees[path]).sort(comparePaths);
}

function recordResult({
  record,
  evidenceCommit = record.server.commit,
  status,
  changedFiles,
  reason,
}) {
  return {
    id: record.id,
    evidenceCommit,
    status,
    changedFiles,
    reason,
  };
}

function isSnapshotStablePromotionOnly({
  gitBinary,
  root,
  recordedTrees,
  headTrees,
  changedPaths,
}) {
  const sensitiveRoot = 'easyeda-bridge-extension/src';
  if (changedPaths.length !== 1 || changedPaths[0] !== sensitiveRoot) return false;

  const recordedTree = recordedTrees[sensitiveRoot];
  const headTree = headTrees[sensitiveRoot];
  if (!recordedTree || !headTree) return false;

  const diff = runGit({
    gitBinary,
    root,
    args: ['diff', '--name-only', recordedTree, headTree],
  });
  if (diff.status !== 0 || diff.stdout !== 'index.ts') return false;

  const evidenceSource = readFileAtCommit({
    gitBinary,
    root,
    commit: recordedTree,
    path: 'index.ts',
  });
  const targetSource = readFileAtCommit({
    gitBinary,
    root,
    commit: headTree,
    path: 'index.ts',
  });
  if (evidenceSource === undefined || targetSource === undefined) return false;

  return isStablePromotionSourceOnly({ evidenceSource, targetSource });
}

function snapshotResult({ record, gitBinary, root, headTrees, paths, dirtyFiles }) {
  const recordedTrees = record.server.compatibilitySnapshot.paths;
  const changedPaths = listSnapshotDifferences({ recordedTrees, actualTrees: headTrees, paths });
  const comparedPaths = isSnapshotStablePromotionOnly({
    gitBinary,
    root,
    recordedTrees,
    headTrees,
    changedPaths,
  })
    ? []
    : changedPaths;
  const combined = uniqueSorted([...comparedPaths, ...dirtyFiles]);
  return recordResult({
    record,
    status: combined.length === 0 ? 'current' : 'stale',
    changedFiles: combined,
    reason:
      combined.length === 0
        ? 'The release candidate matches the recorded compatibility-sensitive snapshot.'
        : 'Compatibility-sensitive paths differ from the recorded live snapshot.',
  });
}

function snapshotVerificationError({ record, gitBinary, root, evidenceCommit, paths }) {
  const recordedSnapshot = record.server.compatibilitySnapshot;
  if (!recordedSnapshot) return undefined;
  const evidenceTrees = resolveSensitivePathTrees({
    gitBinary,
    root,
    commit: evidenceCommit,
    paths,
  });
  if (!evidenceTrees) return 'The evidence commit compatibility snapshot could not be inspected.';
  const differences = listSnapshotDifferences({
    recordedTrees: recordedSnapshot.paths,
    actualTrees: evidenceTrees,
    paths,
  });
  return differences.length > 0
    ? 'The recorded compatibility snapshot does not match the evidence commit.'
    : undefined;
}

function comparisonReason({ current, equivalentRewrite }) {
  if (current) {
    return equivalentRewrite
      ? 'The release candidate has equivalent compatibility-sensitive content to the live evidence commit.'
      : 'No compatibility-sensitive file changed after the live evidence commit.';
  }
  return equivalentRewrite
    ? 'Compatibility-sensitive files differ from the live evidence commit.'
    : 'Compatibility-sensitive files changed after the live evidence commit.';
}

function compareAvailableEvidence({
  record,
  gitBinary,
  root,
  evidenceCommit,
  headCommit,
  paths,
  dirtyFiles,
  headTrees,
}) {
  const ancestor = runGit({
    gitBinary,
    root,
    args: ['merge-base', '--is-ancestor', evidenceCommit, headCommit],
  });
  if (ancestor.status !== 0 && ancestor.status !== 1) {
    return recordResult({
      record,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'The evidence ancestry could not be verified.',
    });
  }
  const rawChangedFiles = listChangedFiles({
    gitBinary,
    root,
    base: evidenceCommit,
    head: headCommit,
    paths,
  });
  if (!rawChangedFiles) {
    return recordResult({
      record,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: 'Compatibility-sensitive changes could not be compared.',
    });
  }
  const changedFiles = filterReleaseManagedStablePromotion({
    gitBinary,
    root,
    base: evidenceCommit,
    head: headCommit,
    changedFiles: rawChangedFiles,
  });
  const promotionOnly = rawChangedFiles.length > 0 && changedFiles.length === 0;
  const recordedTrees = record.server.compatibilitySnapshot?.paths;
  const snapshotDifferences =
    recordedTrees && headTrees
      ? listSnapshotDifferences({ recordedTrees, actualTrees: headTrees, paths })
      : [];
  let comparedFiles = snapshotDifferences;
  if (promotionOnly) {
    comparedFiles = [];
  } else if (changedFiles.length > 0) {
    comparedFiles = changedFiles;
  }
  const combined = uniqueSorted([...comparedFiles, ...dirtyFiles]);
  const current = combined.length === 0;
  return recordResult({
    record,
    evidenceCommit,
    status: current ? 'current' : 'stale',
    changedFiles: combined,
    reason: comparisonReason({ current, equivalentRewrite: ancestor.status === 1 }),
  });
}

function inspectRecord({ record, gitBinary, root, headCommit, paths, dirtyFiles }) {
  const recordedSnapshot = record.server.compatibilitySnapshot;
  const headTrees = recordedSnapshot
    ? resolveSensitivePathTrees({ gitBinary, root, commit: headCommit, paths })
    : undefined;
  if (recordedSnapshot && !headTrees) {
    return recordResult({
      record,
      status: 'unavailable',
      changedFiles: [],
      reason: 'The release candidate compatibility snapshot could not be inspected.',
    });
  }

  const evidenceCommit = resolveCommit({ gitBinary, root, ref: record.server.commit });
  if (!evidenceCommit) {
    return recordedSnapshot && headTrees
      ? snapshotResult({ record, gitBinary, root, headTrees, paths, dirtyFiles })
      : recordResult({
          record,
          status: 'unavailable',
          changedFiles: [],
          reason: 'The recorded evidence commit is unavailable in this Git checkout.',
        });
  }

  const snapshotError = snapshotVerificationError({
    record,
    gitBinary,
    root,
    evidenceCommit,
    paths,
  });
  if (snapshotError) {
    return recordResult({
      record,
      evidenceCommit,
      status: 'unavailable',
      changedFiles: [],
      reason: snapshotError,
    });
  }

  return compareAvailableEvidence({
    record,
    gitBinary,
    root,
    evidenceCommit,
    headCommit,
    paths,
    dirtyFiles,
    headTrees,
  });
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

const RELEASE_TITLE = /^chore\(main\): release easyeda-mcp-pro (\d+\.\d+\.\d+)$/;
export function parsePendingRelease(issue, pull) {
  if (!issue?.pull_request || !pull?.merged_at) return null;
  const match = RELEASE_TITLE.exec(issue.title ?? '');
  if (!match) return null;
  if (pull.number !== issue.number || !/^[0-9a-f]{40}$/.test(pull.merge_commit_sha ?? '')) {
    throw new Error('merged release PR has mismatched identity');
  }
  return {
    number: issue.number,
    version: match[1],
    tag: 'easyeda-mcp-pro-v' + match[1],
    mergeSha: pull.merge_commit_sha,
  };
}
export function verifyReleaseIdentity(candidate, release, tagSha, npmVersion) {
  if (tagSha !== candidate.mergeSha)
    throw new Error('release tag does not identify merged PR commit');
  if (
    !release ||
    release.tag_name !== candidate.tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.target_commitish !== candidate.mergeSha
  ) {
    throw new Error('GitHub Release identity or channel is not verified');
  }
  if (npmVersion !== candidate.version)
    throw new Error('npm published version is missing or mismatched');
  const names = new Set(
    (release.assets ?? []).filter((asset) => asset.size > 0).map((asset) => asset.name),
  );
  for (const asset of [
    'easyeda-bridge-extension.eext',
    'sbom.json',
    candidate.tag + '.provenance.sigstore.json',
    candidate.tag + '.intoto.jsonl',
  ]) {
    if (!names.has(asset)) throw new Error('published release asset missing: ' + asset);
  }
  return true;
}

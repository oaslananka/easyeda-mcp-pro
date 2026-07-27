export type ReleaseChannel = 'stable' | 'prerelease';
export type ProvenanceObservation = 'passed' | 'failed' | 'unverified';
export type ReleaseVerificationCheckStatus = 'passed' | 'failed';

export interface ReleaseVerificationExpectation {
  repository: string;
  packageName: string;
  mcpName: string;
  version: string;
  tag: string;
  channel: ReleaseChannel;
  npmDistTag: string;
  commitSha: string;
  requiredAssets: string[];
  requiredGhcrTags: string[];
}

export interface ReleaseAssetObservation {
  name: string;
  digest?: string;
}

export interface ReleaseVerificationObservation {
  npm: {
    version?: string;
    distTags: Record<string, string | undefined>;
    provenance: ProvenanceObservation;
    workflowContextProof?: boolean;
  };
  github: {
    tag?: string;
    tagCommitSha?: string;
    isDraft?: boolean;
    isPrerelease?: boolean;
    assets: ReleaseAssetObservation[];
  };
  ghcr: {
    digest?: string;
    tags: string[];
    revision?: string;
  };
  mcpRegistry: {
    version?: string;
    isLatest?: boolean;
  } | null;
}

export type ReleaseVerificationCheckId =
  | 'npm-version'
  | 'npm-dist-tag'
  | 'npm-provenance'
  | 'github-tag'
  | 'github-tag-commit'
  | 'github-classification'
  | 'github-assets'
  | 'ghcr-tags'
  | 'ghcr-revision'
  | 'mcp-registry';

export interface ReleaseVerificationCheck {
  id: ReleaseVerificationCheckId;
  status: ReleaseVerificationCheckStatus;
  expected: unknown;
  actual: unknown;
  message?: string;
}

export interface ReleaseVerificationReport {
  ok: boolean;
  checks: ReleaseVerificationCheck[];
  failures: ReleaseVerificationCheck[];
}

function check(
  id: ReleaseVerificationCheckId,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  message?: string,
): ReleaseVerificationCheck {
  return {
    id,
    status: passed ? 'passed' : 'failed',
    expected,
    actual,
    ...(message ? { message } : {}),
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStringSet(expected: readonly string[], actual: readonly string[]): boolean {
  const normalizedExpected = sortedUnique(expected);
  const normalizedActual = sortedUnique(actual);
  return (
    normalizedExpected.length === normalizedActual.length &&
    normalizedExpected.every((value, index) => value === normalizedActual[index])
  );
}

export function verifyPublishedReleaseObservation(
  expectation: ReleaseVerificationExpectation,
  observation: ReleaseVerificationObservation,
): ReleaseVerificationReport {
  const expectedPrerelease = expectation.channel === 'prerelease';
  const assetByName = new Map(observation.github.assets.map((asset) => [asset.name, asset]));
  const missingOrUndigestedAssets = expectation.requiredAssets.filter((name) => {
    const asset = assetByName.get(name);
    return !asset || typeof asset.digest !== 'string' || asset.digest.trim().length === 0;
  });

  const provenancePassed =
    observation.npm.provenance === 'passed' || observation.npm.workflowContextProof === true;
  const provenanceActual = {
    registry: observation.npm.provenance,
    workflowContextProof: observation.npm.workflowContextProof === true,
  };

  const ghcrDigestPresent =
    typeof observation.ghcr.digest === 'string' && observation.ghcr.digest.trim().length > 0;
  const ghcrTagsMatch = sameStringSet(expectation.requiredGhcrTags, observation.ghcr.tags);

  const mcpPassed =
    expectation.channel === 'stable'
      ? observation.mcpRegistry?.version === expectation.version &&
        observation.mcpRegistry?.isLatest === true
      : observation.mcpRegistry === null;

  const checks: ReleaseVerificationCheck[] = [
    check(
      'npm-version',
      observation.npm.version === expectation.version,
      expectation.version,
      observation.npm.version,
      'The exact npm package version must match the release version.',
    ),
    check(
      'npm-dist-tag',
      observation.npm.distTags[expectation.npmDistTag] === expectation.version,
      { [expectation.npmDistTag]: expectation.version },
      { [expectation.npmDistTag]: observation.npm.distTags[expectation.npmDistTag] },
      'The channel-specific npm dist-tag must point to the exact release version.',
    ),
    check(
      'npm-provenance',
      provenancePassed,
      'registry provenance passed or workflow-context proof present',
      provenanceActual,
      'The npm package must have registry provenance or verified workflow-context proof.',
    ),
    check(
      'github-tag',
      observation.github.tag === expectation.tag,
      expectation.tag,
      observation.github.tag,
      'The GitHub Release tag must match the expected immutable release tag.',
    ),
    check(
      'github-tag-commit',
      observation.github.tagCommitSha === expectation.commitSha,
      expectation.commitSha,
      observation.github.tagCommitSha,
      'The release tag must resolve to the expected candidate commit.',
    ),
    check(
      'github-classification',
      observation.github.isDraft === false &&
        observation.github.isPrerelease === expectedPrerelease,
      { isDraft: false, isPrerelease: expectedPrerelease },
      {
        isDraft: observation.github.isDraft,
        isPrerelease: observation.github.isPrerelease,
      },
      'The GitHub Release draft/prerelease classification must match the channel.',
    ),
    check(
      'github-assets',
      missingOrUndigestedAssets.length === 0,
      expectation.requiredAssets,
      observation.github.assets,
      missingOrUndigestedAssets.length > 0
        ? `Missing or undigested assets: ${missingOrUndigestedAssets.join(', ')}`
        : undefined,
    ),
    check(
      'ghcr-tags',
      ghcrDigestPresent && ghcrTagsMatch,
      { digest: 'non-empty', tags: sortedUnique(expectation.requiredGhcrTags) },
      { digest: observation.ghcr.digest, tags: sortedUnique(observation.ghcr.tags) },
      'All exact and moving GHCR tags must resolve to one non-empty image digest.',
    ),
    check(
      'ghcr-revision',
      observation.ghcr.revision === expectation.commitSha,
      expectation.commitSha,
      observation.ghcr.revision,
      'The published image revision label must identify the immutable release commit.',
    ),
    check(
      'mcp-registry',
      mcpPassed,
      expectation.channel === 'stable' ? { version: expectation.version, isLatest: true } : null,
      observation.mcpRegistry,
      expectation.channel === 'stable'
        ? 'Stable releases must be present in the MCP Registry and marked latest.'
        : 'Prereleases must not be published to the MCP Registry.',
    ),
  ];

  const failures = checks.filter((item) => item.status === 'failed');
  return {
    ok: failures.length === 0,
    checks,
    failures,
  };
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const PRERELEASE_VERSION = /^(\d+\.\d+\.\d+)-[0-9A-Za-z][0-9A-Za-z.-]*$/;
const RELEASE_AS = /^Release-As:\s*(\d+\.\d+\.\d+)\s*$/m;

export function evaluateReleasePleaseEligibility(version, commitMessage) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package version must be a non-empty string');
  }
  if (STABLE_VERSION.test(version)) {
    return { run: true, reason: 'stable-version', currentVersion: version };
  }

  const prerelease = PRERELEASE_VERSION.exec(version);
  if (!prerelease?.[1]) {
    throw new Error(`unsupported package version for Release Please eligibility: ${version}`);
  }

  const marker = RELEASE_AS.exec(String(commitMessage ?? ''));
  if (!marker?.[1]) {
    return {
      run: false,
      reason: 'prerelease-awaiting-explicit-promotion',
      currentVersion: version,
      expectedStableVersion: prerelease[1],
    };
  }
  if (marker[1] !== prerelease[1]) {
    throw new Error(
      `Release-As ${marker[1]} does not match prerelease base ${prerelease[1]} for ${version}`,
    );
  }

  return {
    run: true,
    reason: 'explicit-prerelease-promotion',
    currentVersion: version,
    targetVersion: marker[1],
  };
}

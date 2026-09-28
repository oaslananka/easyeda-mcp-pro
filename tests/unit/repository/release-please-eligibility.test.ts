import { describe, expect, it } from 'vitest';

import { evaluateReleasePleaseEligibility } from '../../../scripts/release-please-eligibility.mjs';

describe('Release Please eligibility', () => {
  it('runs normally while repository metadata is stable', () => {
    expect(evaluateReleasePleaseEligibility('1.0.1', 'fix: repair output')).toEqual({
      run: true,
      reason: 'stable-version',
      currentVersion: '1.0.1',
    });
  });

  it('keeps stable Release Please dormant while main is a prerelease candidate', () => {
    expect(evaluateReleasePleaseEligibility('1.1.0-rc.2', 'ci: update action pin')).toEqual({
      run: false,
      reason: 'prerelease-awaiting-explicit-promotion',
      currentVersion: '1.1.0-rc.2',
      expectedStableVersion: '1.1.0',
    });
  });

  it('allows an explicit promotion marker that matches the prerelease base', () => {
    expect(
      evaluateReleasePleaseEligibility(
        '1.1.0-rc.2',
        'chore: promote validated candidate\n\nRelease-As: 1.1.0\n',
      ),
    ).toEqual({
      run: true,
      reason: 'explicit-prerelease-promotion',
      currentVersion: '1.1.0-rc.2',
      targetVersion: '1.1.0',
    });
  });

  it('rejects a promotion marker that does not match the prerelease base', () => {
    expect(() => evaluateReleasePleaseEligibility('1.1.0-rc.2', 'Release-As: 1.2.0')).toThrow(
      'Release-As 1.2.0 does not match prerelease base 1.1.0',
    );
  });

  it('rejects unsupported version identities instead of guessing', () => {
    expect(() => evaluateReleasePleaseEligibility('next', 'Release-As: 1.1.0')).toThrow(
      'unsupported package version',
    );
  });
});

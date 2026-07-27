import { describe, expect, it } from 'vitest';
import {
  MINIMUM_ZIP_EPOCH_SECONDS,
  resolveReproducibleEpochSeconds,
} from '../../../easyeda-bridge-extension/scripts/reproducible-time.mjs';

describe('extension reproducible time policy', () => {
  it('prefers a valid SOURCE_DATE_EPOCH', () => {
    expect(
      resolveReproducibleEpochSeconds({
        sourceDateEpoch: '1700000000',
        gitCommitEpoch: '1600000000',
      }),
    ).toBe(1700000000);
  });

  it('uses the Git commit timestamp when SOURCE_DATE_EPOCH is absent', () => {
    expect(
      resolveReproducibleEpochSeconds({
        sourceDateEpoch: undefined,
        gitCommitEpoch: '1600000000',
      }),
    ).toBe(1600000000);
  });

  it('uses the minimum ZIP epoch when neither source is available', () => {
    expect(
      resolveReproducibleEpochSeconds({
        sourceDateEpoch: undefined,
        gitCommitEpoch: undefined,
      }),
    ).toBe(MINIMUM_ZIP_EPOCH_SECONDS);
  });

  it('clamps timestamps before 1980 to the ZIP-compatible minimum', () => {
    expect(
      resolveReproducibleEpochSeconds({
        sourceDateEpoch: '1',
        gitCommitEpoch: undefined,
      }),
    ).toBe(MINIMUM_ZIP_EPOCH_SECONDS);
  });

  it('rejects an invalid SOURCE_DATE_EPOCH instead of silently using wall-clock time', () => {
    expect(() =>
      resolveReproducibleEpochSeconds({
        sourceDateEpoch: 'not-a-number',
        gitCommitEpoch: '1600000000',
      }),
    ).toThrow('SOURCE_DATE_EPOCH must be an integer number of seconds');
  });
});

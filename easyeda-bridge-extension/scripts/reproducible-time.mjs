import { execFileSync } from 'node:child_process';

export const MINIMUM_ZIP_EPOCH_SECONDS = 315532800;

function parseEpochSeconds(value, sourceName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d+$/.test(String(value))) {
    throw new TypeError(`${sourceName} must be an integer number of seconds`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${sourceName} must be a safe integer number of seconds`);
  }
  return Math.max(parsed, MINIMUM_ZIP_EPOCH_SECONDS);
}

export function resolveReproducibleEpochSeconds({ sourceDateEpoch, gitCommitEpoch }) {
  const sourceEpoch = parseEpochSeconds(sourceDateEpoch, 'SOURCE_DATE_EPOCH');
  if (sourceEpoch !== undefined) return sourceEpoch;

  try {
    const gitEpoch = parseEpochSeconds(gitCommitEpoch, 'Git commit timestamp');
    if (gitEpoch !== undefined) return gitEpoch;
  } catch {
    // An unavailable or malformed Git timestamp must not reintroduce wall-clock time.
  }

  return MINIMUM_ZIP_EPOCH_SECONDS;
}

export function getReproducibleDate({ root, env = process.env, execute = execFileSync }) {
  let gitCommitEpoch;
  if (env.SOURCE_DATE_EPOCH === undefined) {
    try {
      gitCommitEpoch = execute('git', ['-C', root, 'log', '-1', '--format=%ct'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      gitCommitEpoch = undefined;
    }
  }

  const epochSeconds = resolveReproducibleEpochSeconds({
    sourceDateEpoch: env.SOURCE_DATE_EPOCH,
    gitCommitEpoch,
  });
  return new Date(epochSeconds * 1000);
}

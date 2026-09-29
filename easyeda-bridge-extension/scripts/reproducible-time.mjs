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

export function resolveReproducibleEpochSeconds({ sourceDateEpoch }) {
  const sourceEpoch = parseEpochSeconds(sourceDateEpoch, 'SOURCE_DATE_EPOCH');
  if (sourceEpoch !== undefined) return sourceEpoch;

  // The fallback must be independent of Git identity. A reviewed candidate can
  // be squash-merged onto main without changing its source tree, and the
  // resulting release artifact must remain byte-identical to the artifact that
  // passed live EasyEDA validation.
  return MINIMUM_ZIP_EPOCH_SECONDS;
}

export function getReproducibleDate({ env = process.env } = {}) {
  const epochSeconds = resolveReproducibleEpochSeconds({
    sourceDateEpoch: env.SOURCE_DATE_EPOCH,
  });
  return new Date(epochSeconds * 1000);
}

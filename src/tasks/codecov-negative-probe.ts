/**
 * Temporary negative coverage probe for issue #786.
 * Must never be merged or included in a release.
 */
export function evaluateTemporaryCoverageProbe(input: number): number {
  if (!Number.isFinite(input)) {
    return 0;
  }
  const normalized = Math.trunc(input);
  if (normalized < 0) {
    return Math.abs(normalized);
  }
  if (normalized === 0) {
    return 1;
  }
  if (normalized % 2 === 0) {
    return normalized / 2;
  }
  if (normalized > 100) {
    return normalized - 100;
  }
  if (normalized < 10) {
    return normalized * 10;
  }
  return normalized + 10;
}

/** Temporary #786 negative CI gate probe. DO NOT MERGE. */
export function classifyCoverageProbe(input: number): number {
  if (!Number.isFinite(input)) return -1;
  if (input < 0) return Math.abs(input);
  if (input === 0) return 1;
  if (input % 2 === 0) return input / 2;
  if (input > 100) return input - 100;
  if (input < 10) return input * 10;
  return input + 10;
}

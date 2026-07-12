/**
 * Small bounded read-after-write helper for EasyEDA bridge observations.
 * EasyEDA can publish a freshly-created primitive one bridge tick later, so
 * one empty read is not sufficient evidence that a design is empty.
 */

export interface StableReadOptions<T = unknown> {
  attempts?: number;
  delayMs?: number;
  fingerprint?: (value: T) => string;
}

export interface StableReadResult<T> {
  value: T;
  attempts: number;
  stable: boolean;
}

function defaultFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readStable<T>(
  reader: () => Promise<T>,
  options: StableReadOptions<T> = {},
): Promise<StableReadResult<T>> {
  const attemptsLimit = Math.max(2, Math.min(options.attempts ?? 4, 8));
  const delayMs = Math.max(0, Math.min(options.delayMs ?? 80, 1000));
  const fingerprint = options.fingerprint ?? defaultFingerprint;

  let previousFingerprint: string | undefined;
  let lastValue: T | undefined;
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    lastValue = await reader();
    const currentFingerprint = fingerprint(lastValue);
    if (previousFingerprint !== undefined && currentFingerprint === previousFingerprint) {
      return { value: lastValue, attempts: attempt, stable: true };
    }
    previousFingerprint = currentFingerprint;
    if (attempt < attemptsLimit && delayMs > 0) await wait(delayMs);
  }

  return {
    value: lastValue as T,
    attempts: attemptsLimit,
    stable: false,
  };
}

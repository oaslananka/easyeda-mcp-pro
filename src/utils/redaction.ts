const SECRET_PATTERNS: Array<RegExp> = [
  /(api[_-]?key\s*[:=]\s*)(['"]?[a-zA-Z0-9_-]+['"]?)/gi,
  /(client[_-]?secret\s*[:=]\s*)(['"]?[a-zA-Z0-9_-]+['"]?)/gi,
  /(token\s*[:=]\s*)(['"]?[a-zA-Z0-9_\-.:=]+['"]?)/gi,
  /(password\s*[:=]\s*)(['"]?[^\s'"]+['"]?)/gi,
  /(bearer\s+)([a-zA-Z0-9_\-.:=]+)/gi,
  /(-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/gi,
  /(authorization:\s*bearer\s+)([a-zA-Z0-9_\-.:=]+)/gi,
];

export function redactSecrets(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => {
      return `${prefix}[REDACTED]`;
    });
  }
  return result;
}

// Log objects can include nested arrays and native Errors. Preserve useful
// diagnostic metadata while removing credentials and bounding cyclic inputs.
function redactObjectValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return redactObjectValue(
      { type: value.name, message: value.message, stack: value.stack },
      seen,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => redactObjectValue(entry, seen));
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    redacted[key] =
      lowerKey.includes('key') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('password') ||
      lowerKey.includes('credential') ||
      lowerKey === 'authorization' ||
      lowerKey === 'cookie'
        ? '[REDACTED]'
        : redactObjectValue(item, seen);
  }
  return redacted;
}

export function redactObject<T>(obj: T): T {
  return redactObjectValue(obj, new WeakSet<object>()) as T;
}

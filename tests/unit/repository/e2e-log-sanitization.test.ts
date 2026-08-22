import { describe, expect, it } from 'vitest';

import { sanitizeLogFragment } from '../../../scripts/e2e/log-sanitization.mjs';

describe('E2E diagnostic log sanitization', () => {
  it('escapes ANSI and C0/C1 control characters instead of emitting terminal controls', () => {
    const input = `ok\u001b[31mred\u001b[0m\nnext\u009b31m`;
    const result = sanitizeLogFragment(input, 200);

    expect(result).toContain('ok\\u001b[31mred\\u001b[0m\\u000anext\\u009b31m');
    expect(
      [...result].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }),
    ).toBe(false);
  });

  it('truncates before escaping so diagnostics stay bounded', () => {
    expect(sanitizeLogFragment('abcdef', 3)).toBe('abc');
  });

  it('preserves ordinary printable diagnostic text', () => {
    expect(sanitizeLogFragment('bridge connected: Fixture', 100)).toBe('bridge connected: Fixture');
  });

  it('rejects invalid length limits', () => {
    expect(() => sanitizeLogFragment('x', 0)).toThrow('positive integer');
    expect(() => sanitizeLogFragment('x', 1.5)).toThrow('positive integer');
  });
});

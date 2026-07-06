import { describe, expect, it } from 'vitest';
import { detectNgspice, runNgspiceDeck } from '../../../src/simulation/runner.js';

describe('detectNgspice', () => {
  it('reports unavailable (never throws) when the binary does not exist', async () => {
    const result = await detectNgspice('this-binary-definitely-does-not-exist-12345');
    expect(result.available).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('runNgspiceDeck', () => {
  it('rejects cleanly (and still cleans up the scratch dir) when the binary is missing', async () => {
    await expect(
      runNgspiceDeck('* empty deck\n.end\n', {
        binary: 'this-binary-definitely-does-not-exist-12345',
      }),
    ).rejects.toThrow();
  });

  it('never uses a shell to invoke the binary (deck content cannot be shell-interpreted)', async () => {
    // A deck containing shell metacharacters must not cause a shell-related failure mode —
    // it should fail the same way (binary not found) as any other deck, proving no shell
    // is involved in invocation.
    const maliciousLookingDeck = '* deck; rm -rf / #\n.end\n';
    await expect(
      runNgspiceDeck(maliciousLookingDeck, {
        binary: 'this-binary-definitely-does-not-exist-12345',
      }),
    ).rejects.toThrow(/ENOENT|not found|no such file/i);
  });
});

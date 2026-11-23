import { describe, expect, it } from 'vitest';
import { findPhoneLikeContent } from '../../../easyeda-bridge-extension/scripts/marketplace-phone-content.mjs';

const nativeSymbol =
  'libraryUuid: "0819f05c4eef4c71ace90d822a990e87", uuid: "21c0c70348655df0", name: "Netport-IN"';
const compiled = 'var VERIFIED_V4_IN_PORT = Object.freeze({ ' + nativeSymbol + ' });';

describe('marketplace phone-content verification', () => {
  it('accepts only the exact reviewed native symbol identity in the compiled extension', () => {
    expect(findPhoneLikeContent(compiled, 'dist/index.js')).toEqual([]);
  });

  it('accepts the exact reviewed symbol after whitespace-only compression', () => {
    const compact = compiled
      .replaceAll(' = ', '=')
      .replaceAll(': ', ':')
      .replaceAll(', ', ',')
      .replaceAll('{ ', '{')
      .replaceAll(' }', '}');
    expect(findPhoneLikeContent(compact, 'dist/index.js')).toEqual([]);
    expect(findPhoneLikeContent(compact.replace('Netport-IN', 'Other'), 'dist/index.js')).toContain(
      '70348655',
    );
    expect(findPhoneLikeContent(compact + '70348655', 'dist/index.js')).toContain('70348655');
  });

  it.each(['README.md', 'CHANGELOG.md', 'extension.json'])(
    'does not apply the exception to %s',
    (file) => {
      expect(findPhoneLikeContent(compiled, file)).toEqual(['70348655']);
    },
  );

  it('still detects a real phone-like value beside the known identity', () => {
    expect(
      findPhoneLikeContent(compiled + '\\nconst contact = "+90 555 123 45 67";', 'dist/index.js'),
    ).toContain('+90 555 123 45 67');
  });

  it.each([
    ['unknown symbol UUID', compiled.replace('21c0c70348655df0', '21c0c70348656df0')],
    ['wrong library', compiled.replace('0819f05c4eef4c71ace90d822a990e87', 'wrong')],
    ['wrong symbol name', compiled.replace('Netport-IN', 'Other')],
    ['standalone numeric run', '70348655'],
    ['longer UUID', compiled.replace('21c0c70348655df0', '21c0c70348655df00')],
  ])('does not exempt %s', (_, text) => {
    expect(findPhoneLikeContent(text, 'dist/index.js').length).toBeGreaterThan(0);
  });
});

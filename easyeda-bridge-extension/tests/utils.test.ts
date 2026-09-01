import { describe, expect, it, vi } from 'vitest';
import { readPath } from '../src/utils.js';

describe('readPath', () => {
  it('reads own nested properties', () => {
    expect(readPath({ api: { version: '1' } }, 'api.version')).toBe('1');
  });

  it('preserves own accessor behavior without traversing prototypes', () => {
    const source = {
      get version() {
        return '1.0';
      },
    };

    expect(readPath(source, 'version')).toBe('1.0');
  });

  it('fails closed when an own accessor throws', () => {
    const source = Object.defineProperty({}, 'broken', {
      get() {
        throw new Error('getter failed');
      },
    });

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(readPath(source, 'broken')).toBeUndefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('preserves safe inherited property access without allowing dangerous segments', () => {
    const inherited = { inheritedValue: 'prototype-value' };
    const source = Object.create(inherited) as Record<string, unknown>;
    source.own = 'ok';

    expect(readPath(source, 'own')).toBe('ok');
    expect(readPath(source, 'inheritedValue')).toBe('prototype-value');
  });

  it('invokes inherited accessors with the original receiver', () => {
    const prototype = Object.defineProperty({}, 'label', {
      get(this: { own?: string }) {
        return this.own;
      },
    });
    const source = Object.create(prototype) as Record<string, unknown>;
    source.own = 'receiver-value';

    expect(readPath(source, 'label')).toBe('receiver-value');
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects dangerous path segment %s',
    (segment) => {
      expect(readPath({ safe: {} }, segment)).toBeUndefined();
      expect(readPath({ safe: {} }, `safe.${segment}`)).toBeUndefined();
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import {
  compactPrimitiveSummary,
  getFunctionNames,
  isAllowedApiClassName,
  isAllowedApiPath,
  normalizeApiClassName,
  normalizeStandalone,
  normalizeValue,
  readMember,
  readStateValue,
  withClassNameVariants,
} from '../src/api-introspection.js';

describe('API introspection policy', () => {
  it('normalizes EasyEDA class prefixes and generates stable variants', () => {
    expect(normalizeApiClassName('sch_PrimitiveWire')).toBe('SCH_PrimitiveWire');
    expect(withClassNameVariants(['sch_PrimitiveWire.getAll', 'SCH_PrimitiveWire.getAll'])).toEqual(
      ['sch_PrimitiveWire.getAll', 'SCH_PrimitiveWire.getAll'],
    );
  });

  it('allows only documented EasyEDA class prefixes and safe method names', () => {
    for (const className of [
      'DMT_SelectControl',
      'SCH_PrimitiveWire',
      'PCB_PrimitiveVia',
      'LIB_Device',
    ]) {
      expect(isAllowedApiClassName(className)).toBe(true);
    }
    expect(isAllowedApiClassName('SYS_Shell')).toBe(false);

    expect(isAllowedApiPath('sch_PrimitiveWire.getAll')).toBe(true);
    for (const path of [
      'SYS_Shell.exec',
      'SCH_PrimitiveWire',
      'SCH_PrimitiveWire.getAll.extra',
      '.getAll',
      'SCH_PrimitiveWire.',
      'SCH-PrimitiveWire.getAll',
      'SCH_.getAll',
      'SCH_PrimitiveWire._private',
      'SCH_PrimitiveWire.get-all',
      'SCH_PrimitiveWire.constructor',
      'SCH_PrimitiveWire.prototype',
      'SCH_PrimitiveWire.__defineGetter__',
      'SCH_PrimitiveWire.__defineSetter__',
      'SCH_PrimitiveWire.__proto__',
    ]) {
      expect(isAllowedApiPath(path)).toBe(false);
    }
  });

  it('keeps unmatched and class-only paths stable', () => {
    expect(withClassNameVariants([])).toEqual([]);
    expect(withClassNameVariants([''])).toEqual(['']);
    expect(withClassNameVariants(['NoPrefix.method'])).toEqual(['NoPrefix.method']);
    expect(withClassNameVariants(['sch_PrimitiveWire'])).toEqual([
      'sch_PrimitiveWire',
      'SCH_PrimitiveWire',
    ]);
    expect(normalizeApiClassName('SCH_PrimitiveWire')).toBe('SCH_PrimitiveWire');
  });

  it('normalizes primitives, functions, arrays, and runtime class metadata', () => {
    function namedFunction() {}
    const anonymousFunction = Object.defineProperty(() => undefined, 'name', { value: '' });
    const missingNameFunction = Object.defineProperty(() => undefined, 'name', {
      value: undefined,
    });
    class RuntimeThing {
      value = 4;
      method() {}
    }

    expect(normalizeStandalone(null)).toBeNull();
    expect(normalizeStandalone(undefined)).toBeNull();
    expect(normalizeStandalone('text')).toBe('text');
    expect(normalizeStandalone(2)).toBe(2);
    expect(normalizeStandalone(true)).toBe(true);
    expect(normalizeStandalone(2n)).toBe('2');
    expect(normalizeStandalone(Symbol.for('value'))).toBe('Symbol(value)');
    expect(normalizeStandalone(namedFunction)).toBe('[Function namedFunction]');
    expect(normalizeStandalone(anonymousFunction)).toBe('[Function ]');
    expect(normalizeStandalone(missingNameFunction)).toBe('[Function anonymous]');
    expect(normalizeStandalone([1, { nested: true }])).toEqual([1, { nested: true }]);
    expect(normalizeStandalone(new RuntimeThing())).toMatchObject({
      __class: 'RuntimeThing',
      __methods: expect.arrayContaining(['method']),
      value: 4,
    });
  });

  it('preserves state, methods, repeated references, cycles, and depth bounds', () => {
    const shared = { value: 7 };
    const wrapper = {
      first: shared,
      second: shared,
      getState_PrimitiveId: () => 'wire-1',
      helper() {},
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(normalizeValue(wrapper, 5)).toMatchObject({
      first: { value: 7 },
      second: { value: 7 },
      state: { PrimitiveId: 'wire-1' },
      __methods: expect.arrayContaining(['getState_PrimitiveId', 'helper']),
    });
    expect(normalizeStandalone(cycle, 4)).toEqual({ self: '[Circular]' });
    expect(normalizeStandalone({ nested: { value: 1 } }, 1)).toEqual({
      nested: '[MaxDepth]',
    });
  });

  it('skips a state getter that disappears between discovery and invocation', () => {
    let reads = 0;
    const source = new Proxy(
      {
        getState_Name: () => 'visible-on-first-read',
      },
      {
        get(target, key, receiver) {
          if (key === 'getState_Name') {
            reads += 1;
            return reads === 1 ? Reflect.get(target, key, receiver) : undefined;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );

    expect(normalizeStandalone(source, 4)).toEqual({
      state: {},
      getState_Name: null,
    });
  });

  it('returns undefined for absent members and state getters', () => {
    expect(readMember(null, 'missing')).toBeUndefined();
    expect(readMember({}, 'missing')).toBeUndefined();
    expect(readStateValue({}, 'Missing')).toBeUndefined();
    expect(getFunctionNames({ value: 1 })).toEqual([]);
  });

  it('bounds reflective failures without escaping the bridge', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ownKeysFailure = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('own keys blocked');
        },
      },
    );
    const prototypeFailure = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype blocked');
        },
      },
    );

    expect(getFunctionNames(ownKeysFailure)).toEqual([]);
    expect(getFunctionNames(prototypeFailure)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('handles throwing members and state getters without escaping the bridge', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const normalized = normalizeStandalone({
      getState_Name: () => {
        throw new Error('normalized state blocked');
      },
    });
    expect(normalized).toMatchObject({
      state: { Name: 'ERROR: Error: normalized state blocked' },
      __methods: ['getState_Name'],
    });
    const source = Object.create(null, {
      dangerous: {
        get: () => {
          throw new Error('blocked');
        },
      },
      getState_Name: {
        value: () => {
          throw new Error('state blocked');
        },
      },
    });

    expect(readMember(source, 'dangerous')).toBeUndefined();
    expect(readStateValue(source, 'Name')).toBe('ERROR: Error: state blocked');
    expect(compactPrimitiveSummary(source, ['Name'])).toEqual({
      Name: 'ERROR: Error: state blocked',
    });
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

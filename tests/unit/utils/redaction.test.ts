import { describe, it, expect } from 'vitest';
import { redactSecrets, redactObject } from '../../../src/utils/redaction.js';

describe('redactSecrets', () => {
  it('should redact API keys', () => {
    const result = redactSecrets('api_key=TEST_VALUE');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('TEST_VALUE');
  });

  it('should redact tokens', () => {
    const result = redactSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');
    expect(result).toContain('[REDACTED]');
  });

  it('should redact private keys', () => {
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const result = redactSecrets(`${begin}\nABCDEF1234\n${end}`);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ABCDEF1234');
  });

  it('should handle strings without secrets', () => {
    const result = redactSecrets('hello world');
    expect(result).toBe('hello world');
  });
});

describe('redactObject', () => {
  it('should redact keys with secret-like names', () => {
    const obj = {
      name: 'test',
      api_key: 'secret123',
      token: 'abc',
      normal_field: 'visible',
    };
    const result = redactObject(obj);
    expect(result.api_key).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.normal_field).toBe('visible');
  });

  it('should recursively redact nested objects', () => {
    const obj = {
      config: {
        apiKey: 'super-secret',
        host: 'localhost',
      },
    };
    const result = redactObject(obj) as typeof obj;
    expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.host).toBe('localhost');
  });

  it('should return primitives as-is', () => {
    expect(redactObject('hello')).toBe('hello');
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
  });

  it('should redact secrets in strings within arrays', () => {
    const arr = ['api_key=my-secret-key', 'normal string'];
    const result = redactObject(arr) as string[];
    expect(result[0]).toContain('[REDACTED]');
    expect(result[0]).not.toContain('my-secret-key');
    expect(result[1]).toBe('normal string');
  });
});

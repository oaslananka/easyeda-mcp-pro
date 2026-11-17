import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { createLogger, getLogger } from '../../../src/utils/logger.js';

describe('Logger Utility', () => {
  it('never writes nested credentials or bearer tokens embedded in error messages', () => {
    // Isolate the Pino singleton and exercise the real production logger,
    // without a live credential or an external logging service.
    const script = `
      import { createLogger } from './src/utils/logger.ts';
      const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'production' });
      logger.error({
        nested: { accessToken: 'FAKE_NESTED_CREDENTIAL_849' },
        attempts: [{ authorization: 'Bearer FAKE_ARRAY_CREDENTIAL_849' }],
        err: new Error('Bearer FAKE_ERROR_CREDENTIAL_849'),
        tool: 'easyeda_pcb_components',
      }, 'rejected credential-bearing request');
      logger.warn('Bearer FAKE_MESSAGE_CREDENTIAL_849');
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('FAKE_NESTED_CREDENTIAL_849');
    expect(result.stdout).not.toContain('FAKE_ARRAY_CREDENTIAL_849');
    expect(result.stdout).not.toContain('FAKE_ERROR_CREDENTIAL_849');
    expect(result.stdout).not.toContain('FAKE_MESSAGE_CREDENTIAL_849');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).toContain('easyeda_pcb_components');
    expect(result.stdout).toContain('stack');
  });

  it('createLogger creates a pino logger instance', () => {
    const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('getLogger returns the singleton logger', () => {
    const logger = getLogger();

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('getLogger throws if not initialized', async () => {
    vi.resetModules();
    const { getLogger: getLoggerFresh } = await import('../../../src/utils/logger.js');

    expect(() => getLoggerFresh()).toThrow('Logger not initialized. Call createLogger first.');

    // Restore logger for subsequent tests in this file
    const { createLogger: createLoggerFresh } = await import('../../../src/utils/logger.js');
    createLoggerFresh({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
  });

  it('Logger has correct log level from config', async () => {
    vi.resetModules();
    // Import fresh module to test log level initialization
    const loggerModule = await import('../../../src/utils/logger.js');
    const freshLogger = loggerModule.createLogger({ LOG_LEVEL: 'debug', NODE_ENV: 'test' });

    expect(freshLogger.level).toBe('debug');

    // Restore silent logger for other tests
    loggerModule.createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
  });
});

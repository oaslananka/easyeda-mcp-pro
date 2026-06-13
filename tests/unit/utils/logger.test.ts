import { describe, it, expect, vi } from 'vitest';
import { createLogger, getLogger } from '../../../src/utils/logger.js';

describe('Logger Utility', () => {
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

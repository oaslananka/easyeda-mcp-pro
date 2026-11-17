import pino from 'pino';
import { type EnvConfig } from '../config/env.js';
import { redactObject, redactSecrets } from './redaction.js';

let loggerInstance: pino.Logger | null = null;

export function createLogger(config: Pick<EnvConfig, 'LOG_LEVEL' | 'NODE_ENV'>): pino.Logger {
  if (loggerInstance) return loggerInstance;

  const pinoOpts: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV !== 'production'
      ? { transport: { target: 'pino/file', options: { destination: 2 } } }
      : {}),
    redact: {
      paths: [
        'apiKey',
        'api_key',
        'API_KEY',
        'clientSecret',
        'client_secret',
        'CLIENT_SECRET',
        'token',
        'TOKEN',
        'sessionToken',
        'session_token',
        'password',
        'PASSWORD',
        'authorization',
        'AUTHORIZATION',
        'cookie',
        'COOKIE',
        'jwt',
        'JWT',
        'secret',
        'SECRET',
        'key',
        'KEY',
        'credential',
        'CREDENTIAL',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    formatters: {
      log: (value) => redactObject(value),
    },
    hooks: {
      logMethod(inputArgs, method) {
        // Pino's field redaction doesn't sanitize an interpolated log
        // message. Keep runtime diagnostics while masking bearer strings.
        method.apply(
          this,
          inputArgs.map((arg) => (typeof arg === 'string' ? redactSecrets(arg) : arg)) as [
            obj: unknown,
            msg?: string,
            ...args: unknown[],
          ],
        );
      },
    },
  };

  loggerInstance = pino(pinoOpts);

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    throw new Error('Logger not initialized. Call createLogger first.');
  }
  return loggerInstance;
}

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { EnvSchema, getEnvironmentVariableNames } from '../src/config/env.js';
import {
  applyRegistryEnvironmentVariables,
  buildRegistryEnvironmentVariables,
  loadEnvironmentMetadata,
  serializeServerJson,
  validateEnvironmentMetadata,
} from './environment-metadata.mts';

interface GenerateOptions {
  check: boolean;
  repositoryRoot?: string;
}

function parseArgs(argv: string[]): GenerateOptions {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === '--check') return { check: true };
  throw new Error(`Unexpected arguments: ${argv.join(' ')}`);
}

function formatValidationErrors(errors: string[]): string {
  const details = errors.map((error) => `  - ${error}`).join('\n');
  return `Environment metadata validation failed:\n${details}`;
}

function describeAction(check: boolean, changed: boolean): string {
  if (check) return 'Environment metadata parity check passed';
  if (changed) return 'Generated server.json environment metadata';
  return 'server.json environment metadata is already current';
}

export async function generateServerEnvironmentMetadata({
  check,
  repositoryRoot = path.resolve(import.meta.dirname, '..'),
}: GenerateOptions): Promise<{ changed: boolean; count: number }> {
  const metadata = loadEnvironmentMetadata(repositoryRoot);
  const runtimeDefaults = EnvSchema.parse({});
  const runtimeNames = getEnvironmentVariableNames();
  const validationErrors = validateEnvironmentMetadata({
    metadata,
    runtimeDefaults,
    runtimeNames,
  });
  if (validationErrors.length > 0) {
    throw new Error(formatValidationErrors(validationErrors));
  }

  const serverPath = path.join(repositoryRoot, 'server.json');
  const currentText = fs.readFileSync(serverPath, 'utf8');
  const currentServer = JSON.parse(currentText) as Record<string, unknown>;
  const variables = buildRegistryEnvironmentVariables(metadata, runtimeDefaults);
  const generatedServer = applyRegistryEnvironmentVariables(currentServer, variables);
  const prettierConfig = await resolveConfig(serverPath);
  const generatedText = await format(serializeServerJson(generatedServer), {
    ...prettierConfig,
    filepath: serverPath,
  });
  const changed = generatedText !== currentText;

  if (check && changed) {
    throw new Error(
      'server.json environmentVariables are stale. Run `pnpm generate:environment-metadata` and commit the result.',
    );
  }
  if (!check && changed) {
    const temporaryPath = `${serverPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, generatedText, 'utf8');
    fs.renameSync(temporaryPath, serverPath);
  }

  return { changed, count: variables.length };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
}

if (isDirectExecution()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await generateServerEnvironmentMetadata(options);
    const action = describeAction(options.check, result.changed);
    console.log(`${action}: ${result.count} public variables.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

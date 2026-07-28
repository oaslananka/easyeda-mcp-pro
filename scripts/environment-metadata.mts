import fs from 'node:fs';
import path from 'node:path';

export type RegistryInputFormat = 'string' | 'number' | 'boolean' | 'filepath';
export type EnvironmentVariableStatus = 'active' | 'experimental' | 'reserved';
export type EnvironmentDefaultSource = 'runtime' | 'dynamic';

export interface EnvironmentMetadataVariable {
  name: string;
  description: string;
  format: RegistryInputFormat;
  defaultSource: EnvironmentDefaultSource;
  status: EnvironmentVariableStatus;
  choices?: string[];
  placeholder?: string;
  isSecret?: boolean;
}

export interface ExcludedEnvironmentVariable {
  name: string;
  classification: 'development-only';
  reason: string;
}

export interface EnvironmentMetadataInventory {
  schemaVersion: 1;
  excludedVariables: ExcludedEnvironmentVariable[];
  variables: EnvironmentMetadataVariable[];
}

export interface RegistryEnvironmentVariable {
  name: string;
  description: string;
  isRequired: false;
  format: RegistryInputFormat;
  default?: string;
  choices?: string[];
  placeholder?: string;
  isSecret?: true;
}

interface ValidationInput {
  metadata: EnvironmentMetadataInventory;
  runtimeDefaults: Record<string, unknown>;
  runtimeNames: readonly string[];
}

const VALID_NAME = /^[A-Z][A-Z0-9_]*$/;
const VALID_FORMATS = new Set<RegistryInputFormat>(['string', 'number', 'boolean', 'filepath']);
const VALID_STATUSES = new Set<EnvironmentVariableStatus>(['active', 'experimental', 'reserved']);

function duplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].sort();
}

function expectedFormat(value: unknown): Exclude<RegistryInputFormat, 'filepath'> {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

export function loadEnvironmentMetadata(
  repositoryRoot = path.resolve(import.meta.dirname, '..'),
): EnvironmentMetadataInventory {
  const metadataPath = path.join(repositoryRoot, 'config', 'environment-metadata.json');
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as EnvironmentMetadataInventory;
}

export function validateEnvironmentMetadata({
  metadata,
  runtimeDefaults,
  runtimeNames,
}: ValidationInput): string[] {
  const errors: string[] = [];

  if (metadata.schemaVersion !== 1) {
    errors.push(
      `Unsupported environment metadata schemaVersion: ${String(metadata.schemaVersion)}`,
    );
  }
  if (!Array.isArray(metadata.variables)) errors.push('variables must be an array.');
  if (!Array.isArray(metadata.excludedVariables)) {
    errors.push('excludedVariables must be an array.');
  }
  if (errors.length > 0) return errors;

  const publicNames = metadata.variables.map((variable) => variable.name);
  const excludedNames = metadata.excludedVariables.map((variable) => variable.name);
  const runtimeNameSet = new Set(runtimeNames);
  const publicNameSet = new Set(publicNames);
  const excludedNameSet = new Set(excludedNames);

  for (const name of duplicateNames(publicNames)) {
    errors.push(`Duplicate public environment variable metadata: ${name}`);
  }
  for (const name of duplicateNames(excludedNames)) {
    errors.push(`Duplicate excluded environment variable metadata: ${name}`);
  }
  for (const name of publicNames) {
    if (excludedNameSet.has(name)) errors.push(`${name} is both public and excluded.`);
    if (!runtimeNameSet.has(name))
      errors.push(`Public metadata key ${name} is absent from EnvSchema.`);
  }
  for (const name of excludedNames) {
    if (!runtimeNameSet.has(name)) errors.push(`Excluded key ${name} is absent from EnvSchema.`);
  }
  for (const name of runtimeNames) {
    if (!publicNameSet.has(name) && !excludedNameSet.has(name)) {
      errors.push(`EnvSchema key ${name} is neither public nor explicitly excluded.`);
    }
  }

  for (const variable of metadata.variables) {
    const prefix = variable.name || '<unnamed>';
    if (!VALID_NAME.test(variable.name)) errors.push(`${prefix} has an invalid name.`);
    if (!variable.description?.trim()) errors.push(`${prefix} requires a description.`);
    if (!VALID_FORMATS.has(variable.format))
      errors.push(`${prefix} has invalid format ${variable.format}.`);
    if (!VALID_STATUSES.has(variable.status))
      errors.push(`${prefix} has invalid status ${variable.status}.`);
    if (!['runtime', 'dynamic'].includes(variable.defaultSource)) {
      errors.push(`${prefix} has invalid defaultSource ${variable.defaultSource}.`);
    }
    if (
      variable.status === 'reserved' &&
      !variable.description.startsWith('Reserved; currently non-functional:')
    ) {
      errors.push(
        `${prefix} is reserved but its description does not identify it as non-functional.`,
      );
    }
    if (variable.defaultSource === 'dynamic') {
      if (!variable.placeholder?.trim())
        errors.push(`${prefix} requires a dynamic-default placeholder.`);
      if (variable.format !== 'filepath')
        errors.push(`${prefix} dynamic defaults must use filepath format.`);
    } else {
      if (!(variable.name in runtimeDefaults)) {
        errors.push(`${prefix} has no runtime default.`);
      } else {
        const format = expectedFormat(runtimeDefaults[variable.name]);
        if (variable.format !== format) {
          errors.push(`${prefix} format ${variable.format} does not match runtime type ${format}.`);
        }
      }
    }
    if (variable.choices) {
      if (variable.choices.length === 0) errors.push(`${prefix} choices must not be empty.`);
      if (new Set(variable.choices).size !== variable.choices.length) {
        errors.push(`${prefix} choices contain duplicates.`);
      }
      const defaultValue = runtimeDefaults[variable.name];
      if (
        variable.defaultSource === 'runtime' &&
        !variable.choices.includes(String(defaultValue))
      ) {
        errors.push(`${prefix} runtime default is absent from choices.`);
      }
    }
  }

  for (const excluded of metadata.excludedVariables) {
    const prefix = excluded.name || '<unnamed exclusion>';
    if (!VALID_NAME.test(excluded.name)) errors.push(`${prefix} has an invalid exclusion name.`);
    if (excluded.classification !== 'development-only') {
      errors.push(`${prefix} has unsupported exclusion classification ${excluded.classification}.`);
    }
    if (!excluded.reason?.trim()) errors.push(`${prefix} requires an exclusion reason.`);
  }

  return errors;
}

export function buildRegistryEnvironmentVariables(
  metadata: EnvironmentMetadataInventory,
  runtimeDefaults: Record<string, unknown>,
): RegistryEnvironmentVariable[] {
  return metadata.variables.map((variable) => {
    const output: RegistryEnvironmentVariable = {
      name: variable.name,
      description: variable.description,
      isRequired: false,
      format: variable.format,
    };

    if (variable.defaultSource === 'runtime') {
      output.default = String(runtimeDefaults[variable.name]);
    } else if (variable.placeholder) {
      output.placeholder = variable.placeholder;
    }
    if (variable.choices) output.choices = [...variable.choices];
    if (variable.isSecret) output.isSecret = true;
    return output;
  });
}

export function applyRegistryEnvironmentVariables(
  serverJson: Record<string, unknown>,
  variables: RegistryEnvironmentVariable[],
): Record<string, unknown> {
  const output = structuredClone(serverJson);
  const packages = output.packages;
  if (!Array.isArray(packages) || packages.length === 0 || typeof packages[0] !== 'object') {
    throw new Error('server.json must contain packages[0].');
  }
  (packages[0] as Record<string, unknown>).environmentVariables = structuredClone(variables);
  return output;
}

export function serializeServerJson(serverJson: Record<string, unknown>): string {
  return `${JSON.stringify(serverJson, null, 2)}\n`;
}

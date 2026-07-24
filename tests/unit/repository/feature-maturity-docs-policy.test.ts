import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

const reservedNames = [
  'MCP_TASKS_ENABLED',
  'MCP_APPS_ENABLED',
  'MCP_V2_EXPERIMENTAL',
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_API_KEY',
  'AI_ALLOW_DESIGN_MUTATIONS',
  'OTEL_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
];

describe('feature maturity documentation policy', () => {
  it('marks reserved environment sections as non-functional in the example file', () => {
    const example = read('.env.example');
    expect(example).toContain(
      'Reserved configuration: parsed for compatibility, currently non-functional.',
    );
    expect(example).toContain('Do not supply AI credentials; no provider client is invoked.');
    expect(example).toContain('No OTLP exporter is started.');
  });

  it('marks every reserved server metadata entry explicitly', () => {
    const metadata = JSON.parse(read('server.json')) as unknown;
    const entries: Array<{ name?: string; description?: string }> = [];

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.name === 'string')
        entries.push(record as { name: string; description?: string });
      Object.values(record).forEach(visit);
    };
    visit(metadata);

    for (const name of reservedNames) {
      const entry = entries.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.description, name).toMatch(/^Reserved; currently non-functional:/);
    }
  });

  it('does not instruct users to configure an inactive AI provider', () => {
    const readme = read('README.md');
    expect(readme).toContain('### Reserved AI configuration');
    expect(readme).toContain('No in-process AI provider client is currently implemented');
    expect(readme).not.toContain('Configure an AI provider for LLM-assisted design review');
  });
});

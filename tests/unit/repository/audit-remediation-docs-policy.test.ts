import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('audit remediation architecture record', () => {
  it('records the final bounded modules and remaining large hotspots', () => {
    const design = read('docs/superpowers/specs/2026-07-24-audit-remediation-design.md');
    expect(design).toContain('## Maintainability outcomes');
    expect(design).toContain('easyeda-bridge-extension/src/pcb-primitive-state.ts');
    expect(design).toContain('src/tools/diagnostics-feature-report.ts');
    expect(design).toContain(
      'No public MCP tool name, input schema, output schema, or relay envelope changed',
    );
    expect(design).toContain('Remaining hotspot register');
  });
});

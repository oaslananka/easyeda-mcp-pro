import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('golden eval benchmark', () => {
  it('runs non-live benchmark suite and passes regression policy', () => {
    execFileSync('pnpm', ['eval:golden'], { stdio: 'pipe' });
    const report = JSON.parse(readFileSync('tests/evals/results/latest.json', 'utf8')) as {
      passed: boolean;
      overallScore: number;
      scenarioCount: number;
      failedScenarioCount: number;
      safetyViolationCount: number;
    };

    expect(report.passed).toBe(true);
    expect(report.overallScore).toBeGreaterThanOrEqual(85);
    expect(report.scenarioCount).toBeGreaterThanOrEqual(10);
    expect(report.failedScenarioCount).toBe(0);
    expect(report.safetyViolationCount).toBe(0);
  });
});

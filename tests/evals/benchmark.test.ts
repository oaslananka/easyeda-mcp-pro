import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('golden eval benchmark', () => {
  it('runs non-live benchmark suite and passes regression policy', () => {
    const resultPath = '.easyeda-mcp-pro/evals/vitest-latest.json';
    rmSync(resultPath, { force: true });
    mkdirSync(dirname(resultPath), { recursive: true });
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/run-evals.mts', '--output', resultPath], {
      stdio: 'pipe',
    });
    const report = JSON.parse(readFileSync(resultPath, 'utf8')) as {
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

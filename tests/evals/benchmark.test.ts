import { rmSync } from 'node:fs';
import { runBenchmark } from '../../scripts/run-evals.mts';
import { describe, expect, it } from 'vitest';

describe('golden eval benchmark', () => {
  it('runs non-live benchmark suite and passes regression policy', () => {
    const resultPath = '.easyeda-mcp-pro/evals/vitest-latest.json';
    rmSync(resultPath, { force: true });
    const report = runBenchmark({ outputPath: resultPath });

    expect(report.passed).toBe(true);
    expect(report.overallScore).toBeGreaterThanOrEqual(85);
    expect(report.scenarioCount).toBeGreaterThanOrEqual(10);
    expect(report.failedScenarioCount).toBe(0);
    expect(report.safetyViolationCount).toBe(0);
  });
});

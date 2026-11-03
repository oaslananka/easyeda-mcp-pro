import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildEngineeringReview,
  engineeringReviewSchema,
  type EngineeringReview,
} from '../../../src/engineering-review/report.js';

type ReviewInput = Parameters<typeof buildEngineeringReview>[0];
type Scenario = {
  id: string;
  input: ReviewInput;
  expected: {
    overallStatus: EngineeringReview['overall_status'];
    pcbContext: EngineeringReview['pcb_context'];
    requiredFindings: string[];
    forbiddenFindings: string[];
    minUnknown: number;
    evidence?: { field: string; quality: string; age: string };
  };
};

const scenarios = JSON.parse(
  readFileSync(new URL('../../fixtures/engineering-review/cases.json', import.meta.url), 'utf8'),
) as Scenario[];

describe('engineering evidence golden fixtures', () => {
  it('has unique named, representative scenarios', () => {
    expect(scenarios).toHaveLength(13);
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
  });

  it.each(scenarios)('$id preserves verified versus unknown outcomes', ({ input, expected }) => {
    const report = engineeringReviewSchema.parse(buildEngineeringReview(input));
    expect(report).toEqual(buildEngineeringReview(input));
    expect(report.overall_status).toBe(expected.overallStatus);
    expect(report.pcb_context).toBe(expected.pcbContext);
    expect(report.summary.UNKNOWN).toBeGreaterThanOrEqual(expected.minUnknown);
    expect(report.engineering_sign_off).toBe(false);
    expect(report.groups.unknowns).toContain('coverage:DRC');
    expect(report.groups.unknowns).toContain('coverage:ERC');
    expect(report.groups.unknowns).toContain('coverage:POWER_TREE');
    expect(new Set(report.findings.map((item) => item.id)).size).toBe(report.findings.length);

    const ids = report.findings.map((finding) => finding.id);
    for (const id of expected.requiredFindings) expect(ids).toContain(id);
    for (const id of expected.forbiddenFindings) expect(ids).not.toContain(id);

    if (expected.evidence) {
      expect(
        report.input_evidence.find((item) => item.field === expected.evidence?.field),
      ).toMatchObject({
        quality: expected.evidence.quality,
        age: expected.evidence.age,
      });
    }
  });
});

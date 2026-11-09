/**
 * PCB constraints — unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  validatePcbConstraints,
  buildConstraintReport,
  fromPcbIntent,
} from '../../../src/pcb-constraints/index.js';
import { PcbConstraintCodeMap } from '../../../src/pcb-constraints/errors.js';
import type { PcbConstraintInput } from '../../../src/pcb-constraints/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<PcbConstraintInput> = {}): PcbConstraintInput {
  return {
    widthMm: 60,
    heightMm: 40,
    layerCount: 2,
    hasOutline: true,
    mountingHoleCount: 4,
    hasLayerStack: true,
    hasNetClasses: true,
    hasClearanceRules: true,
    hasKeepoutAreas: true,
    hasPlacementZones: true,
    hasFiducials: true,
    hasTestPads: true,
    hasHighVoltage: false,
    manufacturingProcess: 'standard',
    hasQuantity: true,
    hasDrillFile: true,
    copperToEdgeViolationCount: 0,
    minDrillMm: 0.3,
    minAnnularRingMm: 0.15,
    solderMaskSliverViolationCount: 0,
    silkscreenOverPadCount: 0,
    smtComponentCount: 4,
    fiducialCount: 3,
    toolingHoleCount: 2,
    polarizedComponentCount: 0,
    polarityMarkCount: 0,
    componentSpacingViolationCount: 0,
    criticalNetNames: [],
    testPointNets: [],
    requiresProgrammingHeader: false,
    hasFabricationNotes: true,
    ...overrides,
  };
}

// ── Validation result shape ────────────────────────────────────────────────

describe('validatePcbConstraints', () => {
  it('returns valid=true for a complete board design', () => {
    const result = validatePcbConstraints(makeInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid=false when board outline is missing', () => {
    const result = validatePcbConstraints(makeInput({ hasOutline: false }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].code).toBe(PcbConstraintCodeMap.MISSING_BOARD_OUTLINE.code);
  });

  it('keeps multi-layer count validation unknown without independent stackup count', () => {
    const result = validatePcbConstraints(makeInput({ layerCount: 4, hasLayerStack: false }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.unknownChecks).toContainEqual({
      area: 'Layer count',
      missingFields: ['stackupCopperLayerCount'],
    });
  });

  it('detects only real, independently evidenced layer count mismatches', () => {
    const mismatch = validatePcbConstraints(
      makeInput({ layerCount: 6, stackupCopperLayerCount: 4 }),
    );
    expect(mismatch.errors).toContainEqual(
      expect.objectContaining({ code: 'PCB_LAYER_COUNT_MISMATCH', severity: 'error' }),
    );
    const matching = validatePcbConstraints(
      makeInput({ layerCount: 6, stackupCopperLayerCount: 6 }),
    );
    expect(matching.errors).toEqual([]);
    expect(matching.unknownChecks.some((issue) => issue.area === 'Layer count')).toBe(false);
  });

  it('does not invent a layer-count mismatch for six-layer boards without EasyEDA stackup', () => {
    const result = validatePcbConstraints(makeInput({ layerCount: 6, hasLayerStack: false }));
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ code: 'PCB_LAYER_COUNT_MISMATCH' }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'PCB_MISSING_STACKUP', severity: 'warning' }),
    );
    expect(result.unknownChecks).toContainEqual({
      area: 'Layer count',
      missingFields: ['stackupCopperLayerCount'],
    });
    expect(result.valid).toBe(false);
  });

  it('returns valid=true with only missing stackup warning for 2-layer board', () => {
    const result = validatePcbConstraints(makeInput({ hasLayerStack: false, layerCount: 2 }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.find((w) => w.code === PcbConstraintCodeMap.NO_LAYER_STACK.code),
    ).toBeDefined();
  });

  it('returns valid=false with high voltage but no clearance rules', () => {
    const result = validatePcbConstraints(
      makeInput({ hasHighVoltage: true, hasClearanceRules: false }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].code).toBe(PcbConstraintCodeMap.HIGH_VOLTAGE_CLEARANCE.code);
  });

  it('returns valid=true with high voltage and clearance rules', () => {
    const result = validatePcbConstraints(
      makeInput({ hasHighVoltage: true, hasClearanceRules: true }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('unknown evidence and rule accounting', () => {
  it.each([
    ['widthMm', 0],
    ['heightMm', 0],
    ['widthMm', -1],
    ['heightMm', Number.POSITIVE_INFINITY],
  ] as const)('treats nonpositive or nonfinite %s=%s as unavailable dimensions', (field, value) => {
    const result = validatePcbConstraints(makeInput({ [field]: value }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'PCB_OUTLINE_TOO_SMALL' }),
    );
    expect(result.unknownChecks).toContainEqual({
      area: 'Board dimensions',
      missingFields: [field],
    });
    expect(buildConstraintReport(makeInput({ [field]: value }), result).verdict).toBe(
      'needs-review',
    );
  });

  it('never labels an entirely unknown board as passed', () => {
    const result = validatePcbConstraints({});
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.summary.unknown).toBeGreaterThan(15);
    expect(result.summary.passed).toBe(0);
    expect(
      result.summary.passed +
        result.summary.failed +
        result.summary.notApplicable +
        result.summary.unknown,
    ).toBe(23);
    const report = buildConstraintReport({}, result);
    expect(report.verdict).toBe('needs-review');
    expect(
      report.checked.some((item) => item.status === 'unknown' && item.area === 'Board outline'),
    ).toBe(true);
    expect(report.manualReviewRequired.some((item) => item.area === 'Board outline')).toBe(true);
  });

  it('distinguishes known negative evidence from an unavailable property', () => {
    const missing = validatePcbConstraints(makeInput({ hasOutline: false }));
    const unknown = validatePcbConstraints(makeInput({ hasOutline: undefined }));
    expect(missing.errors.some((item) => item.code === 'PCB_MISSING_OUTLINE')).toBe(true);
    expect(unknown.errors.some((item) => item.code === 'PCB_MISSING_OUTLINE')).toBe(false);
    expect(unknown.unknownChecks.some((item) => item.area === 'Board outline')).toBe(true);
  });

  it('skips inapplicable rules rather than passing them', () => {
    const result = validatePcbConstraints(
      makeInput({ hasHighVoltage: false, requiresProgrammingHeader: false, criticalNetNames: [] }),
    );
    expect(result.valid).toBe(true);
    expect(result.summary.notApplicable).toBeGreaterThan(0);
    expect(result.summary.unknown).toBe(0);
  });
});

// ── Structural errors ──────────────────────────────────────────────────────

describe('structural errors', () => {
  it('rejects missing board outline', () => {
    const result = validatePcbConstraints(makeInput({ hasOutline: false }));
    const err = result.errors.find(
      (e) => e.code === PcbConstraintCodeMap.MISSING_BOARD_OUTLINE.code,
    );
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
    expect(err!.remediationHint).toBeTruthy();
  });

  it('rejects independently evidenced mismatched copper-layer counts', () => {
    const result = validatePcbConstraints(makeInput({ layerCount: 4, stackupCopperLayerCount: 6 }));
    const err = result.errors.find(
      (e) => e.code === PcbConstraintCodeMap.LAYER_COUNT_MISMATCH.code,
    );
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
  });

  it('rejects high-voltage without clearance rules', () => {
    const result = validatePcbConstraints(
      makeInput({ hasHighVoltage: true, hasClearanceRules: false }),
    );
    const err = result.errors.find(
      (e) => e.code === PcbConstraintCodeMap.HIGH_VOLTAGE_CLEARANCE.code,
    );
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
  });
});

// ── Warnings ───────────────────────────────────────────────────────────────

describe('warnings', () => {
  it('warns when no net classes defined', () => {
    const result = validatePcbConstraints(makeInput({ hasNetClasses: false }));
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    const warn = result.warnings.find((w) => w.code === PcbConstraintCodeMap.NO_NET_CLASSES.code);
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
  });

  it('does not treat unknown net-class or clearance evidence as confirmed absence', () => {
    const result = validatePcbConstraints(
      makeInput({ hasNetClasses: undefined, hasClearanceRules: true }),
    );
    expect(
      result.warnings.some((item) => item.code === PcbConstraintCodeMap.NO_NET_CLASSES.code),
    ).toBe(false);
    expect(result.unknownChecks.some((item) => item.area === 'Net classes')).toBe(true);
    expect(result.unknownChecks.some((item) => item.area === 'Clearance rules')).toBe(false);
  });

  it('does not turn unknown manufacturing and assembly metadata into missing-data warnings', () => {
    const result = validatePcbConstraints(
      makeInput({
        manufacturingProcess: undefined,
        hasQuantity: undefined,
        hasFiducials: undefined,
        mountingHoleCount: 4,
      }),
    );
    expect(
      result.warnings.filter(
        (item) => item.code === PcbConstraintCodeMap.MANUFACTURING_OPTIONS_WARNING.code,
      ),
    ).toHaveLength(0);
    expect(
      result.warnings.some((item) => item.code === PcbConstraintCodeMap.NO_FIDUCIALS.code),
    ).toBe(false);
    expect(result.unknownChecks.some((item) => item.area === 'Manufacturing constraints')).toBe(
      true,
    );
    expect(result.unknownChecks.some((item) => item.area === 'Fiducials')).toBe(true);
  });

  it('warns only for explicitly empty manufacturing process and absent quantity', () => {
    const result = validatePcbConstraints(
      makeInput({ manufacturingProcess: '', hasQuantity: false }),
    );
    expect(
      result.warnings.filter(
        (item) => item.code === PcbConstraintCodeMap.MANUFACTURING_OPTIONS_WARNING.code,
      ),
    ).toHaveLength(2);
  });

  it('warns when no clearance rules defined', () => {
    const result = validatePcbConstraints(makeInput({ hasClearanceRules: false }));
    const warn = result.warnings.find(
      (w) => w.code === PcbConstraintCodeMap.NO_CLEARANCE_RULES.code,
    );
    expect(warn).toBeDefined();
  });

  it('warns when no keepout areas defined', () => {
    const result = validatePcbConstraints(makeInput({ hasKeepoutAreas: false }));
    const warn = result.warnings.find((w) => w.code === PcbConstraintCodeMap.NO_KEEPOUT_AREAS.code);
    expect(warn).toBeDefined();
  });

  it('does not block a high-voltage board solely because net-class evidence is unknown', () => {
    const result = validatePcbConstraints(
      makeInput({ hasHighVoltage: true, hasClearanceRules: true, hasNetClasses: undefined }),
    );
    expect(
      result.errors.some((item) => item.code === PcbConstraintCodeMap.HIGH_VOLTAGE_CLEARANCE.code),
    ).toBe(false);
    expect(result.unknownChecks.some((item) => item.area === 'High-voltage clearance')).toBe(true);
  });

  it('does not treat unknown keepout or placement-zone evidence as absence', () => {
    const result = validatePcbConstraints(
      makeInput({ hasPlacementZones: true, hasKeepoutAreas: undefined }),
    );
    expect(
      result.warnings.some((item) => item.code === PcbConstraintCodeMap.NO_KEEPOUT_AREAS.code),
    ).toBe(false);
  });

  it('warns when no placement zones defined', () => {
    const result = validatePcbConstraints(makeInput({ hasPlacementZones: false }));
    const warn = result.warnings.find(
      (w) => w.code === PcbConstraintCodeMap.NO_PLACEMENT_ZONES.code,
    );
    expect(warn).toBeDefined();
  });

  it('warns when no fiducials', () => {
    const result = validatePcbConstraints(makeInput({ hasFiducials: false }));
    const warn = result.warnings.find((w) => w.code === PcbConstraintCodeMap.NO_FIDUCIALS.code);
    expect(warn).toBeDefined();
  });

  it('warns when no mounting holes', () => {
    const result = validatePcbConstraints(makeInput({ mountingHoleCount: 0 }));
    const warn = result.warnings.find(
      (w) => w.code === PcbConstraintCodeMap.NO_MOUNTING_HOLES.code,
    );
    expect(warn).toBeDefined();
  });

  it('warns when no layer stack defined', () => {
    const result = validatePcbConstraints(makeInput({ hasLayerStack: false, layerCount: 2 }));
    const warn = result.warnings.find((w) => w.code === PcbConstraintCodeMap.NO_LAYER_STACK.code);
    expect(warn).toBeDefined();
  });

  it('reports UNKNOWN rather than an invented missing-process warning', () => {
    const result = validatePcbConstraints(makeInput({ manufacturingProcess: undefined }));
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some(
        (issue) => issue.code === PcbConstraintCodeMap.MANUFACTURING_OPTIONS_WARNING.code,
      ),
    ).toBe(false);
    expect(result.unknownChecks).toEqual(
      expect.arrayContaining([
        { area: 'Manufacturing constraints', missingFields: ['manufacturingProcess'] },
      ]),
    );
  });
});

// ── Production review rules ────────────────────────────────────────────────

describe('production review rules', () => {
  it('rejects missing drill files', () => {
    const result = validatePcbConstraints(makeInput({ hasDrillFile: false }));
    const err = result.errors.find((e) => e.code === 'PCB_DRILL_FILE_MISSING');
    expect(err).toBeDefined();
    expect(err!.remediationHint).toContain('NC drill');
  });

  it('rejects copper-to-edge clearance violations', () => {
    const result = validatePcbConstraints(
      makeInput({ minCopperToEdgeMm: 0.1, copperToEdgeViolationCount: 2 }),
    );
    const err = result.errors.find((e) => e.code === 'PCB_COPPER_EDGE_CLEARANCE');
    expect(err).toBeDefined();
    expect(err!.details?.recommendedMinimumMm).toBe(0.25);
  });

  it('warns for drill and annular-ring manufacturability risk', () => {
    const result = validatePcbConstraints(makeInput({ minDrillMm: 0.15, minAnnularRingMm: 0.05 }));
    expect(result.warnings.some((w) => w.code === 'PCB_DRILL_TOO_SMALL')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'PCB_ANNULAR_RING_TOO_SMALL')).toBe(true);
  });

  it('warns for soldermask slivers and silkscreen over pads', () => {
    const result = validatePcbConstraints(
      makeInput({
        minSolderMaskSliverMm: 0.05,
        solderMaskSliverViolationCount: 3,
        silkscreenOverPadCount: 2,
      }),
    );
    expect(result.warnings.some((w) => w.code === 'PCB_SOLDERMASK_SLIVER')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'PCB_SILKSCREEN_OVER_PAD')).toBe(true);
  });

  it('warns for missing SMT fiducials and tooling holes', () => {
    const result = validatePcbConstraints(
      makeInput({ smtComponentCount: 24, fiducialCount: 1, toolingHoleCount: 0 }),
    );
    expect(result.warnings.some((w) => w.code === 'PCB_FIDUCIAL_REQUIRED')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'PCB_TOOLING_HOLE_MISSING')).toBe(true);
  });

  it('warns for missing polarity marks and component spacing violations', () => {
    const result = validatePcbConstraints(
      makeInput({
        polarizedComponentCount: 6,
        polarityMarkCount: 4,
        componentSpacingViolationCount: 2,
      }),
    );
    expect(result.warnings.some((w) => w.code === 'PCB_POLARITY_MARK_MISSING')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'PCB_COMPONENT_SPACING_VIOLATION')).toBe(true);
  });

  it('rejects impossible polarized-component mark inventories as UNKNOWN', () => {
    const invalidCounts = [
      { polarizedComponentCount: 1, polarityMarkCount: 2 },
      { polarizedComponentCount: 0, polarityMarkCount: 1 },
      { polarizedComponentCount: 4, polarityMarkCount: 7 },
    ];
    for (const counts of invalidCounts) {
      const result = validatePcbConstraints(makeInput(counts));
      expect(result.unknownChecks).toContainEqual({
        area: 'Polarity marks',
        missingFields: ['polarizedComponentCount', 'polarityMarkCount'],
      });
      expect(result.valid).toBe(false);
      expect(result.warnings.some((w) => w.code === 'PCB_POLARITY_MARK_MISSING')).toBe(false);
      expect(result.summary.unknown).toBeGreaterThan(0);
    }
    const incomplete = validatePcbConstraints(
      makeInput({
        polarizedComponentCount: 4,
        polarityMarkCount: undefined,
      }),
    );
    expect(incomplete.unknownChecks).toContainEqual({
      area: 'Polarity marks',
      missingFields: ['polarityMarkCount'],
    });
    const lower = validatePcbConstraints(
      makeInput({
        polarizedComponentCount: 4,
        polarityMarkCount: 3,
      }),
    );
    expect(lower.warnings.some((w) => w.code === 'PCB_POLARITY_MARK_MISSING')).toBe(true);
    const equal = validatePcbConstraints(
      makeInput({
        polarizedComponentCount: 4,
        polarityMarkCount: 4,
      }),
    );
    expect(equal.unknownChecks.some((c) => c.area === 'Polarity marks')).toBe(false);
    expect(equal.warnings.some((w) => w.code === 'PCB_POLARITY_MARK_MISSING')).toBe(false);
  });

  it('warns when critical nets lack testpoint coverage', () => {
    const result = validatePcbConstraints(
      makeInput({
        criticalNetNames: ['GND', '3V3', 'RESET', 'SWDIO', 'SWCLK'],
        testPointNets: ['GND', '3V3'],
      }),
    );
    const warn = result.warnings.find((w) => w.code === 'PCB_TESTPOINT_COVERAGE_LOW');
    expect(warn).toBeDefined();
    expect(warn!.details?.missingCriticalNets).toEqual(['RESET', 'SWDIO', 'SWCLK']);
  });

  it('matches native test-point nets exactly instead of folding case', () => {
    const mismatch = validatePcbConstraints(
      makeInput({ criticalNetNames: ['IO', 'GND'], testPointNets: ['io', 'GND'] }),
    );
    const warning = mismatch.warnings.find((w) => w.code === 'PCB_TESTPOINT_COVERAGE_LOW');
    expect(warning).toBeDefined();
    expect(warning?.details).toMatchObject({
      coverageRatio: 0.5,
      missingCriticalNets: ['IO'],
    });
    expect(mismatch.summary.failed).toBeGreaterThan(0);
    const exact = validatePcbConstraints(
      makeInput({ criticalNetNames: ['IO', 'GND'], testPointNets: ['IO', 'GND', 'GND'] }),
    );
    expect(exact.warnings.some((w) => w.code === 'PCB_TESTPOINT_COVERAGE_LOW')).toBe(false);
    expect(exact.unknownChecks.some((item) => item.area === 'Testpoint coverage')).toBe(false);
  });

  it('fails closed for malformed or duplicate critical-net inventories', () => {
    const variants: Array<Pick<PcbConstraintInput, 'criticalNetNames' | 'testPointNets'>> = [
      { criticalNetNames: ['IO '], testPointNets: ['IO'] },
      { criticalNetNames: ['IO'], testPointNets: [' IO'] },
      { criticalNetNames: ['IO', ''], testPointNets: ['IO'] },
      { criticalNetNames: ['IO'], testPointNets: [''] },
      { criticalNetNames: ['IO', 'io'], testPointNets: ['IO'] },
      { criticalNetNames: ['IO', 'IO'], testPointNets: ['IO'] },
      { criticalNetNames: ['IO', 'GND'], testPointNets: ['IO', 'io', 'GND'] },
      { criticalNetNames: ['IO', 'GND'], testPointNets: ['io', 'IO'] },
    ];
    for (const entry of variants) {
      const result = validatePcbConstraints(makeInput(entry));
      expect(result.unknownChecks).toContainEqual({
        area: 'Testpoint coverage',
        missingFields: ['criticalNetNames', 'testPointNets'],
      });
      expect(result.warnings.some((item) => item.code === 'PCB_TESTPOINT_COVERAGE_LOW')).toBe(
        false,
      );
      expect(result.valid).toBe(false);
    }
  });

  it('rejects missing programming/debug header when required', () => {
    const result = validatePcbConstraints(
      makeInput({ requiresProgrammingHeader: true, hasProgrammingHeader: false }),
    );
    const err = result.errors.find((e) => e.code === 'PCB_PROGRAMMING_HEADER_MISSING');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
  });

  it('warns when fabrication notes are missing', () => {
    const result = validatePcbConstraints(makeInput({ hasFabricationNotes: false }));
    const warn = result.warnings.find((w) => w.code === 'PCB_FAB_NOTES_MISSING');
    expect(warn).toBeDefined();
  });

  it('passes production review false-positive control for complete production data', () => {
    const result = validatePcbConstraints(
      makeInput({
        hasDrillFile: true,
        minCopperToEdgeMm: 0.35,
        copperToEdgeViolationCount: 0,
        minDrillMm: 0.3,
        minAnnularRingMm: 0.15,
        minSolderMaskSliverMm: 0.12,
        solderMaskSliverViolationCount: 0,
        silkscreenOverPadCount: 0,
        smtComponentCount: 12,
        fiducialCount: 3,
        toolingHoleCount: 2,
        polarizedComponentCount: 4,
        polarityMarkCount: 4,
        componentSpacingViolationCount: 0,
        criticalNetNames: ['GND', '3V3', 'RESET', 'SWDIO', 'SWCLK'],
        testPointNets: ['GND', '3V3', 'RESET', 'SWDIO', 'SWCLK'],
        requiresProgrammingHeader: true,
        hasProgrammingHeader: true,
        hasFabricationNotes: true,
      }),
    );

    expect(result.valid).toBe(true);
    expect(
      [...result.errors, ...result.warnings].filter((issue) =>
        [
          'PCB_DRILL_FILE_MISSING',
          'PCB_COPPER_EDGE_CLEARANCE',
          'PCB_DRILL_TOO_SMALL',
          'PCB_ANNULAR_RING_TOO_SMALL',
          'PCB_SOLDERMASK_SLIVER',
          'PCB_SILKSCREEN_OVER_PAD',
          'PCB_TOOLING_HOLE_MISSING',
          'PCB_POLARITY_MARK_MISSING',
          'PCB_COMPONENT_SPACING_VIOLATION',
          'PCB_TESTPOINT_COVERAGE_LOW',
          'PCB_PROGRAMMING_HEADER_MISSING',
          'PCB_FAB_NOTES_MISSING',
        ].includes(issue.code),
      ),
    ).toEqual([]);
  });
});

// ── Summary ────────────────────────────────────────────────────────────────

describe('validation summary', () => {
  it('counts total checks', () => {
    const result = validatePcbConstraints(
      makeInput({ hasOutline: false, hasLayerStack: false, layerCount: 0 }),
    );
    expect(result.summary.totalChecks).toBeGreaterThan(0);
    expect(
      result.summary.passed +
        result.summary.failed +
        result.summary.notApplicable +
        result.summary.unknown,
    ).toBe(result.summary.totalChecks);
  });

  it('shows passed > 0 for a complete design', () => {
    const result = validatePcbConstraints(makeInput());
    expect(result.summary.passed).toBeGreaterThan(0);
    expect(result.summary.failed).toBe(0);
  });

  it('shows failed > 0 for a broken design', () => {
    const result = validatePcbConstraints(makeInput({ hasOutline: false }));
    expect(result.summary.failed).toBeGreaterThan(0);
  });
});

// ── buildConstraintReport ──────────────────────────────────────────────────

describe('buildConstraintReport', () => {
  it('returns needs-review verdict for a complete design due to manual review items', () => {
    const input = makeInput();
    const result = validatePcbConstraints(input);
    const report = buildConstraintReport(input, result);
    expect(report.verdict).toBe('needs-review');
    expect(report.manualReviewRequired.length).toBeGreaterThan(0);
  });

  it('returns rejected verdict when errors exist', () => {
    const input = makeInput({ hasOutline: false });
    const result = validatePcbConstraints(input);
    const report = buildConstraintReport(input, result);
    expect(report.verdict).toBe('rejected');
  });

  it('returns needs-review verdict when only warnings exist', () => {
    const input = makeInput({ hasNetClasses: false, hasClearanceRules: false });
    const result = validatePcbConstraints(input);
    const report = buildConstraintReport(input, result);
    expect(report.verdict).toBe('needs-review');
  });

  it('includes manualReviewRequired items for warnings', () => {
    const input = makeInput({ hasPlacementZones: false, hasFiducials: false });
    const result = validatePcbConstraints(input);
    const report = buildConstraintReport(input, result);
    expect(report.manualReviewRequired.length).toBeGreaterThan(0);
    for (const item of report.manualReviewRequired) {
      expect(item.area).toBeTruthy();
      expect(item.reason).toBeTruthy();
    }
  });
});

// ── fromPcbIntent ──────────────────────────────────────────────────────────

describe('fromPcbIntent', () => {
  it('converts a minimal PcbIntent to PcbConstraintInput', () => {
    const intent = {
      boardOutline: undefined,
      layerStack: undefined,
      netClasses: undefined,
      clearanceRules: undefined,
      keepoutAreas: undefined,
      placementZones: undefined,
      mountingHoles: undefined,
      fiducials: undefined,
      testPads: undefined,
      manufacturingProcess: undefined,
      quantity: undefined,
      highVoltage: undefined,
    };
    const input = fromPcbIntent(intent);
    expect(input.hasOutline).toBeUndefined();
    expect(input.hasLayerStack).toBeUndefined();
    expect(input.mountingHoleCount).toBeUndefined();
    expect(input.hasHighVoltage).toBeUndefined();
  });

  it('converts a populated PcbIntent correctly', () => {
    const intent = {
      boardOutline: [{ x: 0, y: 0 }] as unknown as undefined,
      layerStack: [
        {
          name: 'F.Cu',
          type: 'copper' as const,
          thicknessUm: 35,
          material: 'copper' as const,
        },
      ],
      netClasses: [{ name: 'POWER', traceWidthUm: 500, clearanceUm: 200 }],
      clearanceRules: [{ netClassA: 'POWER', netClassB: 'SIGNAL', clearanceUm: 500 }],
      keepoutAreas: [{ x: 0, y: 0, widthMm: 10, heightMm: 10 }],
      placementZones: [
        { x: 0, y: 0, widthMm: 20, heightMm: 20, side: 'top', zoneType: 'component_keepout' },
      ],
      mountingHoles: [{ x: 5, y: 5, diameterMm: 3.2, type: 'm3_screw' }],
      fiducials: [{ x: 1, y: 1 }],
      testPads: [{ x: 10, y: 10, netName: 'GND' }],
      manufacturingProcess: 'standard',
      quantity: 100,
      highVoltage: false,
      hasDrillFile: true,
      minCopperToEdgeMm: 0.35,
      criticalNetNames: ['GND', '3V3'],
      testPointNets: ['GND', '3V3'],
      hasProgrammingHeader: true,
      requiresProgrammingHeader: true,
      hasFabricationNotes: true,
    };
    const input = fromPcbIntent(intent as Parameters<typeof fromPcbIntent>[0]);
    expect(input.hasOutline).toBe(true);
    expect(input.hasLayerStack).toBe(true);
    expect(input.hasNetClasses).toBe(true);
    expect(input.hasClearanceRules).toBe(true);
    expect(input.hasKeepoutAreas).toBe(true);
    expect(input.hasPlacementZones).toBe(true);
    expect(input.mountingHoleCount).toBe(1);
    expect(input.hasFiducials).toBe(true);
    expect(input.hasTestPads).toBe(true);
    expect(input.manufacturingProcess).toBe('standard');
    expect(input.hasQuantity).toBe(true);
    expect(input.hasHighVoltage).toBe(false);
    expect(input.hasDrillFile).toBe(true);
    expect(input.minCopperToEdgeMm).toBe(0.35);
    expect(input.criticalNetNames).toEqual(['GND', '3V3']);
    expect(input.hasProgrammingHeader).toBe(true);
    expect(input.requiresProgrammingHeader).toBe(true);
    expect(input.hasFabricationNotes).toBe(true);
  });

  it('converts highVoltage flag', () => {
    const input = fromPcbIntent({ highVoltage: true } as Parameters<typeof fromPcbIntent>[0]);
    expect(input.hasHighVoltage).toBe(true);
  });
});

// ── Error code map ─────────────────────────────────────────────────────────

describe('PcbConstraintCodeMap', () => {
  it('has all required error entries', () => {
    const codes = [
      'MISSING_BOARD_OUTLINE',
      'LAYER_COUNT_MISMATCH',
      'HIGH_VOLTAGE_CLEARANCE',
      'NO_NET_CLASSES',
      'NO_CLEARANCE_RULES',
      'NO_KEEPOUT_AREAS',
      'NO_PLACEMENT_ZONES',
      'NO_FIDUCIALS',
      'NO_TEST_PADS',
      'NO_MOUNTING_HOLES',
      'NO_LAYER_STACK',
      'MANUFACTURING_OPTIONS_WARNING',
      'DRILL_FILE_MISSING',
      'COPPER_EDGE_CLEARANCE',
      'DRILL_TOO_SMALL',
      'ANNULAR_RING_TOO_SMALL',
      'SOLDERMASK_SLIVER',
      'SILKSCREEN_OVER_PAD',
      'TOOLING_HOLE_MISSING',
      'POLARITY_MARK_MISSING',
      'COMPONENT_SPACING_VIOLATION',
      'TESTPOINT_COVERAGE_LOW',
      'PROGRAMMING_HEADER_MISSING',
      'FAB_NOTES_MISSING',
    ];
    for (const c of codes) {
      expect(PcbConstraintCodeMap[c as keyof typeof PcbConstraintCodeMap]).toBeDefined();
    }
  });

  it('each entry has code, message, severity, and remediationHint', () => {
    for (const key of Object.keys(PcbConstraintCodeMap)) {
      const entry = PcbConstraintCodeMap[key as keyof typeof PcbConstraintCodeMap];
      expect(typeof entry.code).toBe('string');
      expect(typeof entry.message).toBe('string');
      expect(typeof entry.severity).toBe('string');
      expect(typeof entry.remediationHint).toBe('string');
    }
  });
});

// ── fromPcbIntent edge cases ──────────────────────────────────────────────

describe('fromPcbIntent edge cases', () => {
  it('does not invent mounting holes, manufacturing details or high-voltage classification', () => {
    const input = fromPcbIntent({} as Parameters<typeof fromPcbIntent>[0]);
    expect(input.mountingHoleCount).toBeUndefined();
    expect(input.hasQuantity).toBeUndefined();
    expect(input.hasHighVoltage).toBeUndefined();
  });

  it('handles empty arrays', () => {
    const intent = {
      boardOutline: [],
      mountingHoles: [],
      layerStack: [],
      netClasses: [],
      clearanceRules: [],
      keepoutAreas: [],
      placementZones: [],
      fiducials: [],
      testPads: [],
    };
    const input = fromPcbIntent(intent as Parameters<typeof fromPcbIntent>[0]);
    expect(input.hasOutline).toBe(false);
    expect(input.mountingHoleCount).toBe(0);
    expect(input.hasLayerStack).toBe(false);
  });
});

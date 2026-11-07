/**
 * Every shipped PCB constraint area has positive, negative, boundary and
 * unavailable-evidence coverage. These cases are deterministic rules, not DRC
 * measurements or manufacturing/electrical certification.
 */
import { describe, expect, it } from 'vitest';
import {
  PcbConstraintCodeMap,
  validatePcbConstraints,
} from '../../../src/pcb-constraints/index.js';
import type {
  PcbConstraintInput,
  PcbConstraintResult,
} from '../../../src/pcb-constraints/types.js';

type Overrides = Partial<PcbConstraintInput>;
type RuleScenario = {
  area: string;
  code: string;
  good?: Overrides;
  bad: Overrides;
  edge: Overrides;
  unknown: Overrides;
  edgeIssue?: boolean;
};

function input(overrides: Overrides = {}): PcbConstraintInput {
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

function hasIssue(report: PcbConstraintResult, code: string) {
  return [...report.errors, ...report.warnings].some((entry) => entry.code === code);
}

const cases: RuleScenario[] = [
  {
    area: 'Board outline',
    code: 'PCB_MISSING_OUTLINE',
    bad: { hasOutline: false },
    edge: { hasOutline: true },
    unknown: { hasOutline: undefined },
  },
  {
    area: 'Board dimensions',
    code: 'PCB_OUTLINE_TOO_SMALL',
    bad: { widthMm: 4.99 },
    edge: { widthMm: 5 },
    unknown: { widthMm: undefined },
  },
  {
    area: 'Layer stackup',
    code: 'PCB_MISSING_STACKUP',
    bad: { hasLayerStack: false },
    edge: { hasLayerStack: true },
    unknown: { hasLayerStack: undefined },
  },
  {
    area: 'Layer count',
    code: 'PCB_LAYER_COUNT_MISMATCH',
    bad: { layerCount: 3, stackupCopperLayerCount: 4 },
    edge: { layerCount: 3, stackupCopperLayerCount: 3 },
    unknown: { layerCount: 6, hasLayerStack: false, stackupCopperLayerCount: undefined },
  },
  {
    area: 'Mounting holes',
    code: 'PCB_MISSING_MOUNTING_HOLES',
    bad: { mountingHoleCount: 0 },
    edge: { mountingHoleCount: 1 },
    unknown: { mountingHoleCount: undefined },
  },
  {
    area: 'Net classes',
    code: 'PCB_MISSING_NET_CLASSES',
    bad: { hasNetClasses: false },
    edge: { hasNetClasses: true },
    unknown: { hasNetClasses: undefined },
  },
  {
    area: 'Clearance rules',
    code: 'PCB_INVALID_CLEARANCE',
    bad: { hasClearanceRules: false },
    edge: { hasNetClasses: false, hasClearanceRules: false },
    unknown: { hasClearanceRules: undefined },
  },
  {
    area: 'Keepout areas',
    code: 'PCB_KEEPOUT_VIOLATION',
    bad: { hasKeepoutAreas: false },
    edge: { hasPlacementZones: false, hasKeepoutAreas: false },
    unknown: { hasKeepoutAreas: undefined },
  },
  {
    area: 'Placement zones',
    code: 'PCB_MISSING_PLACEMENT_ZONES',
    bad: { hasPlacementZones: false },
    edge: { layerCount: 1, hasPlacementZones: false },
    unknown: { hasPlacementZones: undefined },
  },
  {
    area: 'Manufacturing constraints',
    code: 'PCB_MISSING_MANUFACTURING_CONSTRAINTS',
    bad: { manufacturingProcess: '' },
    edge: { hasQuantity: false },
    unknown: { manufacturingProcess: undefined },
    edgeIssue: true,
  },
  {
    area: 'Fiducials',
    code: 'PCB_FIDUCIAL_REQUIRED',
    bad: { hasFiducials: false },
    edge: { hasFiducials: false, mountingHoleCount: 0 },
    unknown: { hasFiducials: undefined },
  },
  {
    area: 'High-voltage clearance',
    code: 'PCB_HIGH_VOLTAGE_CLEARANCE',
    good: { hasHighVoltage: true },
    bad: { hasHighVoltage: true, hasClearanceRules: false },
    edge: { hasHighVoltage: false, hasClearanceRules: false },
    unknown: { hasHighVoltage: undefined },
  },
  {
    area: 'Drill file',
    code: 'PCB_DRILL_FILE_MISSING',
    bad: { hasDrillFile: false },
    edge: { hasDrillFile: true },
    unknown: { hasDrillFile: undefined },
  },
  {
    area: 'Copper-to-edge clearance',
    code: 'PCB_COPPER_EDGE_CLEARANCE',
    bad: { minCopperToEdgeMm: 0.249 },
    edge: { minCopperToEdgeMm: 0.25 },
    unknown: { copperToEdgeViolationCount: undefined, minCopperToEdgeMm: undefined },
  },
  {
    area: 'Drill and annular ring',
    code: 'PCB_DRILL_TOO_SMALL',
    bad: { minDrillMm: 0.199 },
    edge: { minDrillMm: 0.2, minAnnularRingMm: 0.1 },
    unknown: { minDrillMm: undefined },
  },
  {
    area: 'Soldermask sliver',
    code: 'PCB_SOLDERMASK_SLIVER',
    bad: { minSolderMaskSliverMm: 0.099 },
    edge: { minSolderMaskSliverMm: 0.1 },
    unknown: { solderMaskSliverViolationCount: undefined, minSolderMaskSliverMm: undefined },
  },
  {
    area: 'Silkscreen over pads',
    code: 'PCB_SILKSCREEN_OVER_PAD',
    bad: { silkscreenOverPadCount: 1 },
    edge: { silkscreenOverPadCount: 0 },
    unknown: { silkscreenOverPadCount: undefined },
  },
  {
    area: 'Assembly alignment',
    code: 'PCB_TOOLING_HOLE_MISSING',
    bad: { toolingHoleCount: 1 },
    edge: { toolingHoleCount: 2 },
    unknown: { toolingHoleCount: undefined },
  },
  {
    area: 'Polarity marks',
    code: 'PCB_POLARITY_MARK_MISSING',
    good: { polarizedComponentCount: 4, polarityMarkCount: 4 },
    bad: { polarizedComponentCount: 4, polarityMarkCount: 3 },
    edge: { polarizedComponentCount: 4, polarityMarkCount: 4 },
    unknown: { polarizedComponentCount: 4, polarityMarkCount: undefined },
  },
  {
    area: 'Component spacing',
    code: 'PCB_COMPONENT_SPACING_VIOLATION',
    bad: { componentSpacingViolationCount: 1 },
    edge: { componentSpacingViolationCount: 0 },
    unknown: { componentSpacingViolationCount: undefined },
  },
  {
    area: 'Testpoint coverage',
    code: 'PCB_TESTPOINT_COVERAGE_LOW',
    good: { criticalNetNames: ['A', 'B', 'C', 'D', 'E'], testPointNets: ['A', 'B', 'C', 'D', 'E'] },
    bad: { criticalNetNames: ['A', 'B', 'C', 'D', 'E'], testPointNets: ['A', 'B', 'C'] },
    edge: { criticalNetNames: ['A', 'B', 'C', 'D', 'E'], testPointNets: ['A', 'B', 'C', 'D'] },
    unknown: { criticalNetNames: ['A', 'B', 'C', 'D', 'E'], testPointNets: undefined },
  },
  {
    area: 'Programming access',
    code: 'PCB_PROGRAMMING_HEADER_MISSING',
    good: { requiresProgrammingHeader: true, hasProgrammingHeader: true },
    bad: { requiresProgrammingHeader: true, hasProgrammingHeader: false },
    edge: { requiresProgrammingHeader: false, hasProgrammingHeader: false },
    unknown: { requiresProgrammingHeader: true, hasProgrammingHeader: undefined },
  },
  {
    area: 'Fabrication notes',
    code: 'PCB_FAB_NOTES_MISSING',
    bad: { hasFabricationNotes: false },
    edge: { hasFabricationNotes: true },
    unknown: { hasFabricationNotes: undefined },
  },
];

// One rule area can emit more than one published violation code. Keep the
// second drill/manufacturability code covered by the same four-way contract.
const additionalCodes: RuleScenario[] = [
  {
    area: 'Drill and annular ring',
    code: 'PCB_ANNULAR_RING_TOO_SMALL',
    good: { minAnnularRingMm: 0.15 },
    bad: { minAnnularRingMm: 0.099 },
    edge: { minAnnularRingMm: 0.1 },
    unknown: { minAnnularRingMm: undefined },
  },
];

describe('23 shipped PCB rules: deterministic evidence boundary matrix', () => {
  it('contains one unique area per shipped rule', () => {
    expect(cases).toHaveLength(23);
    expect(new Set(cases.map((entry) => entry.area)).size).toBe(cases.length);
    expect(validatePcbConstraints(input()).summary.totalChecks).toBe(cases.length);
    const publishedCodes = new Set(
      Object.values(PcbConstraintCodeMap)
        .map((item) => item.code)
        .filter((code) => code !== 'PCB_CONSTRAINT_INTERNAL'),
    );
    expect(new Set([...cases, ...additionalCodes].map((entry) => entry.code))).toEqual(
      publishedCodes,
    );
  });

  for (const scenario of [...cases, ...additionalCodes]) {
    describe(`${scenario.area} — ${scenario.code}`, () => {
      it('positive evidence does not produce a false violation', () => {
        const report = validatePcbConstraints(input(scenario.good));
        expect(hasIssue(report, scenario.code)).toBe(false);
        expect(report.unknownChecks.map((entry) => entry.area)).not.toContain(scenario.area);
      });

      it('known invalid evidence is detected', () => {
        const report = validatePcbConstraints(input(scenario.bad));
        expect(hasIssue(report, scenario.code)).toBe(true);
        expect(report.unknownChecks.map((entry) => entry.area)).not.toContain(scenario.area);
      });

      it('exact threshold or rule activation boundary is deterministic', () => {
        const report = validatePcbConstraints(input(scenario.edge));
        expect(hasIssue(report, scenario.code)).toBe(scenario.edgeIssue ?? false);
        expect(report.unknownChecks.map((entry) => entry.area)).not.toContain(scenario.area);
      });

      it('unavailable required evidence cannot approve the rule', () => {
        const report = validatePcbConstraints(input(scenario.unknown));
        expect(hasIssue(report, scenario.code)).toBe(false);
        expect(report.unknownChecks.map((entry) => entry.area)).toContain(scenario.area);
        expect(report.valid).toBe(false);
      });
    });
  }
});

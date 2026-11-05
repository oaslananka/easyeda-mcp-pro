/**
 * PCB constraint validation rules.
 *
 * Implements production constraint checks that operate on {@link PcbConstraintInput}
 * and produce structured {@link PcbConstraintIssue}s.
 *
 * Rules:
 *  1. Missing board outline (error)
 *  2. Board outline too small (warning)
 *  3. Missing layer stackup (warning)
 *  4. Layer count mismatch between intent and board (error)
 *  5. Missing mounting holes (warning)
 *  6. Missing net classes (warning)
 *  7. Invalid clearance / creepage (error)
 *  8. Keepout area violations (error)
 *  9. Missing placement zones (warning)
 * 10. Missing manufacturing constraints (warning)
 * 11. Fiducials recommended for SMT (warning)
 * 12. High-voltage creepage/clearance (error)
 * 13. Missing drill file (error)
 * 14. Copper-to-edge clearance violations (error)
 * 15. Drill/annular-ring manufacturing risk (warning)
 * 16. Soldermask sliver risk (warning)
 * 17. Silkscreen over exposed pads (warning)
 * 18. Tooling holes for assembly/panel fixtures (warning)
 * 19. Polarity/orientation marks (warning)
 * 20. Component spacing/courtyard violations (warning)
 * 21. Critical-net testpoint coverage (warning)
 * 22. Programming/debug header access (error)
 * 23. Fabrication notes completeness (warning)
 *
 * @module
 */

import type { PcbConstraintInput, PcbConstraintIssue, PcbConstraintResult } from './types.js';
import { pcbError, pcbWarning } from './errors.js';

const MIN_COPPER_TO_EDGE_MM = 0.25;
const MIN_DRILL_MM = 0.2;
const MIN_ANNULAR_RING_MM = 0.1;
const MIN_SOLDERMASK_SLIVER_MM = 0.1;
const MIN_SMT_FIDUCIAL_COUNT = 3;
const MIN_TOOLING_HOLE_COUNT = 2;
const MIN_TESTPOINT_COVERAGE_RATIO = 0.8;

/** Exact net names are identities. An incomplete or ambiguous caller
 * inventory cannot establish physical test-point coverage.
 */
function ambiguousTestpointInventory(input: PcbConstraintInput): boolean {
  const required = input.criticalNetNames ?? [];
  const observed = input.testPointNets ?? [];
  return (
    [...required, ...observed].some((name) => !name || name.trim() !== name) ||
    new Set(required.map((name) => name.toUpperCase())).size !== required.length
  );
}

// ── Rule: missing board outline ────────────────────────────────────────────

function checkMissingOutline(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasOutline === false) {
    issues.push(
      pcbError('PCB_MISSING_OUTLINE', 'Board outline is not defined', {
        remediationHint:
          'Define a board outline with at least 3 polygon points in the PCB intent or board dimensions',
      }),
    );
  }

  return issues;
}

// ── Rule: board outline too small ──────────────────────────────────────────

const MIN_BOARD_DIMENSION_MM = 5;

function checkOutlineTooSmall(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.widthMm && input.widthMm < MIN_BOARD_DIMENSION_MM) {
    issues.push(
      pcbWarning(
        'PCB_OUTLINE_TOO_SMALL',
        `Board width (${input.widthMm}mm) is below recommended minimum of ${MIN_BOARD_DIMENSION_MM}mm`,
        {
          remediationHint:
            'Verify the board dimensions are correct. Very small boards may be difficult to manufacture.',
        },
      ),
    );
  }

  if (input.heightMm && input.heightMm < MIN_BOARD_DIMENSION_MM) {
    issues.push(
      pcbWarning(
        'PCB_OUTLINE_TOO_SMALL',
        `Board height (${input.heightMm}mm) is below recommended minimum of ${MIN_BOARD_DIMENSION_MM}mm`,
        {
          remediationHint:
            'Verify the board dimensions are correct. Very small boards may be difficult to manufacture.',
        },
      ),
    );
  }

  return issues;
}

// ── Rule: missing layer stackup ────────────────────────────────────────────

function checkMissingStackup(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasLayerStack === false) {
    issues.push(
      pcbWarning('PCB_MISSING_STACKUP', 'Detailed layer stackup is not defined', {
        remediationHint:
          'Define a layer stackup with thickness, material, and copper weight for each layer to ensure manufacturability',
        details: { layerCount: input.layerCount },
      }),
    );
  }

  return issues;
}

// ── Rule: layer count mismatch ─────────────────────────────────────────────

const MAX_LAYERS_WITHOUT_STACKUP = 2;

function checkLayerCountMismatch(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (
    input.layerCount &&
    input.layerCount > MAX_LAYERS_WITHOUT_STACKUP &&
    input.hasLayerStack === false
  ) {
    issues.push(
      pcbError(
        'PCB_LAYER_COUNT_MISMATCH',
        `Board has ${input.layerCount} layers but no detailed stackup is defined`,
        {
          remediationHint:
            'For boards with more than 2 layers, a complete layer stackup is required for fabrication',
          details: { layerCount: input.layerCount },
        },
      ),
    );
  }

  return issues;
}

// ── Rule: missing mounting holes ───────────────────────────────────────────

function checkMissingMountingHoles(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.mountingHoleCount !== undefined && input.mountingHoleCount === 0) {
    issues.push(
      pcbWarning('PCB_MISSING_MOUNTING_HOLES', 'No mounting holes defined on the board', {
        remediationHint:
          'Add at least 4 mounting holes (one near each corner) for mechanical stability and assembly',
      }),
    );
  }

  return issues;
}

// ── Rule: missing net classes ──────────────────────────────────────────────

function checkMissingNetClasses(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasNetClasses === false) {
    issues.push(
      pcbWarning('PCB_MISSING_NET_CLASSES', 'No net classes with routing rules are defined', {
        remediationHint:
          'Define net classes for power, signal, and high-speed nets to enforce trace width and clearance rules',
      }),
    );
  }

  return issues;
}

// ── Rule: invalid clearance ────────────────────────────────────────────────

function checkInvalidClearance(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasNetClasses === true && input.hasClearanceRules === false) {
    issues.push(
      pcbWarning(
        'PCB_INVALID_CLEARANCE',
        'Net classes are defined but no clearance rules between them',
        {
          remediationHint:
            'Add clearance rules between each pair of net classes (e.g., power-to-signal, high-voltage-to-signal)',
        },
      ),
    );
  }

  return issues;
}

// ── Rule: keepout violations ───────────────────────────────────────────────

function checkKeepoutAreas(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasKeepoutAreas === false && input.hasPlacementZones === true) {
    issues.push(
      pcbWarning(
        'PCB_KEEPOUT_VIOLATION',
        'Placement zones are defined but no keepout/restricted areas',
        {
          remediationHint:
            'Consider adding keepout areas to prevent component or track placement in restricted zones',
        },
      ),
    );
  }

  return issues;
}

// ── Rule: missing placement zones ──────────────────────────────────────────

function checkMissingPlacementZones(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasPlacementZones === false && input.layerCount && input.layerCount > 1) {
    issues.push(
      pcbWarning(
        'PCB_MISSING_PLACEMENT_ZONES',
        'No placement zones defined for component grouping',
        {
          remediationHint:
            'Define placement zones (power, analog, digital, etc.) to guide component placement and improve signal integrity',
        },
      ),
    );
  }

  return issues;
}

// ── Rule: missing manufacturing constraints ────────────────────────────────

function checkMissingManufacturingConstraints(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.manufacturingProcess === '') {
    issues.push(
      pcbWarning(
        'PCB_MISSING_MANUFACTURING_CONSTRAINTS',
        'Manufacturing process (lead-free/lead-based) is not specified',
        {
          remediationHint:
            'Specify the manufacturing process to ensure correct solder mask, pad finish, and assembly requirements',
        },
      ),
    );
  }

  if (input.hasQuantity === false) {
    issues.push(
      pcbWarning('PCB_MISSING_MANUFACTURING_CONSTRAINTS', 'Production quantity is not specified', {
        remediationHint:
          'Specify the target production quantity to select the appropriate manufacturing process',
      }),
    );
  }

  return issues;
}

// ── Rule: fiducials recommended ────────────────────────────────────────────

function checkFiducials(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.hasFiducials === false && input.mountingHoleCount && input.mountingHoleCount > 0) {
    issues.push(
      pcbWarning('PCB_FIDUCIAL_REQUIRED', 'No fiducial marks defined for SMT assembly', {
        remediationHint:
          'Add at least 3 fiducial marks (global, near board corners) for pick-and-place machine alignment',
      }),
    );
  }

  return issues;
}

// ── Rule: high-voltage creepage/clearance ──────────────────────────────────

function checkHighVoltageClearance(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (
    input.hasHighVoltage === true &&
    (input.hasClearanceRules === false || input.hasNetClasses === false)
  ) {
    issues.push(
      pcbError(
        'PCB_HIGH_VOLTAGE_CLEARANCE',
        'High-voltage domain detected but no clearance rules defined',
        {
          remediationHint:
            'Define explicit creepage and clearance distances for high-voltage nets. Minimum 4mm clearance for 250V AC is recommended.',
        },
      ),
    );
  }

  return issues;
}

// ── Production review: drill file completeness ─────────────────────────────

function checkDrillFile(input: PcbConstraintInput): PcbConstraintIssue[] {
  if (input.hasDrillFile !== false) return [];
  return [
    pcbError('PCB_DRILL_FILE_MISSING', 'NC drill file is missing from the manufacturing package', {
      remediationHint: 'Re-export the manufacturing package with Excellon/NC drill files included',
      details: { hasDrillFile: input.hasDrillFile },
    }),
  ];
}

// ── Production review: copper-to-edge clearance ────────────────────────────

function checkCopperToEdgeClearance(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];
  const violationCount = input.copperToEdgeViolationCount ?? 0;
  const belowMinimum =
    input.minCopperToEdgeMm !== undefined && input.minCopperToEdgeMm < MIN_COPPER_TO_EDGE_MM;

  if (violationCount > 0 || belowMinimum) {
    issues.push(
      pcbError(
        'PCB_COPPER_EDGE_CLEARANCE',
        `Copper-to-edge clearance is below ${MIN_COPPER_TO_EDGE_MM}mm${input.minCopperToEdgeMm !== undefined ? ` (observed ${input.minCopperToEdgeMm}mm)` : ''}`,
        {
          remediationHint:
            'Move copper, zones, vias, and pads away from the routed board edge or increase the copper-to-edge clearance rule',
          details: {
            minCopperToEdgeMm: input.minCopperToEdgeMm,
            copperToEdgeViolationCount: violationCount,
            recommendedMinimumMm: MIN_COPPER_TO_EDGE_MM,
          },
        },
      ),
    );
  }

  return issues;
}

// ── Production review: drill and annular ring capability ───────────────────

function checkDrillManufacturability(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];

  if (input.minDrillMm !== undefined && input.minDrillMm < MIN_DRILL_MM) {
    issues.push(
      pcbWarning(
        'PCB_DRILL_TOO_SMALL',
        `Minimum drill diameter ${input.minDrillMm}mm is below common ${MIN_DRILL_MM}mm fabrication capability`,
        {
          remediationHint:
            'Increase finished drill diameter or confirm the selected fabricator supports the requested drill size',
          details: { minDrillMm: input.minDrillMm, recommendedMinimumMm: MIN_DRILL_MM },
        },
      ),
    );
  }

  if (input.minAnnularRingMm !== undefined && input.minAnnularRingMm < MIN_ANNULAR_RING_MM) {
    issues.push(
      pcbWarning(
        'PCB_ANNULAR_RING_TOO_SMALL',
        `Minimum annular ring ${input.minAnnularRingMm}mm is below recommended ${MIN_ANNULAR_RING_MM}mm`,
        {
          remediationHint:
            'Increase pad/via diameter or reduce drill size to maintain enough annular ring for registration tolerance',
          details: {
            minAnnularRingMm: input.minAnnularRingMm,
            recommendedMinimumMm: MIN_ANNULAR_RING_MM,
          },
        },
      ),
    );
  }

  return issues;
}

// ── Production review: soldermask sliver ───────────────────────────────────

function checkSolderMaskSliver(input: PcbConstraintInput): PcbConstraintIssue[] {
  const violationCount = input.solderMaskSliverViolationCount ?? 0;
  const belowMinimum =
    input.minSolderMaskSliverMm !== undefined &&
    input.minSolderMaskSliverMm < MIN_SOLDERMASK_SLIVER_MM;
  if (!belowMinimum && violationCount === 0) return [];

  return [
    pcbWarning(
      'PCB_SOLDERMASK_SLIVER',
      `Soldermask sliver is below ${MIN_SOLDERMASK_SLIVER_MM}mm${input.minSolderMaskSliverMm !== undefined ? ` (observed ${input.minSolderMaskSliverMm}mm)` : ''}`,
      {
        remediationHint:
          'Increase pad spacing, adjust soldermask expansion, or remove soldermask dams intentionally where supported',
        details: {
          minSolderMaskSliverMm: input.minSolderMaskSliverMm,
          solderMaskSliverViolationCount: violationCount,
          recommendedMinimumMm: MIN_SOLDERMASK_SLIVER_MM,
        },
      },
    ),
  ];
}

// ── Production review: silkscreen over pads ────────────────────────────────

function checkSilkscreenOverPads(input: PcbConstraintInput): PcbConstraintIssue[] {
  const count = input.silkscreenOverPadCount ?? 0;
  if (count <= 0) return [];
  return [
    pcbWarning(
      'PCB_SILKSCREEN_OVER_PAD',
      `${count} silkscreen object${count === 1 ? '' : 's'} overlap exposed copper pads`,
      {
        remediationHint:
          'Move or clip silkscreen references/graphics so they do not print over solderable pads',
        details: { silkscreenOverPadCount: count },
      },
    ),
  ];
}

// ── Production review: assembly fixtures/fiducials ─────────────────────────

function checkAssemblyAlignmentFeatures(input: PcbConstraintInput): PcbConstraintIssue[] {
  const issues: PcbConstraintIssue[] = [];
  const smtCount = input.smtComponentCount ?? 0;
  const fiducialCount = input.fiducialCount ?? (input.hasFiducials ? MIN_SMT_FIDUCIAL_COUNT : 0);
  const toolingHoleCount = input.toolingHoleCount ?? 0;

  if (smtCount > 0 && fiducialCount < MIN_SMT_FIDUCIAL_COUNT) {
    issues.push(
      pcbWarning(
        'PCB_FIDUCIAL_REQUIRED',
        `SMT assembly has ${fiducialCount} fiducial(s); at least ${MIN_SMT_FIDUCIAL_COUNT} are recommended`,
        {
          remediationHint:
            'Add at least 3 fiducial marks (global, near board corners) for pick-and-place machine alignment',
          details: {
            smtComponentCount: smtCount,
            fiducialCount,
            recommendedMinimum: MIN_SMT_FIDUCIAL_COUNT,
          },
        },
      ),
    );
  }

  if (smtCount > 0 && toolingHoleCount < MIN_TOOLING_HOLE_COUNT) {
    issues.push(
      pcbWarning(
        'PCB_TOOLING_HOLE_MISSING',
        `Assembly tooling holes are below recommended count (${toolingHoleCount}/${MIN_TOOLING_HOLE_COUNT})`,
        {
          remediationHint:
            'Add tooling holes or confirm the assembler will provide panel-level tooling holes during panelization',
          details: {
            smtComponentCount: smtCount,
            toolingHoleCount,
            recommendedMinimum: MIN_TOOLING_HOLE_COUNT,
          },
        },
      ),
    );
  }

  return issues;
}

// ── Production review: polarity/orientation marks ──────────────────────────

function checkPolarityMarks(input: PcbConstraintInput): PcbConstraintIssue[] {
  const polarizedCount = input.polarizedComponentCount ?? 0;
  const markedCount = input.polarityMarkCount ?? 0;
  const missingCount = Math.max(0, polarizedCount - markedCount);
  if (missingCount === 0) return [];

  return [
    pcbWarning(
      'PCB_POLARITY_MARK_MISSING',
      `${missingCount} polarized/orientation-sensitive component${missingCount === 1 ? '' : 's'} lack polarity/orientation marks`,
      {
        remediationHint:
          'Add clear silkscreen/courtyard polarity markers for diodes, LEDs, electrolytic capacitors, IC pin 1, and connectors',
        details: {
          polarizedComponentCount: polarizedCount,
          polarityMarkCount: markedCount,
          missingCount,
        },
      },
    ),
  ];
}

// ── Production review: component spacing/courtyard ─────────────────────────

function checkComponentSpacing(input: PcbConstraintInput): PcbConstraintIssue[] {
  const count = input.componentSpacingViolationCount ?? 0;
  if (count <= 0) return [];
  return [
    pcbWarning(
      'PCB_COMPONENT_SPACING_VIOLATION',
      `${count} component spacing/courtyard violation${count === 1 ? '' : 's'} detected`,
      {
        remediationHint:
          'Increase component-to-component spacing or review courtyard overlap for assembly nozzle, hand-solder, and rework access',
        details: { componentSpacingViolationCount: count },
      },
    ),
  ];
}

// ── Production review: testpoint coverage ──────────────────────────────────

function checkTestpointCoverage(input: PcbConstraintInput): PcbConstraintIssue[] {
  const criticalNets = input.criticalNetNames ?? [];
  if (criticalNets.length === 0) return [];
  // This rule runs only for unambiguous inventories (see evidence gate).
  const testPointNets = new Set(input.testPointNets ?? []);
  const missing = criticalNets.filter((net) => !testPointNets.has(net));
  const coverage = (criticalNets.length - missing.length) / criticalNets.length;

  if (coverage < MIN_TESTPOINT_COVERAGE_RATIO) {
    return [
      pcbWarning(
        'PCB_TESTPOINT_COVERAGE_LOW',
        `Critical-net testpoint coverage is ${(coverage * 100).toFixed(0)}%; ${missing.length} critical net(s) are missing test access`,
        {
          remediationHint:
            'Add accessible test pads for power rails, ground, reset, boot, programming, clocks, and key interfaces',
          details: {
            criticalNetCount: criticalNets.length,
            testPointNetCount: testPointNets.size,
            missingCriticalNets: missing,
            coverageRatio: coverage,
            recommendedMinimumRatio: MIN_TESTPOINT_COVERAGE_RATIO,
          },
        },
      ),
    ];
  }

  return [];
}

// ── Production review: programming/debug access ────────────────────────────

function checkProgrammingHeader(input: PcbConstraintInput): PcbConstraintIssue[] {
  if (!input.requiresProgrammingHeader || input.hasProgrammingHeader !== false) return [];
  return [
    pcbError('PCB_PROGRAMMING_HEADER_MISSING', 'Programming/debug header is required but missing', {
      remediationHint:
        'Add a programming/debug connector or documented test pads for SWD/JTAG/UART/BOOT/RESET access',
      details: {
        requiresProgrammingHeader: true,
        hasProgrammingHeader: input.hasProgrammingHeader,
      },
    }),
  ];
}

// ── Production review: fabrication notes ───────────────────────────────────

function checkFabricationNotes(input: PcbConstraintInput): PcbConstraintIssue[] {
  if (input.hasFabricationNotes !== false) return [];
  return [
    pcbWarning('PCB_FAB_NOTES_MISSING', 'Fabrication notes are missing from the handoff package', {
      remediationHint:
        'Add fabrication notes covering board thickness, copper weight, finish, soldermask color, impedance requirements, panelization, and special instructions',
      details: { hasFabricationNotes: input.hasFabricationNotes },
    }),
  ];
}

// ── Combine helper ─────────────────────────────────────────────────────────

type RuleFn = (input: PcbConstraintInput) => PcbConstraintIssue[];
type InputField = keyof PcbConstraintInput;

/** Evidence required to make a claim about a rule. Not applicable is not a pass. */
interface RuleEvidence {
  area: string;
  fields: (input: PcbConstraintInput) => InputField[];
  /** Present but ambiguous source fields also require explicit review. */
  invalid?: (input: PcbConstraintInput) => InputField[];
  skip?: (input: PcbConstraintInput) => boolean;
}

const fields =
  (...required: InputField[]) =>
  () =>
    required;
const RULE_EVIDENCE: RuleEvidence[] = [
  { area: 'Board outline', fields: fields('hasOutline') },
  {
    area: 'Board dimensions',
    fields: fields('widthMm', 'heightMm'),
    skip: (i) => i.hasOutline === false,
  },
  { area: 'Layer stackup', fields: fields('hasLayerStack') },
  {
    area: 'Layer count',
    fields: (i) =>
      i.layerCount !== undefined && i.layerCount <= 2
        ? ['layerCount']
        : ['layerCount', 'hasLayerStack'],
    skip: (i) => i.layerCount !== undefined && i.layerCount <= 2,
  },
  { area: 'Mounting holes', fields: fields('mountingHoleCount') },
  { area: 'Net classes', fields: fields('hasNetClasses') },
  { area: 'Clearance rules', fields: fields('hasClearanceRules') },
  {
    area: 'Keepout areas',
    fields: (i) =>
      i.hasPlacementZones === true
        ? ['hasPlacementZones', 'hasKeepoutAreas']
        : ['hasPlacementZones'],
    skip: (i) => i.hasPlacementZones === false,
  },
  {
    area: 'Placement zones',
    fields: (i) =>
      i.layerCount !== undefined && i.layerCount <= 1
        ? ['layerCount']
        : ['layerCount', 'hasPlacementZones'],
    skip: (i) => i.layerCount !== undefined && i.layerCount <= 1,
  },
  { area: 'Manufacturing constraints', fields: fields('manufacturingProcess', 'hasQuantity') },
  {
    area: 'Fiducials',
    fields: fields('hasFiducials', 'mountingHoleCount'),
    skip: (i) => i.mountingHoleCount === 0,
  },
  {
    area: 'High-voltage clearance',
    fields: (i) =>
      i.hasHighVoltage === true
        ? ['hasHighVoltage', 'hasClearanceRules', 'hasNetClasses']
        : ['hasHighVoltage'],
    skip: (i) => i.hasHighVoltage === false,
  },
  { area: 'Drill file', fields: fields('hasDrillFile') },
  {
    area: 'Copper-to-edge clearance',
    fields: (i) =>
      i.copperToEdgeViolationCount !== undefined
        ? ['copperToEdgeViolationCount']
        : ['minCopperToEdgeMm'],
  },
  { area: 'Drill and annular ring', fields: fields('minDrillMm', 'minAnnularRingMm') },
  {
    area: 'Soldermask sliver',
    fields: (i) =>
      i.solderMaskSliverViolationCount !== undefined
        ? ['solderMaskSliverViolationCount']
        : ['minSolderMaskSliverMm'],
  },
  { area: 'Silkscreen over pads', fields: fields('silkscreenOverPadCount') },
  {
    area: 'Assembly alignment',
    fields: (i) =>
      i.smtComponentCount === 0
        ? ['smtComponentCount']
        : ['smtComponentCount', 'fiducialCount', 'toolingHoleCount'],
    skip: (i) => i.smtComponentCount === 0,
  },
  {
    area: 'Polarity marks',
    fields: (i) =>
      i.polarizedComponentCount === 0
        ? ['polarizedComponentCount']
        : ['polarizedComponentCount', 'polarityMarkCount'],
    // Each claimed mark must belong to a distinct polarized component.
    // Counts above the inventory cannot establish coverage, including
    // the declared zero-polarized-component case.
    invalid: (i) =>
      i.polarizedComponentCount !== undefined &&
      i.polarityMarkCount !== undefined &&
      i.polarityMarkCount > i.polarizedComponentCount
        ? ['polarizedComponentCount', 'polarityMarkCount']
        : [],
    skip: (i) => i.polarizedComponentCount === 0,
  },
  { area: 'Component spacing', fields: fields('componentSpacingViolationCount') },
  {
    area: 'Testpoint coverage',
    fields: (i) =>
      i.criticalNetNames?.length === 0
        ? ['criticalNetNames']
        : ['criticalNetNames', 'testPointNets'],
    invalid: (i) => (ambiguousTestpointInventory(i) ? ['criticalNetNames', 'testPointNets'] : []),
    skip: (i) => i.criticalNetNames?.length === 0,
  },
  {
    area: 'Programming access',
    fields: (i) =>
      i.requiresProgrammingHeader === false
        ? ['requiresProgrammingHeader']
        : ['requiresProgrammingHeader', 'hasProgrammingHeader'],
    skip: (i) => i.requiresProgrammingHeader === false,
  },
  { area: 'Fabrication notes', fields: fields('hasFabricationNotes') },
];

const RULES: RuleFn[] = [
  checkMissingOutline,
  checkOutlineTooSmall,
  checkMissingStackup,
  checkLayerCountMismatch,
  checkMissingMountingHoles,
  checkMissingNetClasses,
  checkInvalidClearance,
  checkKeepoutAreas,
  checkMissingPlacementZones,
  checkMissingManufacturingConstraints,
  checkFiducials,
  checkHighVoltageClearance,
  checkDrillFile,
  checkCopperToEdgeClearance,
  checkDrillManufacturability,
  checkSolderMaskSliver,
  checkSilkscreenOverPads,
  checkAssemblyAlignmentFeatures,
  checkPolarityMarks,
  checkComponentSpacing,
  checkTestpointCoverage,
  checkProgrammingHeader,
  checkFabricationNotes,
];

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run all PCB constraint validation rules against board data.
 *
 * Orchestrates 23 rules:
 *   1. Missing outline         — error  if board outline is not defined
 *   2. Outline too small       — warning if dimensions are below 5mm
 *   3. Missing stackup         — warning if no detailed layer stack
 *   4. Layer count mismatch    — error  if >2 layers without stackup
 *   5. Missing mounting holes  — warning if zero mounting holes
 *   6. Missing net classes     — warning if no routing rules
 *   7. Invalid clearance       — warning if net classes but no clearance rules
 *   8. Keepout violations      — warning if zones but no keepouts
 *   9. Missing placement zones — warning if multi-layer without zones
 *  10. Missing mfg constraints — warning if process/quantity unspecified
 *  11. Fiducials recommended   — warning if SMT board without fiducials
 *  12. High-voltage clearance  — error  if HV domain without proper clearance
 *  13. Drill file              — error  if NC drill file is missing
 *  14. Copper edge clearance   — error  if copper is too close to board edge
 *  15. Drill/annular ring      — warning if process dimensions are risky
 *  16. Soldermask sliver       — warning if soldermask web is too small
 *  17. Silkscreen over pad     — warning if silkscreen overlaps exposed pads
 *  18. Tooling holes           — warning if assembly tooling holes are missing
 *  19. Polarity marks          — warning if orientation-sensitive parts lack marks
 *  20. Component spacing       — warning if courtyard/spacing violations exist
 *  21. Testpoint coverage      — warning if critical nets lack test access
 *  22. Programming header      — error  if required debug/programming access is missing
 *  23. Fabrication notes       — warning if handoff notes are missing
 */
export function validatePcbConstraints(input: PcbConstraintInput): PcbConstraintResult {
  const errors: PcbConstraintIssue[] = [];
  const warnings: PcbConstraintIssue[] = [];
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  const unknownChecks: PcbConstraintResult['unknownChecks'] = [];

  for (const [index, rule] of RULES.entries()) {
    const evidence = RULE_EVIDENCE[index];
    if (!evidence) throw new Error(`Missing evidence contract for PCB rule ${index}`);
    const missing = evidence
      .fields(input)
      .filter((field) => input[field] === undefined || input[field] === null);
    if (missing.length === 0) missing.push(...(evidence.invalid?.(input) ?? []));
    if (missing.length > 0) {
      unknownChecks.push({ area: evidence.area, missingFields: [...new Set(missing)] });
      continue;
    }
    if (evidence.skip?.(input)) {
      notApplicable++;
      continue;
    }

    const issues = rule(input);
    if (issues.length === 0) passed++;
    else {
      failed++;
      for (const issue of issues) {
        if (issue.severity === 'error') errors.push(issue);
        else warnings.push(issue);
      }
    }
  }

  return {
    // UNKNOWN is never an approval, even if every observed check passed.
    valid: errors.length === 0 && unknownChecks.length === 0,
    errors,
    warnings,
    unknownChecks,
    summary: {
      totalChecks: RULES.length,
      passed,
      failed,
      notApplicable,
      unknown: unknownChecks.length,
    },
  };
}

/**
 * Build a human-readable constraint report explaining which constraints
 * were applied and which require manual review.
 */
export function buildConstraintReport(
  input: PcbConstraintInput,
  result: PcbConstraintResult,
): import('./types.js').ConstraintReport {
  const checked: Array<{
    area: string;
    status: 'passed' | 'failed' | 'not-applicable' | 'unknown';
    details: string;
  }> = [];
  const manualReviewRequired: Array<{ area: string; reason: string }> = [];

  // Build checked list from validation results
  const areaMap: Record<string, string> = {
    'Board outline': 'Board outline defines the physical board shape for fabrication',
    'Board dimensions': 'Minimum dimension check ensures manufacturability',
    'Layer stackup': 'Layer stackup defines material, thickness, and copper weight per layer',
    'Layer count': 'Layer count must match between intent and stackup',
    'Mounting holes': 'Mounting holes provide mechanical mounting and assembly alignment',
    'Net classes': 'Net classes enforce trace width and clearance for signal integrity',
    'Clearance rules': 'Clearance rules prevent shorts between different net classes',
    'Keepout areas': 'Keepout areas prevent component/track placement in restricted zones',
    'Placement zones': 'Placement zones guide component grouping for optimal layout',
    'Manufacturing constraints': 'Manufacturing constraints ensure correct fabrication process',
    Fiducials: 'Fiducial marks enable pick-and-place machine alignment',
    'High-voltage clearance': 'High-voltage clearance ensures safety against arcing',
  };

  // Determine which rules actually produced output
  const hasErrorsOrWarnings = result.errors.length > 0 || result.warnings.length > 0;

  if (input.hasOutline === false && !hasErrorsOrWarnings) {
    checked.push({
      area: 'Board outline',
      status: 'failed',
      details: areaMap['Board outline'] ?? '',
    });
  }

  // Missing native evidence remains visible to consumers, not a silent PASS.
  for (const unknown of result.unknownChecks) {
    const reason = `Cannot verify ${unknown.area}: missing ${unknown.missingFields.join(', ')}.`;
    checked.push({ area: unknown.area, status: 'unknown', details: reason });
    manualReviewRequired.push({ area: unknown.area, reason });
  }

  // Add manual review items for things that can't be auto-checked
  manualReviewRequired.push({
    area: 'Component placement',
    reason: 'AI-guided component placement requires human review before applying to PCB layout',
  });

  manualReviewRequired.push({
    area: 'Trace routing',
    reason: 'Automated trace routing may require manual optimization for signal integrity',
  });

  manualReviewRequired.push({
    area: 'Thermal management',
    reason: 'Thermal vias and copper pour areas should be verified against thermal simulation',
  });

  // Overall verdict
  let verdict: 'approved' | 'needs-review' | 'rejected';
  if (result.errors.length > 0) {
    verdict = 'rejected';
  } else if (result.warnings.length > 0 || manualReviewRequired.length > 0) {
    verdict = 'needs-review';
  } else {
    verdict = 'approved';
  }

  return {
    checked,
    manualReviewRequired,
    verdict,
  };
}

/**
 * Create PcbConstraintInput from a CircuitIR PCB intent object.
 */
export function fromPcbIntent(pcb: {
  boardOutline?: unknown;
  layerCount?: number;
  widthMm?: number;
  heightMm?: number;
  layerStack?: unknown[];
  netClasses?: unknown[];
  clearanceRules?: unknown[];
  keepoutAreas?: unknown[];
  placementZones?: unknown[];
  mountingHoles?: unknown[];
  fiducials?: unknown[];
  testPads?: unknown[];
  hasDrillFile?: boolean;
  minCopperToEdgeMm?: number;
  copperToEdgeViolationCount?: number;
  minDrillMm?: number;
  minAnnularRingMm?: number;
  minSolderMaskSliverMm?: number;
  solderMaskSliverViolationCount?: number;
  silkscreenOverPadCount?: number;
  smtComponentCount?: number;
  fiducialCount?: number;
  toolingHoleCount?: number;
  polarizedComponentCount?: number;
  polarityMarkCount?: number;
  componentSpacingViolationCount?: number;
  criticalNetNames?: string[];
  testPointNets?: string[];
  hasProgrammingHeader?: boolean;
  requiresProgrammingHeader?: boolean;
  hasFabricationNotes?: boolean;
  manufacturingProcess?: string;
  manufacturing?: { process?: string; quantity?: number };
  quantity?: number;
  highVoltage?: boolean;
}): PcbConstraintInput {
  return {
    widthMm: pcb.widthMm,
    heightMm: pcb.heightMm,
    layerCount: pcb.layerCount,
    hasOutline:
      pcb.boardOutline === undefined
        ? undefined
        : Array.isArray(pcb.boardOutline)
          ? pcb.boardOutline.length > 0
          : true,
    mountingHoleCount: pcb.mountingHoles?.length,
    hasLayerStack: pcb.layerStack === undefined ? undefined : pcb.layerStack.length > 0,
    hasNetClasses: pcb.netClasses === undefined ? undefined : pcb.netClasses.length > 0,
    hasClearanceRules: pcb.clearanceRules === undefined ? undefined : pcb.clearanceRules.length > 0,
    hasKeepoutAreas: pcb.keepoutAreas === undefined ? undefined : pcb.keepoutAreas.length > 0,
    hasPlacementZones: pcb.placementZones === undefined ? undefined : pcb.placementZones.length > 0,
    hasFiducials: pcb.fiducials === undefined ? undefined : pcb.fiducials.length > 0,
    hasTestPads: pcb.testPads === undefined ? undefined : pcb.testPads.length > 0,
    hasDrillFile: pcb.hasDrillFile,
    minCopperToEdgeMm: pcb.minCopperToEdgeMm,
    copperToEdgeViolationCount: pcb.copperToEdgeViolationCount,
    minDrillMm: pcb.minDrillMm,
    minAnnularRingMm: pcb.minAnnularRingMm,
    minSolderMaskSliverMm: pcb.minSolderMaskSliverMm,
    solderMaskSliverViolationCount: pcb.solderMaskSliverViolationCount,
    silkscreenOverPadCount: pcb.silkscreenOverPadCount,
    smtComponentCount: pcb.smtComponentCount,
    fiducialCount: pcb.fiducialCount ?? pcb.fiducials?.length,
    toolingHoleCount: pcb.toolingHoleCount,
    polarizedComponentCount: pcb.polarizedComponentCount,
    polarityMarkCount: pcb.polarityMarkCount,
    componentSpacingViolationCount: pcb.componentSpacingViolationCount,
    criticalNetNames: pcb.criticalNetNames,
    testPointNets: pcb.testPointNets,
    hasProgrammingHeader: pcb.hasProgrammingHeader,
    requiresProgrammingHeader: pcb.requiresProgrammingHeader,
    hasFabricationNotes: pcb.hasFabricationNotes,
    hasHighVoltage: pcb.highVoltage,
    manufacturingProcess: pcb.manufacturingProcess ?? pcb.manufacturing?.process,
    hasQuantity:
      pcb.quantity !== undefined || pcb.manufacturing?.quantity !== undefined
        ? (pcb.quantity ?? pcb.manufacturing?.quantity ?? 0) > 0
        : undefined,
  };
}

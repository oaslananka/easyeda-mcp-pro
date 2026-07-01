/**
 * Power-tree current budget and thermal analysis.
 *
 * @module
 */

import { powerError, powerWarning } from './errors.js';
import type {
  PowerCapacitorInput,
  PowerLoadInput,
  PowerProtectionInput,
  PowerRailInput,
  PowerRegulatorInput,
  PowerSourceInput,
  PowerTreeInput,
  PowerTreeIssue,
  PowerTreeLimits,
  PowerTreeReport,
  RailPowerReport,
  RegulatorThermalReport,
} from './types.js';

const DEFAULT_LIMITS: Required<PowerTreeLimits> = {
  minCurrentMarginPercent: 20,
  minThermalMarginC: 20,
  ambientTempC: 25,
  minBulkCapacitanceUfPerA: 47,
  minBulkCapacitanceUf: 10,
};

function mergeLimits(limits?: PowerTreeLimits): Required<PowerTreeLimits> {
  return { ...DEFAULT_LIMITS, ...limits };
}

function byRail<T extends { railId: string }>(items: T[] | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items ?? []) {
    const existing = map.get(item.railId) ?? [];
    existing.push(item);
    map.set(item.railId, existing);
  }
  return map;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function round(value: number | undefined, digits = 4): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function loadCurrent(loads: PowerLoadInput[]): number {
  return sum(loads.map((load) => load.currentA));
}

function peakCurrent(loads: PowerLoadInput[]): number {
  return sum(loads.map((load) => load.peakCurrentA ?? load.currentA));
}

function sourceCapacity(source: PowerSourceInput): number | undefined {
  const values = [source.maxCurrentA, source.currentLimitA].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

function regulatorCapacity(regulator: PowerRegulatorInput): number | undefined {
  const values = [regulator.maxOutputCurrentA, regulator.currentLimitA].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

function availableCurrentForRail(
  rail: PowerRailInput,
  sources: PowerSourceInput[],
  regulators: PowerRegulatorInput[],
): number | undefined {
  const capacities = [
    rail.maxCurrentA,
    ...sources.map(sourceCapacity),
    ...regulators.map(regulatorCapacity),
  ].filter((value): value is number => value !== undefined);
  if (capacities.length === 0) return undefined;
  return Math.min(...capacities);
}

function railProtections(
  rail: PowerRailInput,
  protections: PowerProtectionInput[],
): PowerProtectionInput[] {
  return protections.filter((protection) => protection.railId === rail.id);
}

function railBulkCapacitance(rail: PowerRailInput, capacitors: PowerCapacitorInput[]): number {
  return sum(
    capacitors
      .filter(
        (capacitor) =>
          capacitor.railId === rail.id && ['bulk', 'input', 'hold-up'].includes(capacitor.role),
      )
      .map((capacitor) => capacitor.capacitanceUf),
  );
}

function requiredBulkCapacitance(loadA: number, limits: Required<PowerTreeLimits>): number {
  return Math.max(limits.minBulkCapacitanceUf, loadA * limits.minBulkCapacitanceUfPerA);
}

function railIsProtectionSensitive(rail: PowerRailInput, sources: PowerSourceInput[]): boolean {
  return Boolean(
    rail.requiresProtection ||
    rail.external ||
    sources.some(
      (source) =>
        source.requiresProtection ||
        ['usb', 'battery', 'barrel-jack', 'external', 'ac-dc'].includes(source.kind),
    ),
  );
}

function createRailReport(
  rail: PowerRailInput,
  loads: PowerLoadInput[],
  sources: PowerSourceInput[],
  regulators: PowerRegulatorInput[],
  protections: PowerProtectionInput[],
  capacitors: PowerCapacitorInput[],
  limits: Required<PowerTreeLimits>,
): { report: RailPowerReport; issues: PowerTreeIssue[] } {
  const issues: PowerTreeIssue[] = [];
  const railLoadCurrent = loadCurrent(loads);
  const railPeakCurrent = peakCurrent(loads);
  const availableCurrentA = availableCurrentForRail(rail, sources, regulators);
  const marginA = availableCurrentA === undefined ? undefined : availableCurrentA - railPeakCurrent;
  const marginPercent =
    availableCurrentA === undefined || availableCurrentA === 0
      ? undefined
      : ((marginA ?? 0) / availableCurrentA) * 100;
  const protectionsOnRail = railProtections(rail, protections);
  const bulkCapacitanceUf = railBulkCapacitance(rail, capacitors);
  const requiresBulk = Boolean(
    rail.requiresBulkCapacitance || railLoadCurrent > 0.25 || railPeakCurrent > 0.5,
  );
  const requiredBulkUf = requiresBulk
    ? requiredBulkCapacitance(railPeakCurrent, limits)
    : undefined;

  if (availableCurrentA !== undefined && railPeakCurrent > availableCurrentA) {
    issues.push(
      powerError(
        'POWER_RAIL_OVERCURRENT',
        `Rail ${rail.name} peak load ${round(railPeakCurrent)}A exceeds available current ${round(availableCurrentA)}A`,
        {
          railId: rail.id,
          railName: rail.name,
          remediationHint:
            'Reduce load current, choose a higher-current source/regulator, or split the rail into separately protected branches.',
          details: { peakCurrentA: railPeakCurrent, availableCurrentA, marginA },
        },
      ),
    );
  } else if (marginPercent !== undefined && marginPercent < limits.minCurrentMarginPercent) {
    issues.push(
      powerWarning(
        'POWER_RAIL_LOW_MARGIN',
        `Rail ${rail.name} current margin is ${round(marginPercent, 1)}%, below ${limits.minCurrentMarginPercent}%`,
        {
          railId: rail.id,
          railName: rail.name,
          remediationHint:
            'Increase source/regulator current rating or reduce peak load so the rail has adequate transient and tolerance margin.',
          details: { peakCurrentA: railPeakCurrent, availableCurrentA, marginA, marginPercent },
        },
      ),
    );
  }

  if (railIsProtectionSensitive(rail, sources) && protectionsOnRail.length === 0) {
    issues.push(
      powerWarning(
        'POWER_SOURCE_MISSING_PROTECTION',
        `Rail ${rail.name} is externally sourced or protection-sensitive but has no declared input protection`,
        {
          railId: rail.id,
          railName: rail.name,
          remediationHint:
            'Add fuse/polyfuse, reverse-polarity protection, TVS/ESD protection, or a current-limited switch near the connector/source.',
          details: {
            sourceKinds: sources.map((source) => source.kind),
            requiresProtection: rail.requiresProtection,
          },
        },
      ),
    );
  }

  if (requiresBulk && requiredBulkUf !== undefined && bulkCapacitanceUf < requiredBulkUf) {
    issues.push(
      powerWarning(
        'POWER_MISSING_BULK_CAPACITANCE',
        `Rail ${rail.name} has ${round(bulkCapacitanceUf, 2)}µF bulk capacitance; ${round(requiredBulkUf, 2)}µF is recommended for ${round(railPeakCurrent)}A peak load`,
        {
          railId: rail.id,
          railName: rail.name,
          remediationHint:
            'Add appropriately voltage-rated bulk capacitance near the source/regulator and local decoupling near loads.',
          details: {
            bulkCapacitanceUf,
            requiredBulkCapacitanceUf: requiredBulkUf,
            peakCurrentA: railPeakCurrent,
          },
        },
      ),
    );
  }

  const report: RailPowerReport = {
    railId: rail.id,
    railName: rail.name,
    voltage: rail.voltage,
    loadCurrentA: round(railLoadCurrent) ?? railLoadCurrent,
    peakCurrentA: round(railPeakCurrent) ?? railPeakCurrent,
    availableCurrentA: round(availableCurrentA),
    marginA: round(marginA),
    marginPercent: round(marginPercent, 2),
    loadCount: loads.length,
    sourceRefs: sources.map((source) => source.id),
    regulatorRefs: regulators.map((regulator) => regulator.id),
    protectionRefs: protectionsOnRail.map((protection) => protection.ref ?? protection.id),
    bulkCapacitanceUf: round(bulkCapacitanceUf, 2) ?? bulkCapacitanceUf,
    requiredBulkCapacitanceUf: round(requiredBulkUf, 2),
    passed: !issues.some((issue) => issue.severity === 'error'),
  };

  return { report, issues };
}

function regulatorInputVoltage(
  regulator: PowerRegulatorInput,
  rails: Map<string, PowerRailInput>,
): number {
  return regulator.inputVoltage ?? rails.get(regulator.inputRailId)?.voltage ?? 0;
}

function regulatorOutputVoltage(
  regulator: PowerRegulatorInput,
  rails: Map<string, PowerRailInput>,
): number {
  return regulator.outputVoltage ?? rails.get(regulator.outputRailId)?.voltage ?? 0;
}

function estimateDissipationW(
  regulator: PowerRegulatorInput,
  inputVoltage: number,
  outputVoltage: number,
  outputCurrentA: number,
): number | undefined {
  if (outputCurrentA <= 0) return 0;
  if (regulator.kind === 'ldo' || regulator.kind === 'linear') {
    return Math.max(0, inputVoltage - outputVoltage) * outputCurrentA;
  }
  if (regulator.kind === 'load-switch') {
    return undefined;
  }
  const efficiency = regulator.efficiency;
  if (efficiency === undefined || efficiency <= 0 || efficiency > 1) return undefined;
  const outputPower = outputVoltage * outputCurrentA;
  return outputPower * (1 / efficiency - 1);
}

function createRegulatorReport(
  regulator: PowerRegulatorInput,
  outputLoads: PowerLoadInput[],
  rails: Map<string, PowerRailInput>,
  limits: Required<PowerTreeLimits>,
): { report: RegulatorThermalReport; issues: PowerTreeIssue[] } {
  const issues: PowerTreeIssue[] = [];
  const inputVoltage = regulatorInputVoltage(regulator, rails);
  const outputVoltage = regulatorOutputVoltage(regulator, rails);
  const outputCurrentA = peakCurrent(outputLoads);
  const capacity = regulatorCapacity(regulator);
  const currentMarginA = capacity === undefined ? undefined : capacity - outputCurrentA;
  const currentMarginPercent =
    capacity === undefined || capacity === 0 ? undefined : ((currentMarginA ?? 0) / capacity) * 100;
  const dropoutMarginV =
    regulator.dropoutVoltage === undefined
      ? undefined
      : inputVoltage - outputVoltage - regulator.dropoutVoltage;
  const dissipationW = estimateDissipationW(regulator, inputVoltage, outputVoltage, outputCurrentA);
  const estimatedJunctionTempC =
    dissipationW !== undefined && regulator.thermalResistanceCPerW !== undefined
      ? limits.ambientTempC + dissipationW * regulator.thermalResistanceCPerW
      : undefined;
  const thermalMarginC =
    estimatedJunctionTempC !== undefined && regulator.maxJunctionTempC !== undefined
      ? regulator.maxJunctionTempC - estimatedJunctionTempC
      : undefined;

  if (capacity !== undefined && outputCurrentA > capacity) {
    issues.push(
      powerError(
        'POWER_REGULATOR_OVERLOAD',
        `Regulator ${regulator.ref ?? regulator.id} output current ${round(outputCurrentA)}A exceeds capacity ${round(capacity)}A`,
        {
          railId: regulator.outputRailId,
          railName: rails.get(regulator.outputRailId)?.name,
          componentRef: regulator.ref ?? regulator.id,
          remediationHint:
            'Choose a regulator with higher output-current rating, reduce load, or split the load across multiple rails.',
          details: { outputCurrentA, capacity, currentMarginA },
        },
      ),
    );
  }

  if (dropoutMarginV !== undefined && dropoutMarginV < 0) {
    issues.push(
      powerError(
        'POWER_REGULATOR_DROPOUT',
        `Regulator ${regulator.ref ?? regulator.id} dropout margin is ${round(dropoutMarginV, 3)}V`,
        {
          railId: regulator.outputRailId,
          railName: rails.get(regulator.outputRailId)?.name,
          componentRef: regulator.ref ?? regulator.id,
          remediationHint:
            'Increase input voltage headroom, choose a lower-dropout regulator, or reduce the output voltage requirement.',
          details: {
            inputVoltage,
            outputVoltage,
            dropoutVoltage: regulator.dropoutVoltage,
            dropoutMarginV,
          },
        },
      ),
    );
  }

  if (thermalMarginC !== undefined && thermalMarginC < 0) {
    issues.push(
      powerError(
        'POWER_REGULATOR_THERMAL_OVER_LIMIT',
        `Regulator ${regulator.ref ?? regulator.id} estimated junction temperature ${round(estimatedJunctionTempC, 1)}°C exceeds limit ${regulator.maxJunctionTempC}°C`,
        {
          railId: regulator.outputRailId,
          railName: rails.get(regulator.outputRailId)?.name,
          componentRef: regulator.ref ?? regulator.id,
          remediationHint:
            'Reduce dissipation, improve thermal resistance with copper/thermal vias, lower input voltage, use a switching regulator, or choose a higher-power package.',
          details: {
            dissipationW,
            estimatedJunctionTempC,
            thermalMarginC,
            maxJunctionTempC: regulator.maxJunctionTempC,
          },
        },
      ),
    );
  } else if (thermalMarginC !== undefined && thermalMarginC < limits.minThermalMarginC) {
    issues.push(
      powerWarning(
        'POWER_REGULATOR_THERMAL_RISK',
        `Regulator ${regulator.ref ?? regulator.id} thermal margin is ${round(thermalMarginC, 1)}°C`,
        {
          railId: regulator.outputRailId,
          railName: rails.get(regulator.outputRailId)?.name,
          componentRef: regulator.ref ?? regulator.id,
          remediationHint:
            'Increase thermal margin by reducing load, improving copper area, using a more efficient regulator, or selecting a lower thermal-resistance package.',
          details: {
            dissipationW,
            estimatedJunctionTempC,
            thermalMarginC,
            minThermalMarginC: limits.minThermalMarginC,
          },
        },
      ),
    );
  }

  const report: RegulatorThermalReport = {
    regulatorId: regulator.id,
    ref: regulator.ref,
    kind: regulator.kind,
    inputRailId: regulator.inputRailId,
    outputRailId: regulator.outputRailId,
    inputVoltage: round(inputVoltage) ?? inputVoltage,
    outputVoltage: round(outputVoltage) ?? outputVoltage,
    outputCurrentA: round(outputCurrentA) ?? outputCurrentA,
    maxOutputCurrentA: round(capacity),
    currentMarginA: round(currentMarginA),
    currentMarginPercent: round(currentMarginPercent, 2),
    dropoutMarginV: round(dropoutMarginV, 4),
    estimatedDissipationW: round(dissipationW, 4),
    estimatedJunctionTempC: round(estimatedJunctionTempC, 2),
    thermalMarginC: round(thermalMarginC, 2),
    passed: !issues.some((issue) => issue.severity === 'error'),
  };

  return { report, issues };
}

function checkSequencing(
  input: PowerTreeInput,
  railsById: Map<string, PowerRailInput>,
): PowerTreeIssue[] {
  const issues: PowerTreeIssue[] = [];
  for (const rail of input.rails) {
    for (const dependency of rail.sequenceAfterRailRefs ?? []) {
      if (!railsById.has(dependency)) {
        issues.push(
          powerWarning(
            'POWER_SEQUENCE_MISSING',
            `Rail ${rail.name} has sequencing dependency ${dependency}, but that rail is not modeled`,
            {
              railId: rail.id,
              railName: rail.name,
              remediationHint:
                'Add the upstream rail to the power-tree model or remove the stale sequencing dependency.',
              details: { sequenceAfterRailRef: dependency },
            },
          ),
        );
      }
    }
  }
  return issues;
}

function buildHumanSummary(report: Omit<PowerTreeReport, 'summary'>): string {
  const railSummary = `${report.rails.length} rail${report.rails.length === 1 ? '' : 's'}`;
  const regulatorSummary = `${report.regulators.length} regulator${report.regulators.length === 1 ? '' : 's'}`;
  const errorCount = report.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = report.issues.filter((issue) => issue.severity === 'warning').length;

  if (errorCount > 0) {
    return `Power tree failed: ${railSummary}, ${regulatorSummary}, ${errorCount} error(s), ${warningCount} warning(s). Resolve blocking overcurrent, dropout, or thermal issues before release.`;
  }
  if (warningCount > 0) {
    return `Power tree needs review: ${railSummary}, ${regulatorSummary}, 0 errors, ${warningCount} warning(s). Review margin, protection, and capacitance warnings.`;
  }
  return `Power tree passed: ${railSummary}, ${regulatorSummary}, no errors or warnings.`;
}

/** Analyze current budget, regulator dissipation, protection, and bulk capacitance. */
export function analyzePowerTree(input: PowerTreeInput): PowerTreeReport {
  const limits = mergeLimits(input.limits);
  const railsById = new Map(input.rails.map((rail) => [rail.id, rail]));
  const loadsByRail = byRail(input.loads);
  const sourcesByRail = byRail(input.sources);
  const regulatorsByOutputRail = new Map<string, PowerRegulatorInput[]>();
  for (const regulator of input.regulators ?? []) {
    const existing = regulatorsByOutputRail.get(regulator.outputRailId) ?? [];
    existing.push(regulator);
    regulatorsByOutputRail.set(regulator.outputRailId, existing);
  }

  const allIssues: PowerTreeIssue[] = [];
  const railReports: RailPowerReport[] = [];

  for (const rail of input.rails) {
    const { report, issues } = createRailReport(
      rail,
      loadsByRail.get(rail.id) ?? [],
      sourcesByRail.get(rail.id) ?? [],
      regulatorsByOutputRail.get(rail.id) ?? [],
      input.protections ?? [],
      input.capacitors ?? [],
      limits,
    );
    railReports.push(report);
    allIssues.push(...issues);
  }

  const regulatorReports: RegulatorThermalReport[] = [];
  for (const regulator of input.regulators ?? []) {
    const { report, issues } = createRegulatorReport(
      regulator,
      loadsByRail.get(regulator.outputRailId) ?? [],
      railsById,
      limits,
    );
    regulatorReports.push(report);
    allIssues.push(...issues);
  }

  allIssues.push(...checkSequencing(input, railsById));

  const errorCount = allIssues.filter((issue) => issue.severity === 'error').length;
  const warningCount = allIssues.filter((issue) => issue.severity === 'warning').length;
  const partialReport = {
    projectId: input.projectId ?? '',
    passed: errorCount === 0,
    rails: railReports,
    regulators: regulatorReports,
    issues: allIssues,
  };

  return {
    ...partialReport,
    summary: {
      railCount: input.rails.length,
      sourceCount: input.sources?.length ?? 0,
      regulatorCount: input.regulators?.length ?? 0,
      loadCount: input.loads?.length ?? 0,
      totalLoadCurrentA: round(sum(railReports.map((rail) => rail.loadCurrentA))) ?? 0,
      totalPeakCurrentA: round(sum(railReports.map((rail) => rail.peakCurrentA))) ?? 0,
      errorCount,
      warningCount,
      passed: errorCount === 0,
      humanSummary: buildHumanSummary(partialReport),
    },
  };
}

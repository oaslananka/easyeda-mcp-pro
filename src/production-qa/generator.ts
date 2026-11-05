import type {
  ProductionQaReport,
  QaArtifact,
  QaAssemblyComponentInput,
  QaBoardInput,
  QaChecklistItem,
  QaCriticalNetInput,
  QaIssue,
} from './types.js';

function issue(
  code: QaIssue['code'],
  severity: QaIssue['severity'],
  message: string,
  remediationHint: string,
  details?: Record<string, unknown>,
): QaIssue {
  return { code, severity, message, remediationHint, details };
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  );
}

function checklistId(prefix: string, value: string): string {
  return `${prefix}-${slug(value)}`;
}

function exactTestPointReference(ref: string | undefined): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.trim() === ref;
}

function uniqueChecklistId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function testpointEvidenceStatus(
  net: QaCriticalNetInput,
  duplicate: boolean,
  missing: boolean,
): QaChecklistItem['status'] {
  if (missing) return 'fail';
  return !duplicate &&
    net.name.length > 0 &&
    net.name.trim() === net.name &&
    exactTestPointReference(net.testPointRef)
    ? 'pass'
    : 'review';
}

function requiredCriticalNets(input: QaBoardInput): QaCriticalNetInput[] {
  return (input.criticalNets ?? []).filter((net) => net.required !== false);
}

function componentsWithNotes(input: QaBoardInput): QaAssemblyComponentInput[] {
  return (input.components ?? []).filter(
    (component) =>
      component.polarized ||
      component.specialHandling ||
      component.doNotPopulate ||
      component.side === 'bottom',
  );
}

function generateIssues(input: QaBoardInput): QaIssue[] {
  const issues: QaIssue[] = [];

  for (const net of requiredCriticalNets(input)) {
    if (!net.hasTestPoint) {
      issues.push(
        issue(
          'QA_CRITICAL_NET_MISSING_TESTPOINT',
          'error',
          `Critical net ${net.name} is missing test access`,
          'Add a labeled test pad/probe for this critical net or explicitly mark it as not required for production test.',
          { netName: net.name, category: net.category },
        ),
      );
    }
  }

  for (const component of input.components ?? []) {
    if (component.polarized && !component.orientationMark) {
      issues.push(
        issue(
          'QA_POLARITY_NOTE_MISSING',
          'warning',
          `Polarized component ${component.ref} lacks an orientation mark or note`,
          'Add clear silkscreen or assembly-note orientation guidance before handoff.',
          { ref: component.ref, value: component.value, footprint: component.footprint },
        ),
      );
    }
  }

  if (input.requiresProgramming && !input.hasProgrammingAccess) {
    issues.push(
      issue(
        'QA_PROGRAMMING_ACCESS_REQUIRED',
        'error',
        'Programming or debug access is required but not declared',
        'Add a programming connector or documented test-pad access for the programming/debug interface.',
        { programmingInterfaces: input.programmingInterfaces ?? [] },
      ),
    );
  }

  if (input.hasBattery) {
    issues.push(
      issue(
        'QA_ASSEMBLY_HANDLING_NOTE_REQUIRED',
        'warning',
        'Board requires battery handling notes',
        'Add assembly and QA handling notes covering battery polarity, isolation, and first-power inspection.',
        { hasBattery: input.hasBattery },
      ),
    );
  }

  if ((input.criticalNets ?? []).some((net) => net.category === 'power')) {
    issues.push(
      issue(
        'QA_BRINGUP_POWER_STEP_REQUIRED',
        'info',
        'Power-rail bring-up steps should be included in the QA package',
        'Measure each power rail under current limit before programming or connecting external loads.',
      ),
    );
  }

  return issues;
}

function assemblyChecklistStatus(component: QaAssemblyComponentInput): 'pass' | 'review' {
  return (component.polarized && !component.orientationMark) || !component.side ? 'review' : 'pass';
}

function makeTestpointChecklistItem(
  net: QaCriticalNetInput,
  netCounts: Map<string, number>,
  refCounts: Map<string, number>,
  missingTp: Set<string>,
  usedIds: Set<string>,
): QaChecklistItem {
  const duplicate = (netCounts.get(net.name) ?? 0) !== 1;
  const exactNet = !duplicate && net.name.length > 0 && net.name.trim() === net.name;
  const testPointRef = net.testPointRef;
  const refValid = exactTestPointReference(testPointRef);
  const duplicateRef = refValid && (refCounts.get(testPointRef) ?? 0) > 1;
  const verifiedRef = exactNet && refValid && !duplicateRef ? testPointRef : undefined;
  return {
    id: uniqueChecklistId(checklistId('tp', net.name), usedIds),
    title: `Verify test access for ${net.name}`,
    category: 'testpoint',
    required: true,
    status: testpointEvidenceStatus(net, duplicate || duplicateRef, missingTp.has(net.name)),
    details: !net.hasTestPoint
      ? 'No test point declared'
      : !exactNet
        ? 'Critical net identity is missing or ambiguous; verify test access.'
        : duplicateRef
          ? 'Test point reference reused across critical nets; verify physical access.'
          : refValid
            ? `Declared test point: ${net.testPointRef}`
            : 'Test point declared without an exact reference; verify test access.',
    refs: verifiedRef ? [verifiedRef] : undefined,
  };
}

function generateTestpointChecklist(input: QaBoardInput, issues: QaIssue[]): QaChecklistItem[] {
  const checklist: QaChecklistItem[] = [];
  const missingTp = new Set(
    issues
      .filter((entry) => entry.code === 'QA_CRITICAL_NET_MISSING_TESTPOINT')
      .map((entry) => String(entry.details?.netName ?? '')),
  );

  const requiredNets = requiredCriticalNets(input);
  const netCounts = new Map<string, number>();
  const refCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  for (const net of requiredNets) {
    netCounts.set(net.name, (netCounts.get(net.name) ?? 0) + 1);
    if (net.hasTestPoint && exactTestPointReference(net.testPointRef)) {
      refCounts.set(net.testPointRef, (refCounts.get(net.testPointRef) ?? 0) + 1);
    }
  }

  for (const net of requiredNets) {
    checklist.push(makeTestpointChecklistItem(net, netCounts, refCounts, missingTp, usedIds));
  }

  return checklist;
}

function generateChecklist(input: QaBoardInput, issues: QaIssue[]): QaChecklistItem[] {
  const checklist = generateTestpointChecklist(input, issues);

  for (const component of componentsWithNotes(input)) {
    checklist.push({
      id: checklistId('asm', component.ref),
      title: `Assembly note for ${component.ref}`,
      category: 'assembly',
      required: Boolean(component.polarized || component.specialHandling),
      status: assemblyChecklistStatus(component),
      details: [
        component.value ? `Value: ${component.value}` : undefined,
        component.footprint ? `Footprint: ${component.footprint}` : undefined,
        component.polarized ? 'Orientation-sensitive' : undefined,
        component.doNotPopulate ? 'DNP' : undefined,
        component.side ? `Side: ${component.side}` : 'Side: unverified',
        component.specialHandling,
      ]
        .filter(Boolean)
        .join('; '),
      refs: [component.ref],
    });
  }

  checklist.push({
    id: 'bringup-visual-inspection',
    title: 'Visual inspection before bench test',
    category: 'bringup',
    required: true,
    status: 'review',
    details:
      'Inspect solder bridges, orientation, connector polarity, DNP placements, and mechanical interference.',
  });

  checklist.push({
    id: 'bringup-rail-check',
    title: 'Bench supply rail check',
    category: 'bringup',
    required: true,
    status: 'review',
    details: 'Verify all declared power rails before programming or external load connection.',
  });

  if (input.requiresProgramming) {
    checklist.push({
      id: 'programming-access',
      title: 'Verify programming/debug access',
      category: 'programming',
      required: true,
      status: input.hasProgrammingAccess ? 'pass' : 'fail',
      details: `Interfaces: ${(input.programmingInterfaces ?? ['unspecified']).join(', ')}`,
    });
  }

  if (input.requiresFunctionalTest) {
    checklist.push({
      id: 'functional-test',
      title: 'Run production functional test',
      category: 'qa',
      required: true,
      status: 'review',
      details:
        'Run firmware, communication, sensor/actuator, and acceptance-threshold tests defined for this board.',
    });
  }

  return checklist;
}

function mdTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0] ?? [];
  const sep = header.map(() => '---');
  return [header, sep, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function testpointChecklistMarkdown(input: QaBoardInput, checklist: QaChecklistItem[]): string {
  const testpointItems = checklist.filter((entry) => entry.category === 'testpoint');
  const rows = [
    ['Net', 'Category', 'Required', 'Status', 'Test point'],
    ...requiredCriticalNets(input).map((net, index) => {
      const item = testpointItems[index];
      return [
        net.name,
        net.category ?? 'custom',
        net.required === false ? 'no' : 'yes',
        item?.status ?? 'review',
        exactTestPointReference(net.testPointRef) && item?.status === 'pass'
          ? net.testPointRef
          : net.hasTestPoint
            ? 'unverified'
            : 'missing',
      ];
    }),
  ];
  return `# Testpoint Checklist\n\n${mdTable(rows)}\n`;
}

function assemblyNotesMarkdown(input: QaBoardInput): string {
  const rows = [
    ['Ref', 'Value', 'Footprint', 'Side', 'Note'],
    ...componentsWithNotes(input).map((component) => [
      component.ref,
      component.value ?? '',
      component.footprint ?? '',
      component.side ?? 'unverified',
      [
        component.polarized
          ? `Orientation mark: ${component.orientationMark ? 'yes' : 'missing'}`
          : undefined,
        component.doNotPopulate ? 'DNP' : undefined,
        component.specialHandling,
      ]
        .filter(Boolean)
        .join('; '),
    ]),
  ];
  return `# Assembly Notes\n\n${mdTable(rows)}\n`;
}

function bringupPlanMarkdown(input: QaBoardInput, checklist: QaChecklistItem[]): string {
  const testpointItems = checklist.filter((entry) => entry.category === 'testpoint');
  const rails = requiredCriticalNets(input)
    .map((net, index) => ({ net, status: testpointItems[index]?.status }))
    .filter(({ net }) => net.category === 'power' || net.category === 'ground');
  const railLines = rails.length
    ? rails
        .map(({ net, status }, index) =>
          status === 'pass' && exactTestPointReference(net.testPointRef)
            ? `${index + 1}. Measure ${net.name} at declared point ${net.testPointRef} after verifying accessibility.`
            : `${index + 1}. Identify and verify test access for ${net.name} before measurement.`,
        )
        .join('\n')
    : '1. Measure all declared power rails and ground references.';

  return `# Bring-up Plan\n\n1. Visual inspection.\n2. Bench supply rail check.\n${railLines}\n${input.requiresProgramming ? '4. Program/debug the board after rails are verified.\n' : '4. Continue to functional QA after rails are verified.\n'}`;
}

function qaChecklistMarkdown(checklist: QaChecklistItem[]): string {
  const rows = [
    ['ID', 'Category', 'Required', 'Status', 'Title'],
    ...checklist.map((item) => [
      item.id,
      item.category,
      item.required ? 'yes' : 'no',
      item.status,
      item.title,
    ]),
  ];
  return `# Production QA Checklist\n\n${mdTable(rows)}\n`;
}

function generateArtifacts(
  input: QaBoardInput,
  checklist: QaChecklistItem[],
  reportJson: unknown,
): QaArtifact[] {
  const base = slug(input.projectName ?? input.projectId ?? 'project');
  return [
    {
      filename: `${base}-testpoint-checklist.md`,
      fileType: 'markdown',
      role: 'testpoint-checklist',
      content: testpointChecklistMarkdown(input, checklist),
      required: true,
    },
    {
      filename: `${base}-assembly-notes.md`,
      fileType: 'markdown',
      role: 'assembly-notes',
      content: assemblyNotesMarkdown(input),
      required: true,
    },
    {
      filename: `${base}-bringup-plan.md`,
      fileType: 'markdown',
      role: 'bringup-plan',
      content: bringupPlanMarkdown(input, checklist),
      required: true,
    },
    {
      filename: `${base}-production-qa-checklist.md`,
      fileType: 'markdown',
      role: 'production-qa-checklist',
      content: qaChecklistMarkdown(checklist),
      required: true,
    },
    {
      filename: `${base}-production-qa.json`,
      fileType: 'json',
      role: 'qa-manifest',
      content: JSON.stringify(reportJson, null, 2),
      required: true,
    },
  ];
}

export function generateProductionQaArtifacts(input: QaBoardInput): ProductionQaReport {
  const issues = generateIssues(input);
  const checklist = generateChecklist(input, issues);
  const errorCount = issues.filter((entry) => entry.severity === 'error').length;
  const warningCount = issues.filter((entry) => entry.severity === 'warning').length;
  const missingTestpointCount = issues.filter(
    (entry) => entry.code === 'QA_CRITICAL_NET_MISSING_TESTPOINT',
  ).length;
  const assemblyNoteCount = componentsWithNotes(input).length;
  const partial = {
    projectId: input.projectId ?? '',
    projectName: input.projectName,
    revision: input.revision,
    passed: errorCount === 0,
    issues,
    checklist,
    artifacts: [] as QaArtifact[],
    summary: {
      criticalNetCount: requiredCriticalNets(input).length,
      missingTestpointCount,
      assemblyNoteCount,
      checklistItemCount: checklist.length,
      errorCount,
      warningCount,
      humanSummary:
        errorCount > 0
          ? `Production QA package blocked by ${errorCount} error(s) and ${warningCount} warning(s).`
          : warningCount > 0
            ? `Production QA package generated with ${warningCount} warning(s) for review.`
            : 'Production QA package generated with no blocking issues.',
    },
  } satisfies ProductionQaReport;

  return {
    ...partial,
    artifacts: generateArtifacts(input, checklist, {
      projectId: partial.projectId,
      projectName: partial.projectName,
      revision: partial.revision,
      passed: partial.passed,
      issues: partial.issues,
      checklist: partial.checklist,
      summary: partial.summary,
    }),
  };
}

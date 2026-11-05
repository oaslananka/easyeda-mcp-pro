import { describe, it, expect } from 'vitest';
import { generateProductionQaArtifacts } from '../../../src/production-qa/index.js';

describe('generateProductionQaArtifacts', () => {
  it('generates QA artifacts for a complete production-ready board', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'proj-qa',
      projectName: 'Sensor Board',
      revision: 'A1',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true, testPointRef: 'TP1' },
        { name: '3V3', category: 'power', hasTestPoint: true, testPointRef: 'TP2' },
        { name: 'RESET', category: 'reset', hasTestPoint: true, testPointRef: 'TP3' },
        { name: 'SWDIO', category: 'programming', hasTestPoint: true, testPointRef: 'TP4' },
      ],
      components: [
        {
          ref: 'D1',
          value: 'LED',
          footprint: '0603',
          polarized: true,
          orientationMark: true,
          side: 'top',
        },
      ],
      requiresProgramming: true,
      programmingInterfaces: ['SWD'],
      hasProgrammingAccess: true,
      requiresFunctionalTest: true,
    });

    expect(report.passed).toBe(true);
    expect(report.summary.missingTestpointCount).toBe(0);
    expect(report.summary.criticalNetCount).toBe(4);
    expect(report.artifacts.map((artifact) => artifact.role)).toEqual([
      'testpoint-checklist',
      'assembly-notes',
      'bringup-plan',
      'production-qa-checklist',
      'qa-manifest',
    ]);
    expect(report.artifacts[0].content).toContain('TP1');
    expect(report.artifacts[1].content).toContain('D1');
  });

  it('flags missing test access on required critical nets', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'proj-qa',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true, testPointRef: 'TP1' },
        { name: '3V3', category: 'power', hasTestPoint: false },
        { name: 'RESET', category: 'reset' },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.summary.missingTestpointCount).toBe(2);
    expect(
      report.issues.filter((issue) => issue.code === 'QA_CRITICAL_NET_MISSING_TESTPOINT'),
    ).toHaveLength(2);
    expect(report.checklist.find((item) => item.id === 'tp-3v3')?.status).toBe('fail');
  });

  it('flags missing programming access and missing component orientation notes', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'proj-qa',
      requiresProgramming: true,
      programmingInterfaces: ['SWD', 'UART'],
      hasProgrammingAccess: false,
      components: [
        { ref: 'U1', value: 'MCU', footprint: 'QFN', polarized: true, orientationMark: false },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['QA_PROGRAMMING_ACCESS_REQUIRED', 'QA_POLARITY_NOTE_MISSING']),
    );
    expect(report.checklist.find((item) => item.id === 'programming-access')?.status).toBe('fail');
  });

  it('does not invent a top-side placement when assembly side is missing', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'unverified-side',
      components: [
        { ref: 'D1', polarized: true, orientationMark: true },
        { ref: 'R99', doNotPopulate: true },
        { ref: 'J2', side: 'bottom', specialHandling: 'Hand assemble' },
      ],
    });

    const assembly = report.artifacts.find((artifact) => artifact.role === 'assembly-notes');
    const lines = assembly?.content.split('\n') ?? [];
    expect(lines.find((line) => line.includes('| D1 |'))).toContain('| unverified |');
    expect(lines.find((line) => line.includes('| R99 |'))).toContain('| unverified |');
    expect(lines.find((line) => line.includes('| J2 |'))).toContain('| bottom |');
    expect(report.checklist.find((item) => item.id === 'asm-d1')).toMatchObject({
      status: 'review',
      required: true,
    });
    expect(report.checklist.find((item) => item.id === 'asm-r99')).toMatchObject({
      status: 'review',
      required: false,
    });
    expect(report.checklist.find((item) => item.id === 'asm-j2')?.status).toBe('pass');
    expect(report.checklist.find((item) => item.id === 'asm-d1')?.details).toContain(
      'Side: unverified',
    );
    expect(report.artifacts.find((artifact) => artifact.role === 'qa-manifest')?.content).toContain(
      'Side: unverified',
    );
  });

  it('keeps colliding slug net identities distinct in testpoint checklist rows', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'slug-collision',
      criticalNets: [
        { name: 'VCC+', hasTestPoint: true, testPointRef: 'TP1' },
        { name: 'VCC-', hasTestPoint: false },
        { name: 'VCC-2', hasTestPoint: true, testPointRef: 'TP3' },
      ],
    });
    const entries = report.checklist.filter((item) => item.category === 'testpoint');
    expect(new Set(entries.map((item) => item.id)).size).toBe(3);
    expect(entries.map((item) => item.status)).toEqual(['pass', 'fail', 'pass']);
    const md = report.artifacts.find((item) => item.role === 'testpoint-checklist')?.content;
    expect(md).toContain('| VCC+ | custom | yes | pass | TP1 |');
    expect(md).toContain('| VCC- | custom | yes | fail | missing |');
    expect(md).toContain('| VCC-2 | custom | yes | pass | TP3 |');
    expect(report.passed).toBe(false);
  });

  it('keeps missing testpoint refs and duplicated exact net names under review', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'unverified-test-access',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true },
        { name: 'RESET', hasTestPoint: true, testPointRef: ' TP2' },
        { name: 'SENSE', hasTestPoint: true, testPointRef: 'TP3' },
        { name: 'SENSE', hasTestPoint: true, testPointRef: 'TP4' },
        { name: 'VCC', hasTestPoint: true, testPointRef: 'TP5' },
      ],
    });
    const entries = report.checklist.filter((item) => item.category === 'testpoint');
    expect(entries.map((item) => item.status)).toEqual([
      'review',
      'review',
      'review',
      'review',
      'pass',
    ]);
    expect(new Set(entries.map((item) => item.id)).size).toBe(5);
    expect(entries[1]?.refs).toBeUndefined();
    expect(entries[2]?.refs).toBeUndefined();
    const md = report.artifacts.find((item) => item.role === 'testpoint-checklist')?.content ?? '';
    expect(md).toContain('| GND | ground | yes | review | unverified |');
    expect(md).toContain('| RESET | custom | yes | review | unverified |');
    expect(md).toContain('| VCC | custom | yes | pass | TP5 |');
    expect(report.artifacts.find((item) => item.role === 'bringup-plan')?.content).toContain(
      'Identify and verify test access for GND before measurement.',
    );
  });

  it('does not treat a shared testpoint reference as verified access to two nets', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'shared-pad-ref',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true, testPointRef: 'TP1' },
        { name: '3V3', category: 'power', hasTestPoint: true, testPointRef: 'TP1' },
        { name: 'RESET', category: 'reset', hasTestPoint: true, testPointRef: 'TP2' },
      ],
    });
    const rows = report.checklist.filter((item) => item.category === 'testpoint');
    expect(rows.map((item) => item.status)).toEqual(['review', 'review', 'pass']);
    expect(rows[0]?.refs).toBeUndefined();
    expect(rows[1]?.refs).toBeUndefined();
    expect(rows[0]?.details).toContain('reused across critical nets');
    const table = report.artifacts.find((item) => item.role === 'testpoint-checklist')?.content;
    expect(table).toContain('| GND | ground | yes | review | unverified |');
    expect(table).toContain('| 3V3 | power | yes | review | unverified |');
    expect(table).toContain('| RESET | reset | yes | pass | TP2 |');
    const bringup = report.artifacts.find((item) => item.role === 'bringup-plan')?.content;
    expect(bringup).toContain('Identify and verify test access for GND before measurement.');
    expect(bringup).toContain('Identify and verify test access for 3V3 before measurement.');
    expect(bringup).not.toContain('Measure GND at declared point TP1');
    expect(bringup).not.toContain('Measure 3V3 at declared point TP1');
    expect(report.passed).toBe(true); // No hard errors; reviewer sign-off remains separate.
  });

  it('does not trust a required net test point reused by an optional declared net', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'optional-net-shared-testpoint',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true, testPointRef: 'TP1' },
        {
          name: 'AUX',
          category: 'custom',
          required: false,
          hasTestPoint: true,
          testPointRef: 'TP1',
        },
        { name: '3V3', category: 'power', hasTestPoint: true, testPointRef: 'TP2' },
      ],
    });
    const entries = report.checklist.filter((item) => item.category === 'testpoint');
    expect(entries).toHaveLength(2);
    expect(entries.map((item) => item.title)).toEqual([
      'Verify test access for GND',
      'Verify test access for 3V3',
    ]);
    expect(entries.map((item) => item.status)).toEqual(['review', 'pass']);
    expect(entries[0]?.refs).toBeUndefined();
    expect(entries[0]?.details).toMatch(/reused across critical nets/);
    expect(report.summary.criticalNetCount).toBe(2);
    expect(report.artifacts.find((item) => item.role === 'testpoint-checklist')?.content).toContain(
      '| GND | ground | yes | review | unverified |',
    );
    expect(report.artifacts.find((item) => item.role === 'bringup-plan')?.content).toContain(
      'Identify and verify test access for GND before measurement.',
    );
    expect(report.artifacts.find((item) => item.role === 'qa-manifest')?.content).toContain(
      'Test point reference reused across critical nets',
    );
  });

  it('keeps ambiguous assembly references under review with unique checklist IDs', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'assembly-identities',
      components: [
        { ref: 'D1', polarized: true, orientationMark: true, side: 'top' },
        { ref: 'D1', doNotPopulate: true, side: 'bottom' },
        { ref: 'D-2', specialHandling: 'Hand solder', side: 'top' },
        { ref: 'D+2', specialHandling: 'Hand solder', side: 'bottom' },
        { ref: ' J2 ', doNotPopulate: true, side: 'top' },
        { ref: 'R7', doNotPopulate: true, side: 'bottom' },
        { ref: 'R7' }, // No note requested, but still conflicts with R7's identity.
      ],
    });
    const assembly = report.checklist.filter((item) => item.category === 'assembly');
    expect(assembly).toHaveLength(6);
    expect(new Set(assembly.map((item) => item.id)).size).toBe(6);
    expect(assembly.map((item) => item.status)).toEqual([
      'review',
      'review',
      'pass',
      'pass',
      'review',
      'review',
    ]);
    for (const index of [0, 1, 4, 5]) {
      expect(assembly[index]?.refs).toBeUndefined();
      expect(assembly[index]?.details).toMatch(/ambiguous|unverified/i);
    }
    const md = report.artifacts.find((artifact) => artifact.role === 'assembly-notes')?.content;
    expect(md).toContain('Component reference ambiguous');
    expect(md).toContain('| D-2 |');
    expect(md).toContain('| D+2 |');
    expect(report.artifacts.find((artifact) => artifact.role === 'qa-manifest')?.content).toContain(
      'Component reference',
    );
    expect(report.passed).toBe(true); // package validation is not physical assembly approval
  });

  it('escapes caller-controlled Markdown cells without changing JSON evidence', () => {
    const report = generateProductionQaArtifacts({
      projectId: 'markdown-inventory',
      criticalNets: [
        { name: 'POWER|A', category: 'power', hasTestPoint: true, testPointRef: 'TP1|TEST' },
      ],
      components: [
        {
          ref: 'D|1',
          value: 'LED|green',
          side: 'bottom',
          specialHandling: 'Verify supply\n| fake | pass |<script>alert(1)</script>',
        },
      ],
    });
    const artifact = (role: string) =>
      report.artifacts.find((item) => item.role === role)?.content ?? '';
    const testpoints = artifact('testpoint-checklist');
    const assembly = artifact('assembly-notes');
    const checklist = artifact('production-qa-checklist');
    expect(testpoints).toContain('POWER\\|A');
    expect(testpoints).toContain('TP1\\|TEST');
    expect(assembly).toContain('D\\|1');
    expect(assembly).toContain('LED\\|green');
    expect(assembly).toContain('Verify supply');
    expect(assembly).toContain('&lt;script&gt;');
    expect(assembly).not.toContain('<script>');
    for (const markdown of [testpoints, assembly, checklist]) {
      const rows = markdown.split('\n').filter((line) => line.startsWith('| '));
      const delimiterCount = rows[0]!.replace(/\\\|/g, '').split('|').length;
      expect(
        rows.every((row) => row.replace(/\\\|/g, '').split('|').length === delimiterCount),
      ).toBe(true);
    }
    const manifest = JSON.parse(artifact('qa-manifest')) as {
      projectId: string;
      checklist: unknown[];
    };
    expect(manifest.projectId).toBe('markdown-inventory');
    expect(manifest.checklist).toEqual(report.checklist);
  });

  it('includes DNP and special handling notes in assembly artifact', () => {
    const report = generateProductionQaArtifacts({
      projectName: 'Factory Demo',
      components: [
        {
          ref: 'R99',
          value: '0R',
          doNotPopulate: true,
          specialHandling: 'Install only for debug builds',
          side: 'bottom',
        },
      ],
    });

    const assembly = report.artifacts.find((artifact) => artifact.role === 'assembly-notes');
    expect(assembly?.filename).toBe('factory-demo-assembly-notes.md');
    expect(assembly?.content).toContain('R99');
    expect(assembly?.content).toContain('DNP');
    expect(assembly?.content).toContain('Install only for debug builds');
  });
});

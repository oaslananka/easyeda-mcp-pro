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

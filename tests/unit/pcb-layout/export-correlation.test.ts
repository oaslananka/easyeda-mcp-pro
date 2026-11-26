import { describe, expect, it } from 'vitest';
import { correlateExportGeometry } from '../../../src/pcb-layout/export-correlation.js';

const gerber = [
  'G04 Layer: TopLayer*',
  '%FSLAX45Y45*%',
  '%MOMM*%',
  '%ADD10C,1.0*%',
  '%ADD11C,0.4*%',
  'G54D10*',
  'G01X100000Y-100000D03*',
  'G01X300000Y-100000D03*',
  'G54D11*',
  'G01X100000Y-100000D02*',
  'G01X300000Y-100000D01*',
  'M02*',
].join('\n');
const ipc = [
  'P  UNITS  CUST 1',
  'P  VER   IPC-D-356A',
  '317VCC              C1    -1    D0500PA00X 001000Y-001000X1000Y         S0',
  '317VCC              U1    -2    D0500PA00X 003000Y-001000X1000Y         S0',
  '378VCC            L01 X400 X1000Y-1000 X3000',
  '999',
].join('\n');

describe('offline export correlation', () => {
  it('matches both pad flashes and the straight circular stroke without claiming connectivity', () => {
    const r = correlateExportGeometry(gerber, ipc, 'top', 'VCC');
    expect(r.padMatches.map((x) => x.status)).toEqual(['MATCHED', 'MATCHED']);
    expect(r.conductorMatches.map((x) => x.status)).toEqual(['MATCHED']);
    expect(r.correlationStatus).toBe('MATCHED_OBSERVED_RECORDS');
    expect(r.electricalContinuity).toBe('UNKNOWN');
    expect(r.engineeringSignOff).toBe(false);
    expect(r.sourceHashes.gerber).toMatch(/^[a-f0-9]{64}$/);
  });
  it('refuses clear polarity, wrong layer, and unsupported units', () => {
    expect(() =>
      correlateExportGeometry(gerber.replace('G54D10*', '%LPC*%\nG54D10*'), ipc, 'top', 'VCC'),
    ).toThrow();
    expect(() => correlateExportGeometry(gerber, ipc, 'bottom', 'VCC')).toThrow();
    expect(() =>
      correlateExportGeometry(gerber, ipc.replace('CUST 1', 'CUST 0'), 'top', 'VCC'),
    ).toThrow();
  });
  it('reports ambiguity for duplicate geometry', () => {
    const duplicate = gerber.replace('G54D11*', 'G01X100000Y-100000D03*\nG54D11*');
    expect(correlateExportGeometry(duplicate, ipc, 'top', 'VCC').padMatches[0]?.status).toBe(
      'AMBIGUOUS',
    );
  });
  it('does not treat missing matches as disconnection', () => {
    const r = correlateExportGeometry(
      gerber.replace('X300000Y-100000D01', 'X400000Y-100000D01'),
      ipc,
      'top',
      'VCC',
    );
    expect(r.conductorMatches[0]?.status).toBe('UNMATCHED');
    expect(r.electricalContinuity).toBe('UNKNOWN');
  });
  it('rejects contradictory records assigned to the same feature', () => {
    const conflict = ipc.replace('999', '378GND            L01 X400 X1000Y-1000 X3000\n999');
    expect(
      correlateExportGeometry(gerber, conflict, 'top', 'VCC').conductorMatches[0]?.status,
    ).toBe('AMBIGUOUS');
  });
  it('distinguishes a missing net from successful matching', () => {
    const r = correlateExportGeometry(gerber, ipc, 'top', 'MISSING');
    expect(r.correlationStatus).toBe('NO_RECORDS');
    expect(r.summary.matched).toBe(0);
  });
  it('never accepts excessive input', () => {
    expect(() =>
      correlateExportGeometry(gerber + ' '.repeat(2 * 1024 * 1024), ipc, 'top', 'VCC'),
    ).toThrow();
  });
  it('counts and excludes curved strokes from line matching', () => {
    const curved = gerber.replace('G01X300000Y-100000D01*', 'G02X300000Y-100000I100000J0D01*');
    const r = correlateExportGeometry(curved, ipc, 'top', 'VCC');
    expect(r.inventory.omitted.arcs).toBe(1);
    expect(r.conductorMatches[0]?.status).toBe('UNMATCHED');
  });
  it('rejects unsupported pad types and missing termination', () => {
    expect(() =>
      correlateExportGeometry(gerber, ipc.replace('317VCC', '327VCC'), 'top', 'VCC'),
    ).toThrow();
    expect(() => correlateExportGeometry(gerber.replace('M02*', ''), ipc, 'top', 'VCC')).toThrow();
  });
});

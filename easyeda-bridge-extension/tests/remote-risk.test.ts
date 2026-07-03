import { describe, it, expect } from 'vitest';
import { classifyBridgeMethodRisk, resolveRemoteRisk } from '../src/remote-risk.js';

describe('classifyBridgeMethodRisk', () => {
  it('classifies read-only bridge methods as read', () => {
    expect(classifyBridgeMethodRisk('schematic.listNets')).toBe('read');
    expect(classifyBridgeMethodRisk('schematic.listComponents')).toBe('read');
    expect(classifyBridgeMethodRisk('board.getDimensions')).toBe('read');
    expect(classifyBridgeMethodRisk('design.drc')).toBe('read');
    expect(classifyBridgeMethodRisk('bom.generate')).toBe('read');
    expect(classifyBridgeMethodRisk('system.getStatus')).toBe('read');
  });

  it('classifies mutating (non-destructive, non-export) methods as write', () => {
    expect(classifyBridgeMethodRisk('schematic.placeComponent')).toBe('write');
    expect(classifyBridgeMethodRisk('schematic.addWire')).toBe('write');
    expect(classifyBridgeMethodRisk('pcb.placeComponent')).toBe('write');
    expect(classifyBridgeMethodRisk('pcb.addTrack')).toBe('write');
    expect(classifyBridgeMethodRisk('project.save')).toBe('write');
  });

  it('classifies file-producing methods as export', () => {
    expect(classifyBridgeMethodRisk('board.exportGerbers')).toBe('export');
    expect(classifyBridgeMethodRisk('export.netlist')).toBe('export');
    expect(classifyBridgeMethodRisk('export.pdf')).toBe('export');
    expect(classifyBridgeMethodRisk('export.pickPlace')).toBe('export');
    expect(classifyBridgeMethodRisk('project.export')).toBe('export');
  });

  it('classifies deletion methods as destructive', () => {
    expect(classifyBridgeMethodRisk('pcb.deleteComponent')).toBe('destructive');
    expect(classifyBridgeMethodRisk('schematic.deletePrimitive')).toBe('destructive');
  });

  it('always classifies raw api.* escape hatches as destructive', () => {
    expect(classifyBridgeMethodRisk('api.call')).toBe('destructive');
    expect(classifyBridgeMethodRisk('api.execute')).toBe('destructive');
  });

  it('defaults unrecognized methods to read (dispatch() itself fails closed on unknown methods)', () => {
    expect(classifyBridgeMethodRisk('totally.unknown.method')).toBe('read');
  });
});

describe('resolveRemoteRisk', () => {
  it('uses the local classification when no risk level is declared', () => {
    expect(resolveRemoteRisk('pcb.deleteComponent')).toBe('destructive');
    expect(resolveRemoteRisk('schematic.listNets')).toBe('read');
  });

  it('ignores an invalid/unrecognized declared risk level', () => {
    expect(resolveRemoteRisk('schematic.listNets', 'not-a-real-risk-level')).toBe('read');
  });

  it('takes the stricter of the local and declared risk levels', () => {
    // Declared risk is lower than the local classification: local wins.
    expect(resolveRemoteRisk('pcb.deleteComponent', 'read')).toBe('destructive');
    // Declared risk is higher than the local classification: declared wins.
    expect(resolveRemoteRisk('schematic.listNets', 'destructive')).toBe('destructive');
    // Equal risk: either value is correct, result must equal that risk.
    expect(resolveRemoteRisk('schematic.placeComponent', 'write')).toBe('write');
  });

  it('never lets a declared risk level downgrade a destructive method', () => {
    expect(resolveRemoteRisk('api.call', 'read')).toBe('destructive');
  });
});

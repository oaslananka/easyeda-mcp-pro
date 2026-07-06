import { describe, expect, it } from 'vitest';
import { planWorkflowBlock, refPlaceholder } from '../../../src/workflows/planner.js';
import type { WorkflowBlockInput } from '../../../src/workflows/types.js';

const deviceItem = { libraryUuid: 'lib-1', uuid: 'dev-1' };

function baseInput(overrides: Partial<WorkflowBlockInput> = {}): WorkflowBlockInput {
  return {
    projectId: 'proj-1',
    mode: 'preview',
    anchor: { x: 100, y: 100 },
    components: [
      {
        ref: 'U1',
        role: 'power-regulator',
        deviceItem,
        pinConnections: [
          { pin: '1', netName: 'VIN' },
          { pin: '2', netName: 'GND' },
          { pin: '3', netName: 'VOUT' },
        ],
      },
      {
        ref: 'C1',
        role: 'output-capacitor',
        deviceItem,
        pinConnections: [
          { pin: '1', netName: 'VOUT' },
          { pin: '2', netName: 'GND' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('planWorkflowBlock', () => {
  it('is deterministic: identical input produces an identical transaction id', () => {
    const planA = planWorkflowBlock(baseInput(), 'wf_test');
    const planB = planWorkflowBlock(baseInput(), 'wf_test');
    expect(planA.transactionId).toBe(planB.transactionId);
    expect(planA.transactionId).toMatch(/^wf_test_[0-9a-f]{16}$/);
  });

  it('produces a different transaction id when input changes', () => {
    const planA = planWorkflowBlock(baseInput(), 'wf_test');
    const planB = planWorkflowBlock(baseInput({ anchor: { x: 200, y: 100 } }), 'wf_test');
    expect(planA.transactionId).not.toBe(planB.transactionId);
  });

  it('computes deterministic grid placements for new components', () => {
    const plan = planWorkflowBlock(baseInput({ spacing: 15 }), 'wf_test');
    expect(plan.placements).toEqual([
      { ref: 'U1', role: 'power-regulator', x: 100, y: 100 },
      { ref: 'C1', role: 'output-capacitor', x: 115, y: 100 },
    ]);
  });

  it('orders operations as: all placements, then all pin connections, then net ports', () => {
    const plan = planWorkflowBlock(
      baseInput({
        netPorts: [{ netName: 'VOUT' }],
      }),
      'wf_test',
    );
    const kinds = plan.operations.map((op) => op.kind);
    const lastPlaceIndex = kinds.lastIndexOf('placeComponent');
    const firstConnectIndex = kinds.indexOf('connectPinToNet');
    const firstNetPortIndex = kinds.indexOf('createNetPort');
    expect(lastPlaceIndex).toBeLessThan(firstConnectIndex);
    expect(firstConnectIndex).toBeLessThan(firstNetPortIndex);
  });

  it('uses a symbolic ref placeholder for pin connections on newly-placed components', () => {
    const plan = planWorkflowBlock(baseInput(), 'wf_test');
    const connectOps = plan.operations.filter((op) => op.kind === 'connectPinToNet');
    for (const op of connectOps) {
      expect(op.params.primitiveId).toBe(refPlaceholder(op.ref!));
    }
  });

  it('uses the real primitiveId for pin connections on existing components', () => {
    const plan = planWorkflowBlock(
      baseInput({
        components: [],
        existingComponents: [
          {
            ref: 'U_EXISTING',
            role: 'mcu',
            primitiveId: 'real-primitive-id',
            pinConnections: [{ pin: '5', netName: 'VCC' }],
          },
        ],
      }),
      'wf_test',
    );
    const connectOp = plan.operations.find((op) => op.kind === 'connectPinToNet');
    expect(connectOp?.params.primitiveId).toBe('real-primitive-id');
  });

  it('flags an empty workflow as blocked with WORKFLOW_NO_COMPONENTS', () => {
    const plan = planWorkflowBlock(baseInput({ components: [] }), 'wf_test');
    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'WORKFLOW_NO_COMPONENTS')).toBe(true);
  });

  it('flags duplicate refs as blocked with WORKFLOW_DUPLICATE_REF', () => {
    const plan = planWorkflowBlock(
      baseInput({
        components: [
          { ref: 'U1', role: 'a', deviceItem, pinConnections: [] },
          { ref: 'U1', role: 'b', deviceItem, pinConnections: [] },
        ],
      }),
      'wf_test',
    );
    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'WORKFLOW_DUPLICATE_REF')).toBe(true);
  });

  it('warns (but does not block) on empty pin connections', () => {
    const plan = planWorkflowBlock(
      baseInput({
        components: [{ ref: 'U1', role: 'a', deviceItem, pinConnections: [] }],
      }),
      'wf_test',
    );
    expect(plan.blocked).toBe(false);
    const warning = plan.issues.find((issue) => issue.code === 'WORKFLOW_EMPTY_PIN_CONNECTIONS');
    expect(warning?.severity).toBe('warning');
  });

  it('flags duplicate net ports as blocked', () => {
    const plan = planWorkflowBlock(
      baseInput({
        netPorts: [{ netName: 'VOUT' }, { netName: 'VOUT' }],
      }),
      'wf_test',
    );
    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'WORKFLOW_DUPLICATE_NET_PORT')).toBe(true);
  });

  it('includes a rollback note about pre-existing-component connections when applicable', () => {
    const plan = planWorkflowBlock(
      baseInput({
        components: [],
        existingComponents: [
          {
            ref: 'U_EXISTING',
            role: 'mcu',
            primitiveId: 'real-id',
            pinConnections: [{ pin: '1', netName: 'VCC' }],
          },
        ],
      }),
      'wf_test',
    );
    expect(plan.rollbackNotes.some((note) => note.includes('cannot be rolled back'))).toBe(true);
  });

  it('does not include the pre-existing-component rollback caveat when there are none', () => {
    const plan = planWorkflowBlock(baseInput(), 'wf_test');
    expect(plan.rollbackNotes.some((note) => note.includes('cannot be rolled back'))).toBe(false);
  });
});

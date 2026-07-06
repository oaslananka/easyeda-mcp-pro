/**
 * Compound schematic workflow planner.
 *
 * Builds a deterministic, atomic plan that places zero or more new components,
 * wires pin-to-net connections (on new and/or pre-existing components), and creates
 * net ports — as a single ordered operation list a caller can preview before applying.
 *
 * Newly-placed components don't have a real `primitiveId` until `schematic.placeComponent`
 * actually runs, so pin-connection operations targeting a new component use a symbolic
 * placeholder (`$ref:<ref>`) in the plan; the apply-time executor resolves it to the real
 * primitiveId returned by that component's placement. This keeps the *plan* fully
 * deterministic and hashable even though the real IDs only exist after execution.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type {
  WorkflowBlockInput,
  WorkflowIssue,
  WorkflowOperation,
  WorkflowPlan,
  WorkflowPlannedComponent,
} from './types.js';

function txId(prefix: string, payload: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

function issue(
  code: WorkflowIssue['code'],
  severity: WorkflowIssue['severity'],
  message: string,
  remediationHint: string,
  details?: Record<string, unknown>,
): WorkflowIssue {
  return { code, severity, message, remediationHint, details };
}

/** Symbolic primitiveId placeholder for a component that will be placed in this same transaction. */
export function refPlaceholder(ref: string): string {
  return `$ref:${ref}`;
}

/** Build a deterministic plan for a compound schematic workflow (place + wire + net-port). */
export function planWorkflowBlock(
  input: WorkflowBlockInput,
  transactionPrefix: string,
): WorkflowPlan {
  const mode = input.mode ?? 'preview';
  const components = input.components ?? [];
  const existingComponents = input.existingComponents ?? [];
  const netPorts = input.netPorts ?? [];
  const spacing = input.spacing ?? 10;
  const issues: WorkflowIssue[] = [];

  if (components.length === 0 && existingComponents.length === 0 && netPorts.length === 0) {
    issues.push(
      issue(
        'WORKFLOW_NO_COMPONENTS',
        'error',
        'The workflow has no components, existing-component references, or net ports to act on.',
        'Provide at least one component, existingComponent, or netPort.',
      ),
    );
  }

  const seenRefs = new Set<string>();
  for (const component of [...components, ...existingComponents]) {
    if (seenRefs.has(component.ref)) {
      issues.push(
        issue(
          'WORKFLOW_DUPLICATE_REF',
          'error',
          `Duplicate component ref "${component.ref}".`,
          'Give each component and existingComponent a unique ref.',
          { ref: component.ref },
        ),
      );
    }
    seenRefs.add(component.ref);
  }

  for (const component of components) {
    if (component.pinConnections.length === 0) {
      issues.push(
        issue(
          'WORKFLOW_EMPTY_PIN_CONNECTIONS',
          'warning',
          `Component "${component.ref}" (role: ${component.role}) has no pin connections.`,
          'Add pinConnections so the component is actually wired into the design, or confirm this is intentional.',
          { ref: component.ref },
        ),
      );
    }
  }
  for (const component of existingComponents) {
    if (component.pinConnections.length === 0) {
      issues.push(
        issue(
          'WORKFLOW_EMPTY_PIN_CONNECTIONS',
          'warning',
          `Existing component "${component.ref}" (role: ${component.role}) has no pin connections.`,
          'Add pinConnections, or remove this entry if nothing needs wiring.',
          { ref: component.ref },
        ),
      );
    }
  }

  const seenNetPorts = new Set<string>();
  for (const port of netPorts) {
    if (seenNetPorts.has(port.netName)) {
      issues.push(
        issue(
          'WORKFLOW_DUPLICATE_NET_PORT',
          'error',
          `Duplicate net port for net "${port.netName}".`,
          'Only one net port is needed per net name.',
          { netName: port.netName },
        ),
      );
    }
    seenNetPorts.add(port.netName);
  }

  const blocked = issues.some((entry) => entry.severity === 'error');

  const placements: WorkflowPlannedComponent[] = components.map((component, index) => ({
    ref: component.ref,
    role: component.role,
    x: input.anchor.x + index * spacing,
    y: input.anchor.y,
  }));

  const operations: WorkflowOperation[] = [];

  components.forEach((component, index) => {
    const placement = placements[index];
    if (!placement) return;
    operations.push({
      kind: 'placeComponent',
      ref: component.ref,
      role: component.role,
      method: 'schematic.placeComponent',
      params: {
        deviceItem: component.deviceItem,
        x: placement.x,
        y: placement.y,
        rotation: component.rotation,
        mirror: component.mirror,
        subPartName: component.subPartName,
      },
    });
  });

  for (const component of components) {
    for (const connection of component.pinConnections) {
      operations.push({
        kind: 'connectPinToNet',
        ref: component.ref,
        role: component.role,
        method: 'schematic.connectPinToNet',
        params: {
          projectId: input.projectId,
          primitiveId: refPlaceholder(component.ref),
          pinNumber: connection.pin,
          netName: connection.netName,
        },
      });
    }
  }

  for (const component of existingComponents) {
    for (const connection of component.pinConnections) {
      operations.push({
        kind: 'connectPinToNet',
        ref: component.ref,
        role: component.role,
        method: 'schematic.connectPinToNet',
        params: {
          projectId: input.projectId,
          primitiveId: component.primitiveId,
          pinNumber: connection.pin,
          netName: connection.netName,
        },
      });
    }
  }

  const netPortAnchor = input.netPortAnchor ?? {
    x: input.anchor.x,
    y: input.anchor.y + spacing,
  };
  netPorts.forEach((port, index) => {
    operations.push({
      kind: 'createNetPort',
      netName: port.netName,
      method: 'schematic.createNetPort',
      params: {
        projectId: input.projectId,
        netName: port.netName,
        x: netPortAnchor.x + index * spacing,
        y: netPortAnchor.y,
        portType: port.portType,
        rotation: port.rotation,
      },
    });
  });

  const rollbackNotes = [
    'Newly-placed components (and any net ports created in this transaction) are deleted on rollback.',
  ];
  if (existingComponents.some((component) => component.pinConnections.length > 0)) {
    rollbackNotes.push(
      'Pin-to-net connections applied to pre-existing components cannot be rolled back automatically ' +
        '(the bridge protocol has no disconnect-pin primitive) — if apply fails after such a connection ' +
        'was already made, that connection remains and must be reviewed/undone manually.',
    );
  }

  const summary = blocked
    ? `Blocked: ${issues.filter((entry) => entry.severity === 'error').length} error(s) found before planning operations.`
    : `${mode === 'apply' ? 'Applying' : 'Planned'} ${components.length} new component(s), ` +
      `${existingComponents.length} existing-component wiring, and ${netPorts.length} net port(s) ` +
      `across ${operations.length} operation(s).`;

  return {
    projectId: input.projectId,
    transactionId: txId(transactionPrefix, { input }),
    mode,
    blocked,
    placements,
    operations,
    issues,
    summary,
    rollbackNotes,
  };
}

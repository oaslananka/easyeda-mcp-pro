import type { ModelDiagnostic, SchematicModel } from './geometry-model.js';

export interface ModelValidationResult {
  valid: boolean;
  diagnostics: ModelDiagnostic[];
  errors: ModelDiagnostic[];
  warnings: ModelDiagnostic[];
}

function duplicateValues(values: Array<string | undefined>): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

export function validateSchematicModel(model: SchematicModel): ModelValidationResult {
  const diagnostics: ModelDiagnostic[] = [...model.diagnostics];
  const componentIds = new Set(model.components.map((component) => component.canonicalComponentId));
  const pinIds = new Set(model.pins.map((pin) => pin.canonicalPinId));
  const netIds = new Set(model.nets.map((net) => net.canonicalNetId));

  for (const duplicate of duplicateValues(
    model.components.map((component) => component.canonicalComponentId),
  )) {
    diagnostics.push({
      code: 'DUPLICATE_COMPONENT_ID',
      severity: 'error',
      message: `Duplicate canonical component ID: ${duplicate}.`,
      canonicalComponentId: duplicate,
    });
  }
  for (const duplicate of duplicateValues(model.pins.map((pin) => pin.canonicalPinId))) {
    diagnostics.push({
      code: 'DUPLICATE_PIN_ID',
      severity: 'error',
      message: `Duplicate canonical pin ID: ${duplicate}.`,
      canonicalPinId: duplicate,
    });
  }
  for (const duplicate of duplicateValues(model.nets.map((net) => net.canonicalNetId))) {
    diagnostics.push({
      code: 'DUPLICATE_NET_ID',
      severity: 'error',
      message: `Duplicate canonical net ID: ${duplicate}.`,
      canonicalNetId: duplicate,
    });
  }

  const realComponents = model.components.filter((component) => component.bomEligible);
  const duplicateReferences = duplicateValues(
    realComponents.map((component) => component.reference?.toUpperCase()),
  );
  for (const reference of duplicateReferences) {
    for (const component of realComponents.filter(
      (candidate) => candidate.reference?.toUpperCase() === reference,
    )) {
      diagnostics.push({
        code: 'DUPLICATE_REFERENCE',
        severity: 'error',
        message: `Reference ${component.reference} is used by more than one real component.`,
        canonicalComponentId: component.canonicalComponentId,
        evidence: { reference: component.reference },
      });
    }
  }

  for (const component of model.components) {
    if (component.bomEligible && (!component.reference || /\?$/.test(component.reference))) {
      diagnostics.push({
        code: 'MISSING_REFERENCE',
        severity: 'warning',
        message: `Real component ${component.canonicalComponentId} is unannotated.`,
        canonicalComponentId: component.canonicalComponentId,
      });
    }
    if (component.bomEligible && !component.metadata.value.resolved) {
      diagnostics.push({
        code: 'MISSING_VALUE',
        severity: 'warning',
        message: `${component.reference ?? component.canonicalComponentId} has no resolved value.`,
        canonicalComponentId: component.canonicalComponentId,
      });
    }
    if (component.bomEligible && !component.metadata.footprint.resolved) {
      diagnostics.push({
        code: 'MISSING_FOOTPRINT',
        severity: 'warning',
        message: `${component.reference ?? component.canonicalComponentId} has no resolved footprint.`,
        canonicalComponentId: component.canonicalComponentId,
      });
    }
    for (const pinId of component.pinIds) {
      if (!pinIds.has(pinId)) {
        diagnostics.push({
          code: 'COMPONENT_PIN_MISSING',
          severity: 'error',
          message: `Component references missing canonical pin ${pinId}.`,
          canonicalComponentId: component.canonicalComponentId,
          canonicalPinId: pinId,
        });
      }
    }
  }

  for (const pin of model.pins) {
    if (!componentIds.has(pin.canonicalComponentId)) {
      diagnostics.push({
        code: 'PIN_COMPONENT_MISSING',
        severity: 'error',
        message: `Pin ${pin.canonicalPinId} references a missing component.`,
        canonicalPinId: pin.canonicalPinId,
        canonicalComponentId: pin.canonicalComponentId,
      });
    }
    for (const netId of pin.netIds) {
      if (!netIds.has(netId)) {
        diagnostics.push({
          code: 'PIN_NET_MISSING',
          severity: 'error',
          message: `Pin ${pin.canonicalPinId} references missing net ${netId}.`,
          canonicalPinId: pin.canonicalPinId,
          canonicalNetId: netId,
        });
      }
    }
    if (pin.netIds.length > 1) {
      diagnostics.push({
        code: 'PIN_ON_MULTIPLE_NETS',
        severity: 'error',
        message: `Pin ${pin.reference ?? pin.canonicalComponentId}.${pin.number} belongs to multiple canonical nets.`,
        canonicalPinId: pin.canonicalPinId,
        evidence: { netIds: pin.netIds },
      });
    }
    if (pin.deliberateNoConnect && pin.netIds.length > 0) {
      diagnostics.push({
        code: 'NO_CONNECT_ON_CONNECTED_PIN',
        severity: 'warning',
        message: `Pin ${pin.reference ?? pin.canonicalComponentId}.${pin.number} is both connected and marked no-connect.`,
        canonicalPinId: pin.canonicalPinId,
        evidence: { netIds: pin.netIds },
      });
    }
  }

  for (const net of model.nets) {
    for (const pinId of net.pinIds) {
      if (!pinIds.has(pinId)) {
        diagnostics.push({
          code: 'NET_PIN_MISSING',
          severity: 'error',
          message: `Net ${net.rawNetName || net.canonicalNetId} references missing pin ${pinId}.`,
          canonicalNetId: net.canonicalNetId,
          canonicalPinId: pinId,
        });
      }
    }
  }

  const segmentKeys = new Set<string>();
  for (const wire of model.wires) {
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      if (!start || !end) continue;
      if (samePoint(start, end)) {
        diagnostics.push({
          code: 'ZERO_LENGTH_WIRE_SEGMENT',
          severity: 'error',
          message: `Wire ${wire.runtimePrimitiveId} contains a zero-length segment.`,
          evidence: { start, end },
        });
      }
      const endpoints = [`${start.x},${start.y}`, `${end.x},${end.y}`].sort((a, b) =>
        a.localeCompare(b),
      );
      const key = `${wire.canonicalNetName ?? ''}:${endpoints.join('>')}`;
      if (segmentKeys.has(key)) {
        diagnostics.push({
          code: 'DUPLICATE_WIRE_SEGMENT',
          severity: 'warning',
          message: `Duplicate wire segment detected on ${wire.canonicalNetName ?? '<unnamed>'}.`,
          evidence: { start, end },
        });
      }
      segmentKeys.add(key);
    }
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  return { valid: errors.length === 0, diagnostics, errors, warnings };
}

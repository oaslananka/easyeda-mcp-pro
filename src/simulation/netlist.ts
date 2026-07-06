/**
 * Typed circuit description → SPICE deck translation.
 *
 * Every card is built from typed, validated component data — there is no path from tool
 * input to a raw SPICE deck string. Net and reference-designator names are restricted to
 * a safe identifier pattern before being embedded in deck text (see `assertSafeIdentifier`),
 * so even a caller-supplied node name cannot inject additional SPICE cards or `.control`
 * directives.
 *
 * @module
 */

import { getDiodeModel } from './models.js';
import type { SimAnalysis, SimCircuit, SimComponent } from './types.js';

// SPICE refs/nodes are always embedded with a type-letter prefix (R/C/L/D/V/I/B) or as a
// bare node token, and real netlists commonly use purely numeric refs/nodes (R1, node "2",
// etc.) — so this only excludes characters that could inject SPICE syntax (whitespace,
// newlines, `.`, `;`, parens, quotes), not "must start with a letter".
const SAFE_IDENTIFIER = /^\w+$/;

export function assertSafeIdentifier(value: string, kind: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": must contain only letters, digits, or underscores.`,
    );
  }
}

function componentCard(component: SimComponent, modelCards: Map<string, string>): string {
  const [n1, n2, n3] = component.nodes;
  switch (component.kind) {
    case 'resistor':
      return `R${component.ref} ${n1} ${n2} ${component.value}`;
    case 'capacitor':
      return `C${component.ref} ${n1} ${n2} ${component.value}${
        component.initialCondition === undefined ? '' : ` IC=${component.initialCondition}`
      }`;
    case 'inductor':
      return `L${component.ref} ${n1} ${n2} ${component.value}${
        component.initialCondition === undefined ? '' : ` IC=${component.initialCondition}`
      }`;
    case 'diode':
    case 'led': {
      const model = getDiodeModel(component.modelName);
      const modelCardName = `MODEL_${model.name.replace(/\W/g, '_')}`;
      if (!modelCards.has(modelCardName)) {
        const params = Object.entries(model.params)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ');
        modelCards.set(modelCardName, `.model ${modelCardName} D (${params})`);
      }
      return `D${component.ref} ${n1} ${n2} ${modelCardName}`;
    }
    case 'dc-voltage-source':
      return `V${component.ref} ${n1} ${n2} DC ${component.voltage}`;
    case 'pulse-voltage-source':
      return (
        `V${component.ref} ${n1} ${n2} PULSE(${component.initialVoltage} ${component.pulsedVoltage} ` +
        `${component.delaySeconds} ${component.riseSeconds} ${component.fallSeconds} ` +
        `${component.pulseWidthSeconds} ${component.periodSeconds})`
      );
    case 'dc-current-source':
      return `I${component.ref} ${n1} ${n2} DC ${component.current}`;
    case 'pulse-current-source':
      return (
        `I${component.ref} ${n1} ${n2} PULSE(${component.initialCurrent} ${component.pulsedCurrent} ` +
        `${component.delaySeconds} ${component.riseSeconds} ${component.fallSeconds} ` +
        `${component.pulseWidthSeconds} ${component.periodSeconds})`
      );
    case 'ldo-behavioral': {
      const idealNode = `ideal_${component.ref}`;
      const vinNode = n1;
      const voutNode = n2;
      const gndNode = n3;
      return [
        `Bideal_${component.ref} ${idealNode} ${gndNode} V=min(V(${vinNode})-${component.dropoutVoltage},${component.targetVoltage})`,
        `Rout_${component.ref} ${idealNode} ${voutNode} ${component.outputResistanceOhms}`,
      ].join('\n');
    }
  }
}

function collectNodes(circuit: SimCircuit): string[] {
  const nodes = new Set<string>();
  for (const component of circuit.components) {
    for (const node of component.nodes) nodes.add(node);
  }
  nodes.delete(circuit.groundNode);
  return Array.from(nodes).sort((a, b) => a.localeCompare(b));
}

/** Build a complete, ngspice-batch-mode-ready SPICE deck for the given circuit and analysis. */
export function buildSpiceDeck(circuit: SimCircuit, analysis: SimAnalysis): string {
  assertSafeIdentifier(circuit.groundNode, 'ground node name');
  for (const component of circuit.components) {
    assertSafeIdentifier(component.ref, 'component ref');
    for (const node of component.nodes) assertSafeIdentifier(node, 'node name');
  }
  if (circuit.groundNode !== '0') {
    throw new Error('groundNode must be "0" (SPICE\'s reserved ground node name).');
  }

  const modelCards = new Map<string, string>();
  const componentLines = circuit.components.map((component) =>
    componentCard(component, modelCards),
  );
  const outputNodes = collectNodes(circuit);
  const printVectors = outputNodes.map((node) => `v(${node})`).join(' ');

  const analysisLine =
    analysis.kind === 'operating-point'
      ? '.op'
      : `.tran ${analysis.stepSeconds} ${analysis.stopTimeSeconds}`;

  return [
    `* ${circuit.title}`,
    ...componentLines,
    ...modelCards.values(),
    analysisLine,
    '.control',
    'run',
    `print ${printVectors}`,
    'quit',
    '.endc',
    '.end',
    '',
  ].join('\n');
}

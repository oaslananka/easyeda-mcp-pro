import { compareIds } from './geometry.js';
import type {
  DetectedFunctionalBlock,
  ExplicitFunctionalBlock,
  FunctionalBlockKind,
  LayoutComponentInput,
  SchematicLayoutGraph,
} from './types.js';

const KIND_TITLES: Readonly<Record<FunctionalBlockKind, string>> = {
  'power-input': 'Power Input',
  regulation: 'Power Regulation',
  mcu: 'Microcontroller',
  memory: 'Memory',
  crystal: 'Crystal and Clock',
  usb: 'USB',
  'motor-driver': 'Motor Driver',
  'led-chain': 'LED Chain',
  connector: 'Connectors',
  debug: 'Debug',
  sensor: 'Sensors',
  'analog-front-end': 'Analog Front End',
  other: 'Other',
};

const KIND_PRIORITY: readonly FunctionalBlockKind[] = [
  'usb',
  'debug',
  'regulation',
  'power-input',
  'mcu',
  'memory',
  'crystal',
  'motor-driver',
  'led-chain',
  'sensor',
  'analog-front-end',
  'connector',
  'other',
];

function searchableText(component: LayoutComponentInput): string {
  return [
    component.reference,
    component.value,
    component.deviceName,
    component.description,
    component.category,
    ...(component.tags ?? []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function matchesAny(text: string, expressions: readonly RegExp[]): boolean {
  return expressions.some((expression) => expression.test(text));
}

export function inferFunctionalBlockKind(component: LayoutComponentInput): FunctionalBlockKind {
  const text = searchableText(component);
  const reference = component.reference.toUpperCase();
  if (matchesAny(text, [/\busb(?:-?c)?\b/, /type[\s-]*c/, /usb connector/])) return 'usb';
  if (matchesAny(text, [/\bjtag\b/, /\bswd\b/, /debug/, /program(?:mer|ming) header/]))
    return 'debug';
  if (
    matchesAny(text, [
      /\bldo\b/,
      /regulat/,
      /buck converter/,
      /boost converter/,
      /dc[- ]?dc/,
      /ams1117/,
      /tps62/,
    ])
  ) {
    return 'regulation';
  }
  if (
    matchesAny(text, [
      /power input/,
      /barrel jack/,
      /dc input/,
      /mains input/,
      /power entry/,
      /battery input/,
    ])
  ) {
    return 'power-input';
  }
  if (
    matchesAny(text, [
      /microcontroller/,
      /\bmcu\b/,
      /rp2040/,
      /stm32/,
      /esp32/,
      /atmega/,
      /samd2/,
      /nrf5/,
    ])
  ) {
    return 'mcu';
  }
  if (matchesAny(text, [/\bflash\b/, /\beeprom\b/, /\bsram\b/, /\bmemory\b/, /w25q/, /qspi/])) {
    return 'memory';
  }
  if (
    matchesAny(text, [/\bcrystal\b/, /\bxtal\b/, /oscillator/, /resonator/]) ||
    /^[XY]\d+/i.test(reference)
  ) {
    return 'crystal';
  }
  if (
    matchesAny(text, [
      /motor driver/,
      /h[- ]?bridge/,
      /drv8\d/,
      /tb66/,
      /stepper driver/,
      /gate driver/,
    ])
  ) {
    return 'motor-driver';
  }
  if (matchesAny(text, [/ws2812/, /neopixel/, /led chain/, /addressable led/])) return 'led-chain';
  if (
    matchesAny(text, [
      /accelerometer/,
      /gyroscope/,
      /\bimu\b/,
      /temperature sensor/,
      /pressure sensor/,
      /proximity sensor/,
      /\bsensor\b/,
    ])
  ) {
    return 'sensor';
  }
  if (
    matchesAny(text, [
      /analog front[- ]?end/,
      /\bop[- ]?amp\b/,
      /instrumentation amplifier/,
      /transimpedance/,
      /\badc\b/,
      /\bdac\b/,
    ])
  ) {
    return 'analog-front-end';
  }
  if (
    matchesAny(text, [/connector/, /header/, /terminal block/, /\bjack\b/]) ||
    /^(J|P|CN)\d+/i.test(reference)
  ) {
    return 'connector';
  }
  if (matchesAny(text, [/led/, /light emitting diode/]) || /^D\d+/i.test(reference))
    return 'led-chain';
  return 'other';
}

function dominantKind(components: readonly LayoutComponentInput[]): FunctionalBlockKind {
  const counts = new Map<FunctionalBlockKind, number>();
  for (const component of components) {
    const kind = inferFunctionalBlockKind(component);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      ([kindA, countA], [kindB, countB]) =>
        countB - countA || KIND_PRIORITY.indexOf(kindA) - KIND_PRIORITY.indexOf(kindB),
    )[0]?.[0] ?? 'other'
  );
}

function inferredBlock(
  id: string,
  kind: FunctionalBlockKind,
  componentIds: string[],
  confidence: number,
): DetectedFunctionalBlock {
  return {
    id,
    kind,
    title: KIND_TITLES[kind],
    componentIds: [...componentIds].sort(compareIds),
    source: 'inferred',
    confidence,
    locked: false,
    preferredOrientation:
      kind === 'power-input' || kind === 'regulation' || kind === 'crystal'
        ? 'vertical'
        : 'horizontal',
  };
}

function repeatSignature(
  block: DetectedFunctionalBlock,
  componentById: ReadonlyMap<string, LayoutComponentInput>,
): string | undefined {
  if (block.source === 'explicit' || block.kind === 'other' || block.componentIds.length === 0) {
    return undefined;
  }
  const anchorId = block.componentIds[0];
  if (!anchorId) return undefined;
  const anchor = componentById.get(anchorId);
  const part = (anchor?.deviceName ?? anchor?.value ?? anchor?.category ?? '').trim().toLowerCase();
  return part ? `${block.kind}:${part}` : undefined;
}

export function detectFunctionalBlocks(
  components: readonly LayoutComponentInput[],
  graph: SchematicLayoutGraph,
  explicitBlocks: readonly ExplicitFunctionalBlock[] = [],
): DetectedFunctionalBlock[] {
  const componentById = new Map(components.map((component) => [component.id, component]));
  const claimed = new Set<string>();
  const blocks: DetectedFunctionalBlock[] = [];

  for (const explicit of [...explicitBlocks].sort((a, b) => compareIds(a.id, b.id))) {
    const componentIds = [...new Set(explicit.componentIds)]
      .filter((componentId) => componentById.has(componentId) && !claimed.has(componentId))
      .sort(compareIds);
    if (componentIds.length === 0) continue;
    componentIds.forEach((componentId) => claimed.add(componentId));
    blocks.push({
      id: explicit.id,
      kind: explicit.kind,
      title: explicit.title ?? KIND_TITLES[explicit.kind],
      sectionTitle: explicit.sectionTitle,
      componentIds,
      source: 'explicit',
      confidence: 1,
      locked: explicit.locked ?? false,
      repeatedGroupId: explicit.repeatedGroupId,
      preferredOrientation: explicit.preferredOrientation ?? 'horizontal',
    });
  }

  const groupedByDeclaredBlock = new Map<string, LayoutComponentInput[]>();
  for (const component of components) {
    if (claimed.has(component.id) || !component.blockId) continue;
    const grouped = groupedByDeclaredBlock.get(component.blockId) ?? [];
    grouped.push(component);
    groupedByDeclaredBlock.set(component.blockId, grouped);
  }
  for (const [blockId, members] of [...groupedByDeclaredBlock.entries()].sort(([a], [b]) =>
    compareIds(a, b),
  )) {
    members.forEach((component) => claimed.add(component.id));
    blocks.push(
      inferredBlock(
        `inferred:${blockId}`,
        dominantKind(members),
        members.map((component) => component.id),
        0.9,
      ),
    );
  }

  const anchorBlockByComponent = new Map<string, DetectedFunctionalBlock>();
  for (const component of [...components].sort((a, b) => compareIds(a.id, b.id))) {
    if (claimed.has(component.id)) continue;
    const kind = inferFunctionalBlockKind(component);
    if (kind === 'other') continue;
    const block = inferredBlock(`inferred:${kind}:${component.id}`, kind, [component.id], 0.82);
    blocks.push(block);
    anchorBlockByComponent.set(component.id, block);
    claimed.add(component.id);
  }

  // Attach passive/helper parts to the nearest inferred anchor using the canonical graph.
  for (const component of [...components].sort((a, b) => compareIds(a.id, b.id))) {
    if (claimed.has(component.id)) continue;
    const candidateBlocks = (graph.adjacency[component.id] ?? [])
      .map((neighborId) => anchorBlockByComponent.get(neighborId))
      .filter((block): block is DetectedFunctionalBlock => block !== undefined)
      .sort(
        (a, b) =>
          KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind) || compareIds(a.id, b.id),
      );
    const owner = candidateBlocks[0];
    if (owner) {
      owner.componentIds.push(component.id);
      owner.componentIds.sort(compareIds);
    } else {
      blocks.push(inferredBlock(`inferred:other:${component.id}`, 'other', [component.id], 0.35));
    }
    claimed.add(component.id);
  }

  const repeatBuckets = new Map<string, DetectedFunctionalBlock[]>();
  for (const block of blocks) {
    const signature = repeatSignature(block, componentById);
    if (!signature) continue;
    const bucket = repeatBuckets.get(signature) ?? [];
    bucket.push(block);
    repeatBuckets.set(signature, bucket);
  }
  for (const [signature, repeated] of repeatBuckets) {
    if (repeated.length < 2) continue;
    for (const block of repeated) block.repeatedGroupId = `repeat:${signature}`;
  }

  return blocks.sort((a, b) => compareIds(a.id, b.id));
}

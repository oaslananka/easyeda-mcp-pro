import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Offline compatibility gate (#170).
 *
 * The bridge extension calls EasyEDA Pro runtime methods through
 * `callFirst([...])` / `readFirstPath([...])` fallback lists of `Class.method`
 * paths. If every path in a list is wrong for the installed EasyEDA Pro
 * version, the corresponding tool fails live with METHOD_NOT_FOUND — exactly
 * how the net-flag (#169) and ERC (#163) gaps were discovered.
 *
 * This test extracts every such fallback group from the extension source and
 * asserts that at least one path in each group resolves against a committed
 * runtime inventory baseline. Groups where no path resolves must be listed in
 * KNOWN_UNSUPPORTED with a reason, so a *new* all-dead group fails CI while
 * known gaps stay tracked and visible.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const EXTENSION_SRC = resolve(repoRoot, 'easyeda-bridge-extension/src/index.ts');
const BASELINE = resolve(
  repoRoot,
  'tests/fixtures/runtime-inventory/easyeda-3.2.149-baseline.json',
);

// Runtime class-name prefixes the baseline snapshot covers. Paths whose class
// uses a different prefix (e.g. sys_/pnl_ helpers, or bare non-prefixed paths)
// are outside the captured inventory scope and are not checked here.
const COVERED_PREFIXES = ['DMT_', 'SCH_', 'PCB_', 'LIB_'];

/**
 * Fallback groups where no covered path resolves against the current baseline.
 * Each entry is the sorted `Class.method` list joined by ' | '. Keep a reason
 * and, for real runtime gaps, a tracking issue. Refreshing the baseline may let
 * an entry resolve again — the test flags stale entries so they get removed.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  'SCH_Netlist.connectPin | SCH_Netlist.create | sch_Netlist.create':
    'Intentional fallback. Primary path in connectPinToNetImpl is the SCH_PrimitiveComponent.getAll loop, which resolves.',
  'design.erc | dmt_ERC.run':
    'DMT_ERC absent in 3.2.149; schematic ERC is exposed as SCH_Drc.check. Tracked in #163.',
  'design.drc | dmt_DRC.run':
    'DMT_DRC absent in 3.2.149; DRC is exposed as PCB_Drc.check / SCH_Drc.check. Tracked in #178.',
  'design.ruleCheck | dmt_DRC.runRuleCheck':
    'DMT_DRC absent in 3.2.149; rule check is exposed as PCB_Drc.check / SCH_Drc.check. Tracked in #178.',
  'dmt_Project.export | project.export':
    'DMT_Project has no export() in 3.2.149; project export uses a different API. Tracked in #178.',
  'board.exportGerbers | dmt_PCB.exportGerbers':
    'DMT_PCB absent in 3.2.149; PCB fab output uses PCB_ManufactureData. Tracked in #178.',
  'board.exportPickPlace | dmt_PCB.exportPickAndPlace | dmt_Project.exportPickPlace':
    'DMT_PCB/DMT_Project pick-place export methods absent in 3.2.149; use PCB_ManufactureData. Tracked in #178.',
  'dmt_PCB.exportPdf | dmt_Schematic.exportPdf | sch_Document.exportPdf':
    'No exportPdf on these classes in 3.2.149. Tracked in #178.',
  'dmt_Project.exportNetlist | sch_Document.exportNetlist':
    'No exportNetlist on these classes in 3.2.149; netlist is exposed via SCH_Netlist.getNetlist / SCH_ManufactureData.getNetlistFile. Tracked in #178.',
  'PCB_PrimitiveTrack.create | pcb_PrimitiveTrack.create':
    'PCB_PrimitiveTrack does not exist in 3.2.149; tracks are PCB_PrimitiveLine / PCB_PrimitivePolyline. Tracked in #178.',
};

interface BaselineInventory {
  classes: Array<{ className: string; methods: string[] }>;
}

function loadBaseline(): Map<string, Set<string>> {
  const data = JSON.parse(readFileSync(BASELINE, 'utf8')) as BaselineInventory;
  return new Map(data.classes.map((c) => [c.className, new Set(c.methods)]));
}

/** Normalize `sch_PrimitiveWire.create` -> { className: 'SCH_PrimitiveWire', method: 'create' }. */
function normalizePath(path: string): { className: string; method: string } {
  const [cls, ...rest] = path.split('.');
  const match = cls.match(/^([a-z]+)_(.+)$/);
  const className = match ? `${match[1].toUpperCase()}_${match[2]}` : cls;
  return { className, method: rest.join('.') };
}

function isCovered(className: string): boolean {
  return COVERED_PREFIXES.some((prefix) => className.startsWith(prefix));
}

/** Extract the string-literal path arrays passed to callFirst/readFirstPath. */
function extractFallbackGroups(source: string): string[][] {
  const groups: string[][] = [];
  const re = /(?:callFirst|readFirstPath)\(\s*\[([^\]]*)\]/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const paths = [...match[1].matchAll(/['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((p) => p.includes('.'));
    if (paths.length > 0) groups.push(paths);
  }
  return groups;
}

function groupKey(paths: string[]): string {
  return [...new Set(paths)].sort().join(' | ');
}

describe('extension runtime method-path compatibility', () => {
  const baseline = loadBaseline();
  const source = readFileSync(EXTENSION_SRC, 'utf8');
  const groups = extractFallbackGroups(source);

  const resolvesInBaseline = (path: string): boolean => {
    const { className, method } = normalizePath(path);
    return baseline.get(className)?.has(method) ?? false;
  };

  it('extracts a non-trivial set of fallback groups', () => {
    // Guard against the regex silently matching nothing (e.g. after a refactor).
    expect(groups.length).toBeGreaterThan(10);
  });

  it('every fallback group has a resolvable path or is a tracked known gap', () => {
    const unexpectedDeadGroups: Array<{ key: string; paths: string[] }> = [];

    for (const paths of groups) {
      const checkable = paths.filter((p) => isCovered(normalizePath(p).className));
      // No covered path in the group -> outside baseline scope, cannot assert.
      if (checkable.length === 0) continue;

      const anyResolves = checkable.some(resolvesInBaseline);
      if (anyResolves) continue;

      const key = groupKey(paths);
      if (!(key in KNOWN_UNSUPPORTED)) {
        unexpectedDeadGroups.push({ key, paths });
      }
    }

    expect(
      unexpectedDeadGroups,
      `These extension fallback groups reference no runtime method present in the baseline. ` +
        `Fix the runtime paths, or add the group to KNOWN_UNSUPPORTED with a tracking issue:\n` +
        unexpectedDeadGroups.map((g) => `  - ${g.key}`).join('\n'),
    ).toEqual([]);
  });

  it('has no stale KNOWN_UNSUPPORTED entries', () => {
    const deadKeys = new Set<string>();
    for (const paths of groups) {
      const checkable = paths.filter((p) => isCovered(normalizePath(p).className));
      if (checkable.length === 0) continue;
      if (!checkable.some(resolvesInBaseline)) deadKeys.add(groupKey(paths));
    }

    const stale = Object.keys(KNOWN_UNSUPPORTED).filter((key) => !deadKeys.has(key));
    expect(
      stale,
      `These KNOWN_UNSUPPORTED entries no longer match an all-dead group ` +
        `(the path was fixed or the baseline now covers it) — remove them:\n` +
        stale.map((k) => `  - ${k}`).join('\n'),
    ).toEqual([]);
  });
});

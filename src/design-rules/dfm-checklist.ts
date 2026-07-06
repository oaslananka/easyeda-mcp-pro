/**
 * Static, generic design-for-manufacturability (DFM) checklist.
 *
 * This is a fixed, project-independent reference checklist of widely-known PCB
 * manufacturability considerations (trace/space, drilling, solder mask, silkscreen,
 * panelization, assembly). It intentionally does NOT compute anything from a specific
 * project's inputs — for a project-specific, generated QA/bring-up checklist see
 * `src/production-qa/generator.ts` instead.
 *
 * Numeric baselines quoted here (e.g. "6 mil trace/space") are common industry
 * "standard capability tier" figures, not a universal guarantee — every fabricator
 * publishes its own capability table, and finer/coarser tiers cost more or less
 * accordingly. Always confirm against your chosen fabricator's actual capability
 * table before finalizing a design.
 *
 * @module
 */

export type DfmCategory =
  'clearance' | 'drilling' | 'copper' | 'solder-mask' | 'silkscreen' | 'panelization' | 'assembly';

export interface DfmChecklistItem {
  id: string;
  category: DfmCategory;
  title: string;
  guidance: string;
  rationale: string;
}

const CHECKLIST_CAVEAT =
  'Common "standard capability tier" baseline, not a universal guarantee — confirm against ' +
  "your chosen fabricator/assembly house's actual capability table before finalizing.";

const CHECKLIST: DfmChecklistItem[] = [
  {
    id: 'trace-space-baseline',
    category: 'clearance',
    title: 'Minimum trace width and spacing',
    guidance:
      '6 mil (0.15mm) trace/space is a common "standard" fabrication baseline. Finer geometry ' +
      '(e.g. 4 mil/4 mil or below) is often available as an "advanced" tier at higher cost/lead time.',
    rationale: "Traces/spacing below a fab's process capability risk opens, shorts, or yield loss.",
  },
  {
    id: 'min-drill-size',
    category: 'drilling',
    title: 'Minimum mechanical drill size',
    guidance:
      '0.2mm (~8 mil) mechanical drill is a common standard-tier minimum. Smaller finished holes ' +
      'may require laser drilling (HDI/microvia processes) at added cost.',
    rationale: "Drills below the fab's standard bit sizes require a different (costlier) process.",
  },
  {
    id: 'annular-ring',
    category: 'drilling',
    title: 'Minimum annular ring',
    guidance:
      'Maintain at least 0.15mm (6 mil) annular ring around drilled holes to tolerate drill ' +
      'registration error.',
    rationale:
      'Insufficient annular ring risks a "broken out" pad if the drill is slightly off-center.',
  },
  {
    id: 'copper-to-edge',
    category: 'copper',
    title: 'Copper-to-board-edge clearance',
    guidance:
      'Keep copper features at least 0.3mm (12 mil) from the board edge to avoid shorts or burrs ' +
      'introduced by routing/milling tolerance.',
    rationale:
      'Mechanical routing/milling of the board edge has positional tolerance that can nick nearby copper.',
  },
  {
    id: 'solder-mask-dam',
    category: 'solder-mask',
    title: 'Minimum solder mask dam between adjacent pads',
    guidance:
      'Maintain at least 0.1mm (4 mil) of solder mask between adjacent exposed-copper features to ' +
      'avoid a mask "sliver" that can lift or flake during fabrication.',
    rationale:
      'Very thin mask dams are mechanically fragile and prone to detaching during the mask process.',
  },
  {
    id: 'solder-mask-expansion',
    category: 'solder-mask',
    title: 'Solder mask opening size',
    guidance:
      'A typical mask opening is the pad size plus roughly 0.05-0.1mm expansion per side; confirm ' +
      "your fab's default mask expansion rather than assuming a value.",
    rationale:
      'Mask openings that are too tight relative to registration tolerance can partially cover the pad.',
  },
  {
    id: 'silkscreen-to-pad',
    category: 'silkscreen',
    title: 'Silkscreen-to-pad clearance',
    guidance:
      'Keep silkscreen at least 0.15mm (6 mil) away from exposed copper/pads so ink does not print ' +
      'onto the pad and affect solderability.',
    rationale:
      'Silkscreen printed on top of a pad can prevent proper solder wetting during assembly.',
  },
  {
    id: 'silkscreen-min-size',
    category: 'silkscreen',
    title: 'Minimum silkscreen line width and text height',
    guidance:
      'A typical minimum silkscreen line width is about 0.15mm (6 mil), with a minimum text height ' +
      'around 0.8mm (32 mil) for reliable legibility after printing.',
    rationale:
      "Finer silkscreen than the printer's resolution supports becomes blurred or illegible.",
  },
  {
    id: 'via-min-size',
    category: 'drilling',
    title: 'Minimum via drill and annular ring',
    guidance:
      'Vias generally follow the same minimum drill and annular-ring guidance as plated through-holes ' +
      '(see min-drill-size / annular-ring) unless a microvia/HDI process is explicitly used.',
    rationale:
      'Vias are manufactured with the same drilling/plating process as component through-holes.',
  },
  {
    id: 'via-in-pad',
    category: 'assembly',
    title: 'Via-in-pad requires explicit fab/assembly support',
    guidance:
      'Via-in-pad needs the fab to fill and cap/plate over the via — do not assume it is supported; ' +
      'confirm explicitly and expect added cost.',
    rationale:
      'An unfilled via under a pad can wick solder paste away during reflow, causing a poor joint.',
  },
  {
    id: 'panelization-tabs',
    category: 'panelization',
    title: 'Panelization tab/break-out clearance',
    guidance:
      'Leave adequate mouse-bite or v-score tab clearance and breakaway rail width; confirm the ' +
      "assembly house's panel requirements rather than guessing a value.",
    rationale:
      'Insufficient tab/rail clearance can damage boards during depanelization or block pick-and-place handling.',
  },
  {
    id: 'v-score-copper-setback',
    category: 'panelization',
    title: 'Copper setback from V-score lines',
    guidance:
      'Boards depanelized by V-scoring need copper set back further from the score line than boards ' +
      "depanelized by routing — check the fab's specific setback requirement for V-score.",
    rationale: 'The V-score blade path can nick copper that sits too close to the score line.',
  },
  {
    id: 'fiducials',
    category: 'assembly',
    title: 'Fiducial markers for automated assembly',
    guidance:
      'Include at least 2-3 global board fiducials for pick-and-place vision alignment, plus local ' +
      'fiducials on fine-pitch parts (0.5mm pitch or finer).',
    rationale:
      'Automated placement equipment relies on fiducials to correct for panel and board positional error.',
  },
  {
    id: 'tented-vias',
    category: 'solder-mask',
    title: 'Explicitly decide tented vs. untented vias',
    guidance:
      'Decide and specify whether vias should be tented (solder-mask covered), especially in dense ' +
      'BGA/fine-pitch areas, to avoid solder wicking into open via barrels during reflow.',
    rationale:
      'An unspecified default may not match what the design actually needs, and varies by fab.',
  },
];

export function listDfmChecklist(category?: DfmCategory): (DfmChecklistItem & {
  source: string;
  caveat: string;
})[] {
  const items = category ? CHECKLIST.filter((item) => item.category === category) : CHECKLIST;
  return items.map((item) => ({
    ...item,
    source: 'General PCB fabrication/assembly industry practice',
    caveat: CHECKLIST_CAVEAT,
  }));
}

export function getDfmChecklistItem(
  id: string,
): (DfmChecklistItem & { source: string; caveat: string }) | undefined {
  const item = CHECKLIST.find((entry) => entry.id === id);
  if (!item) return undefined;
  return {
    ...item,
    source: 'General PCB fabrication/assembly industry practice',
    caveat: CHECKLIST_CAVEAT,
  };
}

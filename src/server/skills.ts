import { fileURLToPath } from 'node:url';
import { SkillsExtension, type SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';

// Serve only audited workflows during this experimental pilot.
const SKILL_NAMES = new Set(['design-validation', 'easyeda-component-review']);
export const BUNDLED_SKILL_NAMES = Object.freeze([...SKILL_NAMES].sort());

export async function loadBundledSkills(): Promise<SkillCatalog> {
  const root = fileURLToPath(new URL('../../skills/', import.meta.url));
  const files = nodeSkillFiles(root);
  return SkillsExtension.load(
    {
      list: async (folder) =>
        folder === ''
          ? (await files.list(folder)).filter((entry) => SKILL_NAMES.has(entry.name))
          : files.list(folder),
      read: (name) => files.read(name),
    },
    { strict: true, cacheHint: { ttlMs: 0, cacheScope: 'private' } },
  );
}

export async function maybeLoadBundledSkills(enabled: boolean): Promise<SkillCatalog | undefined> {
  return enabled ? loadBundledSkills() : undefined;
}

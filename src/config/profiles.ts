export type ToolProfile = 'core' | 'pro' | 'full' | 'dev' | 'experimental';

export interface ProfileDefinition {
  name: ToolProfile;
  label: string;
  description: string;
  approxToolCount: string;
  isDefault: boolean;
}

export const PROFILE_DEFINITIONS: Record<ToolProfile, ProfileDefinition> = {
  core: {
    name: 'core',
    label: 'Core',
    description:
      'High-confidence tools: diagnostics, EasyEDA API inventory, schematic, BOM, DRC/ERC, board layers/stackup, Gerber export',
    approxToolCount: '60',
    isDefault: true,
  },
  pro: {
    name: 'pro',
    label: 'Pro',
    description:
      'Adds pick-and-place, PDF, netlist export, compound transactional workflow tools, autorouting, route-context export, and offline SPICE verification for manufacturing workflows',
    approxToolCount: '76',
    isDefault: false,
  },
  full: {
    name: 'full',
    label: 'Full',
    description:
      'Adds controlled documented EasyEDA API method calls and CircuitIR-driven floorplanning for full runtime control without raw JavaScript execution',
    approxToolCount: '88',
    isDefault: false,
  },
  dev: {
    name: 'dev',
    label: 'Dev',
    description:
      'Adds diagnostics probes for bridge methods and live component runtime shape inspection',
    approxToolCount: '93',
    isDefault: false,
  },
  experimental: {
    name: 'experimental',
    label: 'Experimental',
    description: 'MCP Apps, Tasks, AI action plans',
    approxToolCount: '93',
    isDefault: false,
  },
};

export function getEnabledProfiles(active: ToolProfile): ToolProfile[] {
  const order: ToolProfile[] = ['core', 'pro', 'full', 'dev', 'experimental'];
  const idx = order.indexOf(active);
  if (idx === -1) return ['core'];
  return order.slice(0, idx + 1);
}

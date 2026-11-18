import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'EasyEDA MCP Pro',
  description:
    'Inspect native EasyEDA Pro projects with MCP, review evidence and control design writes.',
  base: '/easyeda-mcp-pro/',
  appearance: 'dark',
  srcExclude: ['superpowers/**'],
  head: [
    ['meta', { name: 'theme-color', content: '#091c1b' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/easyeda-mcp-pro/logo.svg' }],
    ['meta', { property: 'og:type', content: 'website' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'EasyEDA MCP Pro — Understand the design before you change it',
      },
    ],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Inspect live EasyEDA Pro projects with MCP, review engineering evidence and retain control of design writes.',
      },
    ],
    [
      'meta',
      {
        property: 'og:image',
        content: 'https://oaslananka.github.io/easyeda-mcp-pro/og-easyeda-mcp-pro.png',
      },
    ],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    search: { provider: 'local' },
    logo: '/logo.svg',
    siteTitle: 'EasyEDA MCP Pro',
    nav: [
      { text: 'Get Started', link: '/guide/getting-started' },
      {
        text: 'Workflows',
        items: [
          { text: 'Schematic Review', link: '/examples/schematic-review' },
          { text: 'BOM & Sourcing', link: '/examples/bom-sourcing' },
          { text: 'Before Fabrication', link: '/examples/manufacturing-review' },
          { text: 'Cookbook', link: '/examples/cookbook' },
        ],
      },
      { text: 'Tools', link: '/reference/tools' },
      { text: 'Compatibility', link: '/reference/easyeda-compatibility' },
      { text: 'GitHub', link: 'https://github.com/oaslananka/easyeda-mcp-pro' },
    ],
    sidebar: [
      {
        text: 'Start',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/' },
          { text: 'First Connection', link: '/guide/getting-started' },
          { text: 'Installation', link: '/INSTALLATION' },
          { text: 'Local vs Cloud', link: '/REMOTE_MCP_MODES' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Use EasyEDA',
        collapsed: true,
        items: [
          { text: 'Schematic Review', link: '/examples/schematic-review' },
          { text: 'BOM & Sourcing', link: '/examples/bom-sourcing' },
          { text: 'Before Fabrication', link: '/examples/manufacturing-review' },
          { text: 'Workflow Cookbook', link: '/examples/cookbook' },
          { text: 'Power Tree', link: '/power-tree' },
          { text: 'PCB Constraints', link: '/pcb-constraints' },
          { text: 'Professional Layout', link: '/professional-schematic-layout' },
          { text: 'Design Rule Reviews', link: '/design-rules' },
        ],
      },
      {
        text: 'Tools & Boundaries',
        collapsed: true,
        items: [
          { text: 'MCP Tool Reference', link: '/reference/tools' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'EasyEDA Compatibility', link: '/reference/easyeda-compatibility' },
          { text: 'Save, Export & Recovery', link: '/reference/save-export-rollback-safety' },
          { text: 'Bridge Contract', link: '/reference/bridge-contract' },
          { text: 'Resources & Prompts', link: '/reference/resources-prompts' },
          { text: 'Remote MCP Modes', link: '/REMOTE_MCP_MODES' },
        ],
      },
      {
        text: 'Project & Governance',
        collapsed: true,
        items: [
          { text: 'Roadmap', link: '/ROADMAP' },
          { text: 'Release Policy', link: '/RELEASE_POLICY' },
          { text: 'Security Assurance', link: '/SECURITY_ASSURANCE_CASE' },
          { text: 'Supply Chain Verification', link: '/supply-chain-verification' },
          { text: 'Runtime Inventory', link: '/reference/runtime-inventory' },
          { text: 'Observability Budgets', link: '/observability-budgets' },
          { text: 'Codecov Analytics', link: '/CODECOV_ANALYTICS' },
          { text: 'Best Practices Evidence', link: '/BEST_PRACTICES_BADGE' },
          { text: 'Issue Triage', link: '/ISSUE_TRIAGE' },
          {
            text: 'Contributing',
            link: 'https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md',
          },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/oaslananka/easyeda-mcp-pro' }],
    outline: { level: [2, 3], label: 'On this page' },
    footer: {
      message:
        'Open source under AGPL-3.0-only. Review the safety contract before enabling writes.',
      copyright: 'Copyright © 2026-present oaslananka',
    },
  },
});

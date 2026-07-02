import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'EasyEDA MCP Pro',
  description:
    'Production-grade MCP server for EasyEDA Pro: safe PCB design inspection, BOM sourcing, manufacturing export, and AI-assisted hardware review.',
  base: '/easyeda-mcp-pro/',
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Tools Reference', link: '/reference/tools' },
      { text: 'Resources & Prompts', link: '/reference/resources-prompts' },
      { text: 'EasyEDA Compatibility', link: '/reference/easyeda-compatibility' },
      { text: 'Bridge Contract', link: '/reference/bridge-contract' },
      { text: 'Runtime Inventory', link: '/reference/runtime-inventory' },
      { text: 'Bridge Telemetry', link: '/reference/bridge-telemetry' },
      { text: 'Save/Export Safety', link: '/reference/save-export-rollback-safety' },
      { text: 'Supply Chain Verification', link: '/supply-chain-verification' },
      { text: 'Vendor API Hardening', link: '/vendor-api-hardening' },
      { text: 'Component Quality', link: '/component-quality' },
      { text: 'Vendor API Hardening', link: '/vendor-api-hardening' },
      { text: 'Issue Triage', link: '/ISSUE_TRIAGE' },
    ],
    sidebar: [
      {
        text: 'Examples',
        items: [
          { text: 'Cookbook Gallery', link: '/examples/cookbook' },
          { text: 'Schematic Review', link: '/examples/schematic-review' },
          { text: 'BOM Sourcing', link: '/examples/bom-sourcing' },
          { text: 'Component Quality', link: '/component-quality' },
          { text: 'Manufacturing Review', link: '/examples/manufacturing-review' },
          { text: 'Power Tree Analyzer', link: '/power-tree' },
          { text: 'High-Level PCB Layout', link: '/high-level-pcb-layout' },
          { text: 'Production QA Artifacts', link: '/production-qa' },
          { text: 'Observability Budgets', link: '/observability-budgets' },
          { text: 'Golden Eval Benchmark', link: '/benchmark-suite' },
          { text: 'Golden Eval Benchmark', link: '/benchmark-suite' },
          { text: 'Observability Budgets', link: '/observability-budgets' },
          { text: 'Production QA Artifacts', link: '/production-qa' },
          { text: 'High-Level PCB Layout', link: '/high-level-pcb-layout' },
          { text: 'Claude Prompts', link: '/examples/claude-prompts' },
        ],
      },
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          { text: 'Best Practices Badge', link: '/BEST_PRACTICES_BADGE' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'MCP Tools', link: '/reference/tools' },
          { text: 'Resources & Prompts', link: '/reference/resources-prompts' },
          { text: 'EasyEDA Compatibility', link: '/reference/easyeda-compatibility' },
          { text: 'Bridge Contract', link: '/reference/bridge-contract' },
          { text: 'Runtime Inventory', link: '/reference/runtime-inventory' },
          { text: 'Bridge Telemetry', link: '/reference/bridge-telemetry' },
          { text: 'Save/Export Safety', link: '/reference/save-export-rollback-safety' },
          { text: 'Supply Chain Verification', link: '/supply-chain-verification' },
          { text: 'Power Tree Analyzer', link: '/power-tree' },
          { text: 'Issue Triage', link: '/ISSUE_TRIAGE' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/oaslananka/easyeda-mcp-pro' }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026-present oaslananka',
    },
  },
});

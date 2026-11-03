---
layout: home

hero:
  name: EasyEDA MCP Pro
  text: Design and review PCBs with AI
  tagline: Connect EasyEDA Pro to MCP-capable assistants for schematic inspection, engineering reviews and controlled design workflows.
  image:
    src: /hero-architecture.svg
    alt: Diagram showing an AI assistant connected through MCP to an EasyEDA Pro PCB
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Explore Tools
      link: /reference/tools

features:
  - title: Schematic & PCB Inspection
    details: Inspect components, nets, tracks and board properties through a source-aware bridge.
    icon: 🔎
    link: /examples/schematic-review
  - title: Engineering & Rule Reviews
    details: Evaluate declared design constraints with explicit evidence and conservative results.
    icon: 🛡️
    link: /design-rules
  - title: BOM & Component Quality
    details: Review bill-of-materials data, component suitability and sourcing workflows.
    icon: 📊
    link: /examples/bom-sourcing
  - title: Guided Setup
    details: Install the MCP server, import the bridge extension and connect your preferred client.
    icon: ⚡
    link: /guide/getting-started
  - title: Bridge & Compatibility
    details: Understand runtime capabilities, versions, project scope and transport requirements.
    icon: 🔗
    link: /reference/easyeda-compatibility
  - title: Controlled Save & Export
    details: Learn the write-approval, save and export safety boundaries before making changes.
    icon: 🔒
    link: /reference/save-export-rollback-safety
---

<div class="docs-entry">
  <div class="docs-entry-heading">
    <span class="docs-eyebrow">DOCUMENTATION</span>
    <h2>Start here</h2>
    <p>Choose the shortest path from installation to a working, well-scoped EasyEDA review.</p>
  </div>
  <div class="docs-entry-grid">
    <a class="docs-entry-link" href="./INSTALLATION.html">
      <span class="docs-entry-index">01</span>
      <strong>Install</strong>
      <span>Prerequisites and bridge extension</span>
    </a>
    <a class="docs-entry-link" href="./guide/getting-started.html">
      <span class="docs-entry-index">02</span>
      <strong>Quick Start</strong>
      <span>Connect an MCP client</span>
    </a>
    <a class="docs-entry-link" href="./reference/tools.html">
      <span class="docs-entry-index">03</span>
      <strong>Tool Reference</strong>
      <span>Available actions and inputs</span>
    </a>
    <a class="docs-entry-link" href="./reference/easyeda-compatibility.html">
      <span class="docs-entry-index">04</span>
      <strong>Compatibility</strong>
      <span>Supported EasyEDA runtime surface</span>
    </a>
  </div>
</div>

<div class="docs-safety-note">
  <span class="docs-safety-symbol" aria-hidden="true">ⓘ</span>
  <p><strong>Evidence before approval.</strong> Automated reviews do not independently certify electrical correctness, manufacturing readiness or fabrication suitability. <a href="./reference/save-export-rollback-safety.html">Read the save/export safety model</a>.</p>
</div>

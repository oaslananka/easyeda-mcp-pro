---
layout: home
title: EasyEDA MCP Pro — Understand the design before you change it
description: Inspect native EasyEDA Pro project data with MCP, review engineering evidence and explicitly control writes.
hero:
  name: EasyEDA MCP Pro
  text: Understand the design before you change it.
  tagline: Connect your open EasyEDA Pro project to an MCP assistant. Inspect components, trace nets and make intentional changes — without losing control of project scope.
  image:
    src: /board-workflow.svg
    alt: An illustrative 3V3 net review with component references, not a screenshot from EasyEDA
  actions:
    - theme: brand
      text: Connect EasyEDA
      link: /guide/getting-started
    - theme: alt
      text: Try a review
      link: /examples/schematic-review
---

<div class="ee-home-intro">
  <p class="ee-eyebrow">LOCAL-FIRST · PROJECT-SCOPED · OPEN SOURCE</p>
  <p class="ee-intro-line">Start with a question about your circuit, not a catalog of commands.</p>
  <div class="ee-proof-links">
    <a href="./reference/easyeda-compatibility.html">Live-tested versions <span aria-hidden="true">↗</span></a>
    <a href="./reference/save-export-rollback-safety.html">Write safeguards <span aria-hidden="true">↗</span></a>
    <a href="./REMOTE_MCP_MODES.html">Local vs Cloud <span aria-hidden="true">↗</span></a>
  </div>
</div>

<section class="ee-section" aria-labelledby="ee-workflow-title">
  <div class="ee-section-heading">
    <div>
      <p class="ee-eyebrow">A PRACTICAL WORKFLOW</p>
      <h2 id="ee-workflow-title">Trace the power rail. Then decide what to check.</h2>
    </div>
    <p>The assistant can retrieve native project facts. Engineering judgement still needs the datasheets and physical layout.</p>
  </div>
  <div class="ee-review">
    <div class="ee-review-prompt">
      <span class="ee-window-bar"><span class="ee-window-dot" aria-hidden="true"></span>Your question</span>
      <blockquote>“Which components use the 3V3 rail? Show the connections and what I should verify about decoupling.”</blockquote>
      <p class="ee-review-note">An example prompt, not a recorded live transcript or verified engineering result.</p>
    </div>
    <div class="ee-review-steps">
      <div class="ee-step"><span class="ee-step-index">01</span><div><strong>Read the active design</strong><p>Inspect native schematic nets and component references in the open project.</p></div></div>
      <div class="ee-step"><span class="ee-step-index">02</span><div><strong>Follow the evidence</strong><p>Check pin connections, part values and placement against your design requirements.</p></div></div>
      <div class="ee-step"><span class="ee-step-index">03</span><div><strong>Decide before writing</strong><p>Review changes deliberately. An automated review is not electrical or fabrication certification.</p></div></div>
      <a class="ee-text-link" href="./examples/schematic-review.html">Schematic review walkthrough <span aria-hidden="true">↗</span></a>
    </div>
  </div>
</section>

<section class="ee-section" aria-labelledby="ee-tasks-title">
  <div class="ee-section-heading">
    <div><p class="ee-eyebrow">CHOOSE YOUR TASK</p><h2 id="ee-tasks-title">Built around engineering work.</h2></div>
    <p>Follow a task, inspect the result in EasyEDA and decide the next action yourself.</p>
  </div>
  <div class="ee-task-grid">
    <a class="ee-task" href="./examples/schematic-review.html">
      <span class="ee-task-symbol">SCH / 01</span>
      <h3>Review a schematic</h3>
      <p>Trace nets and pins, then inspect evidence before moving components.</p>
      <span class="ee-task-link">Open workflow <span aria-hidden="true">↗</span></span>
    </a>
    <a class="ee-task" href="./examples/bom-sourcing.html">
      <span class="ee-task-symbol">BOM / 02</span>
      <h3>Check the parts list</h3>
      <p>Inspect designators, supplier IDs and unknown sourcing data without guessing stock.</p>
      <span class="ee-task-link">Open workflow <span aria-hidden="true">↗</span></span>
    </a>
    <a class="ee-task" href="./examples/manufacturing-review.html">
      <span class="ee-task-symbol">PCB / 03</span>
      <h3>Review before fabrication</h3>
      <p>Collect rule-check and export evidence for a human review before manufacturing.</p>
      <span class="ee-task-link">Open workflow <span aria-hidden="true">↗</span></span>
    </a>
  </div>
</section>

<section class="ee-section" aria-labelledby="ee-boundaries-title">
  <div class="ee-section-heading">
    <div><p class="ee-eyebrow">CONTROL WHAT CHANGES</p><h2 id="ee-boundaries-title">A clear line between reading and writing.</h2></div>
    <p>Capabilities depend on the tool profile, focused project and remote owner permissions.</p>
  </div>
  <div class="ee-permission">
    <div class="ee-permission-row ee-permission-head"><span>Action</span><span>What happens</span></div>
    <div class="ee-permission-row"><strong>Inspect</strong><span>Read tools return available native data from the selected project. Unavailable facts remain unavailable.</span></div>
    <div class="ee-permission-row"><strong>Change</strong><span>Eligible mutations require the correct profile and explicit <code>confirmWrite=true</code>; Cloud requires additional owner approval.</span></div>
    <div class="ee-permission-row"><strong>Save / export</strong><span>Save is explicit. Export and ERC/DRC/BOM results support human review, never automatic safety or fabrication approval.</span></div>
  </div>
  <a class="ee-text-link" href="./reference/save-export-rollback-safety.html">Complete save, export and recovery contract <span aria-hidden="true">↗</span></a>
</section>

<section class="ee-section ee-endcap" aria-labelledby="ee-connect-title">
  <div>
    <p class="ee-eyebrow">FIRST CONNECTION</p>
    <h2 id="ee-connect-title">Your editor stays the source of truth.</h2>
    <p>Start locally without a Cloud account. Install the MCP client configuration, import the bundled EasyEDA bridge extension, and open your project. Hosted access is a separate opt-in path with pairing and project permissions.</p>
    <div class="ee-endcap-actions"><a class="ee-action-primary" href="./guide/getting-started.html">Connect EasyEDA <span aria-hidden="true">↗</span></a><a class="ee-text-link" href="./reference/tools.html">Browse tools</a></div>
  </div>
  <aside class="ee-evidence">
    <span class="ee-evidence-label">EVIDENCE, NOT A DEMO CLAIM</span>
    <strong>What has actually been tested?</strong>
    <p>The versioned <a href="./reference/easyeda-compatibility.html">compatibility record</a> distinguishes real editor acceptance, modeled tests and unsupported runtime APIs.</p>
    <p class="ee-evidence-foot">The illustration above is a workflow sketch; no fabricated live screenshots or metrics.</p>
  </aside>
</section>

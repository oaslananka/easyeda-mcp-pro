# Roadmap

This roadmap describes the intended direction for `easyeda-mcp-pro` for the next 12 months. It is not a promise of delivery; it is a planning document for users, contributors, and OpenSSF Best Practices evidence.

## Active delivery milestones

| Milestone                                           | Target date   | Public tracker                                                                                                                                                              | Outcome                                                                                                   |
| --------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **v1.0.0 — Release stabilization and promotion**    | Not scheduled | [Epic #420](https://github.com/oaslananka/easyeda-mcp-pro/issues/420) · [Release gate #437](https://github.com/oaslananka/easyeda-mcp-pro/issues/437)                       | Verify the next release candidate, complete the required release gates, and decide stable v1.0 promotion. |
| **v1.1.0 — PCB side-aware inspection and mutation** | Not scheduled | [Side-aware capture #470](https://github.com/oaslananka/easyeda-mcp-pro/issues/470) · [Copper-zone contract #480](https://github.com/oaslananka/easyeda-mcp-pro/issues/480) | Make side-specific PCB inspection deterministic and restore only verified mutation contracts.             |
| **v1.2.0 — MCP 2026-07-28 compatibility**           | Not scheduled | [Compatibility program #476](https://github.com/oaslananka/easyeda-mcp-pro/issues/476)                                                                                      | Add explicit dual-era MCP compatibility without weakening transport or authorization controls.            |

The live GitHub milestones currently have no due dates. A target date belongs here only when it is an explicit planning commitment; absence of a date must not be replaced with an inferred deadline.

## Milestone and branch lifecycle

Version-bound milestones use the title pattern `v<target> — <outcome>`. Readiness programs that span several prereleases use a clear outcome title such as `v1.0 readiness — <outcome>`.

A milestone stays open only while it represents future work. Maintainers close a milestone after its release has shipped and it has no open issues; issue assignments, descriptions, and historical discussion remain intact. Completed work is not moved merely to make progress percentages look cleaner.

Each active milestone has a public tracker: use an epic when several deliverables need coordinated sequencing, or link the directly scoped issues when a separate epic would add no durable value. Trackers and child issues stay assigned to the same milestone so the roadmap can be read from either view.

Remote branches are retained only while they contain active, unmerged work or support an open pull request. Before deleting a stale branch, maintainers verify patch equivalence and preserve any unique, still-valid code or documentation on `main`.

The release automation branch `release-please--branches--main--components--easyeda-mcp-pro` is exempt from stale-branch cleanup while it backs an active release pull request. It may be removed after that pull request is merged or closed.

## Project scope

`easyeda-mcp-pro` is a production-oriented MCP server for EasyEDA Pro. Its scope is controlled hardware-design assistance: schematic inspection, BOM workflows, safe manufacturing exports, supplier lookup, diagnostics, and security-conscious AI-assisted review.

The project does **not** aim to provide unattended paid ordering, bypass EasyEDA or supplier terms, redistribute vendor catalog data, or perform unrestricted arbitrary JavaScript execution by default.

## Next 12 months

### 2026 Q3: Security and release maturity

- Complete OpenSSF Best Practices Passing and Silver evidence.
- Keep branch protection, CodeQL, dependency monitoring, secret scanning, push protection, and release provenance enabled.
- Document signed release and verification steps.
- Reduce release-process ambiguity for npm packages, GitHub releases, SBOMs, and the EasyEDA bridge extension artifact.
- Add more regression tests for bug fixes and high-risk bridge/export paths.

### 2026 Q4: Tool quality and coverage

- Improve coverage in low-coverage modules, especially CLI setup, server factory, and supplier clients.
- Expand golden evaluations for common schematic, BOM, DRC/ERC, and manufacturing-review workflows.
- Add more negative-path tests for input validation, file paths, OAuth, and bridge pairing failures.
- Improve generated tool reference docs and examples for each profile: `core`, `pro`, `full`, and `dev`.

### 2027 Q1: User experience and compatibility

- Improve setup diagnostics for Claude Desktop, Cursor, VS Code, Windsurf, Cline, Gemini, Zed, Amazon Q, and Continue.
- Maintain compatibility tracking for EasyEDA Pro bridge APIs and document known unsupported versions.
- Improve troubleshooting flows for bridge installation, WebSocket connectivity, OAuth configuration, and supplier credentials.
- Add practical example workflows for schematic review, BOM sourcing, and manufacturing handoff.

### 2027 Q2: Safety model and ecosystem hardening

- Strengthen the safety model for write operations, export workflows, and vendor integrations.
- Continue to keep raw bridge execution disabled by default and isolated behind explicit experimental flags.
- Review vendor terms and unsupported workflows at least once per release cycle.
- Improve assurance-case evidence for trust boundaries, secure defaults, input validation, dependency monitoring, and release integrity.

## Maintenance policy

The latest npm and GitHub release is the actively maintained release. Older versions are best-effort only; users should upgrade to the latest release unless a documented compatibility issue prevents it.

## Non-goals

- Automatic paid ordering without explicit human confirmation.
- Redistributing proprietary EasyEDA, JLCPCB, LCSC, Mouser, or DigiKey data.
- Replacing human engineering review for manufacturability or safety-critical design decisions.
- Enabling remote HTTP exposure without explicit authentication and allowed-origin controls.

## Shipped roadmap history

Versioned work that has already shipped is represented by closed GitHub milestones, the [changelog](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CHANGELOG.md), and GitHub Releases. Remote MCP Gateway and self-hosted tunnel work originally planned for v0.18.0 is documented in [Remote MCP modes](./REMOTE_MCP_MODES.md), the [remote security model](./REMOTE_SECURITY_MODEL.md), and the [extension relay protocol](./EXTENSION_RELAY_PROTOCOL.md).

# MCP Resources and Prompts

`easyeda-mcp-pro` exposes a small agent-native MCP resource and prompt layer in addition to tools.

## Resources

| URI                                     | Type                   | Purpose                                                                       |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `easyeda://project/{projectId}/netlist` | JSON resource template | Read-only project netlist snapshot from the EasyEDA bridge.                   |
| `easyeda://project/{projectId}/bom`     | JSON resource template | Read-only project BOM snapshot from the EasyEDA bridge.                       |
| `easyeda://workflow/project-review`     | Markdown resource      | Safe review workflow for schematic, BOM, PCB, export, and write confirmation. |
| `easyeda://design-rules/reference`      | Markdown resource      | Overview of the topics available via `easyeda_design_rules_lookup`.           |
| `easyeda://design-rules/dfm-checklist`  | JSON resource          | The full static design-for-manufacturability reference checklist.             |

The project resources are read-only. If the EasyEDA bridge is unavailable, the resource returns a structured JSON payload with `not_available: true` instead of throwing. The design-rules resources are static reference data — no bridge connection required.

## Prompts

| Prompt                         | Arguments   | Purpose                                                                                       |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| `review_schematic`             | `projectId` | Guide an agent through schematic connectivity review before changes.                          |
| `review_bom`                   | `projectId` | Guide an agent through BOM completeness and sourcing readiness review.                        |
| `prepare_manufacturing_review` | `projectId` | Guide an agent through pre-manufacturing export and approval checks.                          |
| `review_layout`                | `projectId` | Guide an agent through PCB constraint checks and design-rules lookups before layout sign-off. |

Each prompt points the agent back to the registered resources:

```text
 easyeda://project/<projectId>/netlist
 easyeda://project/<projectId>/bom
 easyeda://workflow/project-review
```

## Safety model

Resources and prompts do not mutate EasyEDA design state. Mutations still happen only through MCP tools that declare `confirmWrite: true`; those tools support the `writeMode=plan|preview|apply|verify` transaction flow.

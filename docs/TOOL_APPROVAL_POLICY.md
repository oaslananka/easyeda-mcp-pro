# Remote tool approval policy

Remote tool approval protects the user from unintended project changes when a cloud MCP client or self-hosted remote endpoint controls an active EasyEDA session.

## Risk levels

| Risk level  | Examples                                                                                                                                                               | Default behavior                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Read        | list project, inspect netlist, read BOM, read DRC/ERC report, capture canvas image, run an offline SPICE simulation                                                    | Allowed after auth and pairing.                                          |
| Write       | add component, create net, edit wire, update PCB primitive, verify/cache a catalog device, run a compound schematic/layout workflow (place+wire, floorplan, autoroute) | Requires explicit approval.                                              |
| Export      | write Gerber, pick-and-place, PDF, netlist, manufacturing package, or route-context artifacts to the configured artifact directory                                     | Requires explicit approval; this is independent of local `confirmWrite`. |
| Destructive | delete, overwrite, bulk replace, publish/share, place order                                                                                                            | Requires stronger confirmation or is disabled by default.                |

## Classification boundary

The tool's documentation group is not an authorization decision. The runtime resolves the explicit
`sideEffect` metadata first:

- `artifact-write` maps to Remote Relay `export` risk;
- `design-mutation`, `local-state-write`, and `external-action` map to write/destructive policy based
  on the declared risk;
- `read-only` remains read-only even when a report is displayed in the export section.

Local `confirmWrite` protects EasyEDA design mutations. Remote export approval protects artifact
creation across a network trust boundary. They are deliberately separate controls.

## Approval prompt requirements

The extension approval prompt should show:

- requesting client or account,
- active EasyEDA project name or identifier,
- tool name and risk level,
- human-readable action summary,
- expected change list when available,
- approve, reject, and timeout outcomes.

## Gateway enforcement

The gateway must enforce approval policy before dispatching the final action to the extension. Approval state must be tied to:

- user identity,
- extension session,
- tool name,
- input hash,
- expiration time.

A previous approval must not authorize a materially different input payload.

## Default policy

- Read tools: no prompt after auth and pairing.
- Write tools: prompt required.
- Export tools: prompt required.
- Destructive tools: prompt plus stronger confirmation, or disabled until explicitly enabled.

## Audit events

Approval events should record:

- approval request id,
- user id or local operator id,
- session id,
- tool name,
- risk level,
- input hash,
- approve/reject/timeout,
- duration.

Secrets and raw project payloads must not be logged by default.

# Remote tool approval policy

Remote tool approval protects the user from unintended project changes when a cloud MCP client or self-hosted remote endpoint controls an active EasyEDA session.

## Risk levels

| Risk level  | Examples                                                                                                                                                               | Default behavior                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Read        | list project, inspect netlist, read BOM, read DRC/ERC report, capture canvas image, run an offline SPICE simulation                                                    | Allowed after auth and pairing.                           |
| Write       | add component, create net, edit wire, update PCB primitive, verify/cache a catalog device, run a compound schematic/layout workflow (place+wire, floorplan, autoroute) | Requires explicit approval.                               |
| Export      | generate Gerber, BOM, pick-and-place, manufacturing package, vendor-neutral route-context (DSN)                                                                        | Requires explicit approval.                               |
| Destructive | delete, overwrite, bulk replace, publish/share, place order                                                                                                            | Requires stronger confirmation or is disabled by default. |

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

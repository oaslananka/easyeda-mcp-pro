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

## Temporary project-session authorization (Hosted Cloud)

For explicitly allowlisted **routine design edits** and **local artifact exports**, one EasyEDA
native approval may authorize further eligible calls from the **same authenticated OAuth client**
to the **same paired device and native project UUID** for a **fixed 30-minute maximum** (also bounded
by the native session lifetime). Writes and exports are independent grants.

The initial MCP invocation still gets `APPROVAL_REQUIRED`. The native confirmation explicitly
describes the selected project and the 30-minute scope. The MCP client retries the original
unchanged invocation once with `remoteApprovalId`; later eligible routine calls proceed without
new native prompts until the grant expires, the device disconnects, or its permission is revoked.
An explicitly reused/stale `remoteApprovalId` never bypasses replay protection.

This is **not** another OAuth token or stored permission database. The gateway rechecks the
OAuth identity and scopes, paired device, selected native document, and trusted tool metadata
on every invocation. Only a native approval that actually **displayed the project-session scope**
can create the grant. A refreshed valid OAuth access token for the same client may reuse its still-live native grant,
but an expired or revoked access token cannot authorize a call. The grant cannot be inherited
by another OAuth client even with the
same owner, by an unknown client, or by a project lacking native UUID evidence. Each call
still requires the normal tool-side `confirmWrite=true` when applicable.

The reviewable allowlist includes routine schematic edits and project save, normal PCB trace
creation and snapshot-backed component transforms, and local artifact exports. Unverified
via dimensions, copper rebuilding, bulk deletion operations, raw API execution, external side
effects and unknown future tools retain per-action approval or remain blocked. These are
operation categories, not exemptions from validation, DRC/ERC or manufacturing-readiness checks.

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
- Allowlisted routine writes: one native approval per authenticated client and native project session (up to 30 minutes).
- Local artifact exports: a separate first native approval per authenticated client and native project session (up to 30 minutes).
- Other writes/exports: require a fresh native approval per action.
- Destructive/external actions: require stronger per-action approval or remain disabled.

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

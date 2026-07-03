# Pairing and session routing

Pairing binds a remote MCP identity to an active EasyEDA bridge extension session. Session routing ensures every tool call reaches only the intended user's EasyEDA project.

## Pairing lifecycle

```text
extension enters Remote Relay Mode
  ↓
extension registers session
  ↓
gateway issues or accepts pairing code
  ↓
user completes pairing in hosted app or remote client flow
  ↓
gateway binds user id to extension session id
  ↓
remote tools can route to that session until expiry/disconnect
```

## Pairing requirements

- Pairing codes are short-lived.
- Pairing codes are single-use.
- Session IDs are not guessable.
- Pairing binds user, extension session, and deployment mode.
- Re-pairing is required after explicit disconnect or session expiry.

## Session router contract

Input:

- authenticated user id,
- requested tool name,
- requested risk level,
- optional active project hint.

Output:

- active extension session id,
- relay connection id,
- active project metadata,
- policy/approval requirement,
- safe error if unresolved.

## Multi-window behavior

The first MVP should avoid ambiguous routing. If multiple EasyEDA sessions are active, the extension or gateway should require the user to select the intended project/session before write or export operations.

## Expiration and disconnects

Sessions should expire automatically and fail closed. A disconnected extension must cause remote tool calls to return a safe disconnected-session error rather than queueing unexpected future mutations.

## Security tests

Tests should prove that:

- user A cannot route to user B's session,
- expired pairings cannot be reused,
- duplicate active sessions require explicit selection,
- disconnected sessions fail safely,
- approval state is tied to session and input hash.

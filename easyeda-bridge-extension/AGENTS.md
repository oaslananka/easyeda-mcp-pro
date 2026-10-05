# EasyEDA Bridge Extension Instructions

These instructions apply to `easyeda-bridge-extension/**` and supplement the repository root
`AGENTS.md`.

## Boundary

This workspace package executes inside the EasyEDA Pro/browser runtime. It is the boundary that
translates validated server requests into EasyEDA API calls and returns runtime/read-back evidence.

Read these before material changes:

- `docs/SAFETY_MODEL.md`
- `docs/security-architecture.md`
- `docs/EXTENSION_RELAY_PROTOCOL.md`
- `docs/REMOTE_MCP_MODES.md`
- `CONTRIBUTING.md`

## Loader and dispatcher responsibilities

Keep the loader/runtime shell small.

- `src/index.ts` owns socket/runtime lifecycle and should change only when that lifecycle requires
  it.
- EasyEDA operation behavior belongs in the dispatcher/domain operation modules rather than growing
  the loader.
- Development hot-swap is a development mechanism, not a production authorization bypass.
- Marketplace/production builds must preserve the repository's production hot-swap restrictions.

## Connection policy

The local cleartext WebSocket boundary is intentionally narrow.

- Local `ws://` connectivity stays on the fixed OS loopback host and bounded bridge port range
  enforced by `src/connection-policy.ts`.
- Do not broaden local `ws://` to LAN/public hosts for convenience.
- Remote relay connectivity uses its authenticated secure transport; do not implement remote access
  by weakening local bridge restrictions.
- Preserve bounded reconnect, heartbeat, liveness, payload, and pairing behavior.
- Extension-originated echoed heartbeats are not proof that the server is alive.

## EasyEDA API and mutation safety

- Use documented/verified EasyEDA Pro API surfaces and explicit runtime capability checks.
- APIs marked beta or version-sensitive must fail explicitly when unavailable.
- Validate all deterministic preconditions before the first mutation when possible.
- Preserve `confirmWrite`, preview/apply, transaction, rollback, and read-back semantics established
  by the server/tool contract.
- Do not silently reinterpret native `undefined`, missing state, or stale runtime objects as
  successful mutation.
- Timeout/disconnect during mutation means outcome unknown until read back; never blind-retry a
  non-idempotent write.
- Keep unsupported operations fail-closed rather than inventing raw or undocumented API fallbacks.

## Local and remote mutation paths

Local bridge execution and remote relay execution must preserve equivalent tool safety semantics.

Remote approval is additional to local design-mutation confirmation. The extension must not accept a
remote mutation/export merely because the same operation would be locally callable.

## Build and package contract

The extension is a private workspace package whose distributable artifact is packaged into the
repository release.

Use repository-owned commands:

```bash
pnpm typecheck:extension
pnpm test:extension
pnpm build:extension
pnpm verify:extension
pnpm check:extension-size
```

Do not hand-edit generated `dist/` output or the packaged `.eext` artifact. Regenerate through the
workspace scripts.

Bundle-size ratchets are policy, not a convenience target. Move them only with an intentional,
measured change and preserve the hard package ceiling.

## Live evidence

Mocked extension tests validate contracts but do not prove behavior in a particular EasyEDA Pro
build.

When compatibility-sensitive EasyEDA API behavior changes:

- use a disposable project for live mutation evidence;
- record the exact EasyEDA/runtime version and implementation revision;
- verify persisted state through the established read-back path;
- do not promote contract-only evidence into a live compatibility claim.

## Verification

During extension iteration, run focused extension tests plus the workspace checks above and
`pnpm verify:fast`.

Before handoff or PR creation, run the root `pnpm verify` contract.

## Definition of done

An extension change is complete only when browser/runtime lifecycle, transport policy, EasyEDA API
behavior, mutation safety, read-back evidence, tests, package verification, and compatibility claims
remain aligned.

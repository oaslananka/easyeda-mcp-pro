# Live E2E / diagnostic scripts

Developer-only scripts that drive a real MCP server (`dist/index.js`) against a
live EasyEDA Pro session over the bridge. They are **not** part of CI and require
EasyEDA Pro open with the bridge extension connected.

Build first (`pnpm build`), then run from the repo root:

| Script       | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `diag.mjs`   | Quick diagnostic: bridge state, capabilities, tool registration.       |
| `live.mjs`   | Full live schematic net-creation + connectivity validation (7 phases). |
| `http.mjs`   | Same validation against an already-running HTTP-transport server.      |
| `waiter.mjs` | Starts a server and waits for the bridge to connect (manual probing).  |

```bash
pnpm build
node scripts/e2e/live.mjs
```

Each script resolves the repo root from its own location, so they can be run
from anywhere. Normal end users never need these — they are for validating
bridge/runtime behavior during development.

> Ad-hoc, one-off experiment scripts (e.g. `_scratch_*.mjs`) are gitignored and
> should stay out of version control. See the shared-harness work in the issue
> tracker for consolidating server lifecycle handling.

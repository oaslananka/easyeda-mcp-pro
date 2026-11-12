# Save Export Undo and Rollback Safety

EasyEDA project state changes are handled with explicit gates. This server does not promise an automatic cross-runtime undo or rollback API.

## Required sequence

For schematic or PCB mutations:

1. Use `writeMode=plan` or `writeMode=preview`.
2. Create a user-managed checkpoint or backup of the project.
3. Apply only after human approval with `confirmWrite=true`.
4. Run read-only verification such as netlist validation, ERC, DRC, BOM checks, or export checks.
5. Save only with an explicit `easyeda_project_save` call.

## Save

`easyeda_project_save` persists the current EasyEDA project state. It is never implicit and requires `confirmWrite=true`.

## Safely list, open and close EasyEDA projects

The three project lifecycle tools are available with the **core** profile:

- `easyeda_project_list` reads the team-scoped project list, returning each project's UUID, name and whether it is the active project. Other projects' open status is `null` (unknown), **not** `false`. If the native team/project list cannot be verified, `complete=false`; never interpret an empty result as proof there are no projects.
- `easyeda_project_open` takes the exact project UUID and `confirmWrite=true`. If another document is open, the request is refused because EasyEDA can discard unsaved changes when switching projects. Opening the already active project is idempotent. When switching from an empty Start Page, the native project UUID is verified after opening. Always save/close another project in the editor first; do not force a project switch.
- `easyeda_project_close` takes a project UUID, a `mode`, and `confirmWrite=true`. The default `refuse_if_dirty` refuses to close an open document with status `dirty_state_unavailable`: EasyEDA Pro 3.2.209 does **not** expose a trustworthy unsaved-change bit. `mode=save` first saves each matching PCB or schematic document, verifies the focused native document/project ID, and only then closes each tab; a failed/unknown save never invokes close. `mode=discard` intentionally discards unsaved edits and is explicitly destructive. Panel save is not verified and remains blocked.

**Always inspect the returned `success` and `status`.** A native timeout or lost reply is `native_outcome_unknown`, not proof that the action failed or succeeded. The remote relay requires its own separate approval for project writes and destructive actions; `confirmWrite` is not remote approval. No project lifecycle tool promises automatic rollback or that a write can be safely retried.

Upstream EasyEDA documents that `DMT_Project.openProject` and `DMT_EditorControl.closeDocument` can discard unsaved changes without a prompt; this is why the default behavior is conservative. [Opening projects](https://prodocs.easyeda.com/en/api/reference/pro-api.dmt_project.openproject.html) · [Closing documents](https://prodocs.easyeda.com/en/api/reference/pro-api.dmt_editorcontrol.closedocument.html).

### Live compatibility record — EasyEDA Pro 3.2.209 (2026-11-12)

On an isolated Linux editor session, the bundled extension was installed and exercised against a backed-up disposable L-shaped PCB:

- **List:** two native team scopes yielded eight distinct project UUIDs and names; the active project was identified and other projects' `open` state remained `null`.
- **Open:** an empty Start Page allowed a confirmed UUID-based project open; its PCB and schematic identities were read back after the native document tree became available. Switching away with an open PCB was refused.
- **Close clean / save:** a clean PCB was saved, its correct native tab was closed exactly once, the asynchronous tab read-back confirmed closure, and a cold restart reopened the unchanged L-shaped board.
- **Close with unsaved edits:** a temporary PCB text object was placed visibly without an explicit save. Default `refuse_if_dirty` refused closure, and switching projects was also blocked. An independently confirmed `discard` closed that one disposable tab. After a cold restart, the unsaved text was absent and the persisted design structure matched the pre-test backup.
- **Native persistence detail:** the complete SQLite file hash changed after the discard because EasyEDA incremented `project_structures.ticket` by one; the `structure` payload and all other application table data were unchanged. Raw file-byte equality therefore cannot alone establish whether a native discard preserved design content. The disposable project file was restored from its verified backup after the test.

No production project, manufacturing output, or native copper-zone apply capability was used. Native source data supplies no reliable clean/dirty bit, so the default must remain conservative even for an apparently clean open document. A lost acknowledgement must never trigger an automatic second close.

## Export

Export tools write artifacts, not design state. Exports still require hash manifests, structural validation, and human review before manufacturing use.

## Undo and rollback

Automatic undo or rollback is not guaranteed. Recovery depends on saved EasyEDA projects, backups, disposable test projects, or user-managed copies.

The machine-readable policy lives in `src/safety/runtime-safety.ts` and is covered by unit tests.

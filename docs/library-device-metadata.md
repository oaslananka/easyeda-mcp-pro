# Personal Device metadata and thumbnail reinsertion

`easyeda_library_update_device_metadata` provides native preview/apply for review
properties in the current Personal library. It is available in core and higher
profiles and requires the existing library write scope, local confirmation and
remote approvals. It never infers review approval, invents review dates or performs
the engineering review itself.

**The reusable workflow has loaded-build live evidence on EasyEDA Pro 3.2.206
for Windows**, using a disposable Personal Device cloned from C164170. Preview,
confirmed apply, independent metadata/image readback, a no-write repeat and full
application restart/readback passed. This evidence covers one existing JPEG;
it does not certify other images, runtimes or engineering review results.
Network/CORS failures are surfaced, not treated as success.

## Preview, then apply

Use explicit 32-character Personal library and Device UUIDs. Select
`thumbnailPolicy: "reinsert-existing"` to authorize reuploading the existing image
in the same native write. This preserves image bytes, not necessarily its URL.

```json
{
  "libraryUuid": "11111111111111111111111111111111",
  "deviceUuid": "22222222222222222222222222222222",
  "mode": "preview",
  "thumbnailPolicy": "reinsert-existing",
  "properties": {
    "Review Status": "Reviewed - mechanical library",
    "Review Date": "2026-10-16",
    "Review Scope": "Footprint lands and closed-state model alignment.",
    "Review Notes": "Hinge/service and design-level clearance checks excluded."
  }
}
```

UUIDs are placeholders; review statements and date are examples, not defaults.
Preview performs no native write/upload. It returns current `saved` metadata,
proposed `changedFields`, `fingerprintBefore`, and `thumbnail` containing
`sha256Before`, `byteLength`, `mimeType`, `originalUrl` and `urlMayChange: true`.

To apply, repeat the request with `mode: "apply"`, `confirmWrite: true`,
`expectedFingerprint` copied from `fingerprintBefore`, and
`expectedThumbnailSha256` copied from `thumbnail.sha256Before`. Both preview tokens
are required. The registry's separate `writeMode: "preview"` is only a static plan;
use **`mode: "preview"`** to obtain native state and image hashes.

## Supported first version

- Only the explicitly named current Personal library; System/project/team libraries fail closed.
- Only EasyEDA semantic version **3.2.206**, the runtime with native live evidence.
- String-valued custom property updates. Existing retained custom values must also
  be strings because the native runtime coerces numeric/boolean values.
- Exactly one existing PNG/JPEG thumbnail, at most **512 KiB**.
- Only supported HTTPS paths on `image-pro.easyeda.com` and `alimg.szlcsc.com`;
  no arbitrary host, URL override, port, credentials, query, fragment or redirects.

Description changes and property deletion are not enabled in reinsertion mode
because their native behavior has not been verified to the same standard.
Omission-only production apply remains blocked with
`NATIVE_METADATA_WRITES_DISABLED`. No identity, supplier, symbol/footprint/model
binding, transform or geometry field is editable through this tool.

Downloads omit credentials, bypass caches, time out after 3.5 seconds, and cap
streamed bytes regardless of Content-Length. PNG/JPEG signatures determine MIME
type; native image decoding/upload can still reject malformed images. No raw
JavaScript, file path, image URL input or environment override is introduced.

## Mutation and verification

The bridge reads `LIB_Device.get(deviceUuid, libraryUuid)` explicitly without a
project-cache fallback, verifies identity and plain native data, and checks the
Device fingerprint and image hash against preview. It retains the current image,
merges requested strings into existing custom properties, and reads native state
again before writing. Concurrent drift aborts. Overlapping requests for the same
Device in one dispatcher are rejected.

It makes **one** documented `LIB_Device.modify` call containing the retained image
Blob and merged property map. Name, classification and description are actual
JavaScript undefined. It does not first clear the image and then attempt recovery.
Already-present requested metadata returns `unchanged` without another native
write/upload. This avoids both thumbnail-loss windows and duplicate uploads.

After every attempted write, including exceptions or false native results, the
bridge reads native state again and downloads the saved image URL. Verification
compares requested metadata, SHA-256 image bytes and every unrequested native
field. Only requested custom fields and `association.images` URLs are excluded
from the whole-record comparison; image bytes are checked separately. Observable
symbol/footprint/model references and transforms must remain unchanged. Hidden
asset data and referenced geometry are not certified by those checks.

The result includes before/after fingerprints, `saved`, preservation checks,
runtime version, image hashes/URLs, `bytesIdentical` and `reinsertionAttempted`.
Different saved metadata, image bytes or unrelated fields fail verification.
Unavailable post-write image/native readback is `uncertain`. Native acknowledgement
is reported separately as `writeOutcome`: `not_attempted`, `acknowledged`,
`rejected` or `unknown`. Fully matching readback after a native exception can
establish verified saved state while acknowledgement remains unknown.

EasyEDA has no conditional-write API. Final preflight is optimistic, not atomic
compare-and-swap; readback detects resulting drift. There are no automatic retries
or rollbacks over concurrent edits. A server/bridge timeout during apply means
unknown outcome: read back before any retry.

| Status                | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `preview`             | Native state/image inspected, no upload or write.                     |
| `unchanged`           | Requested metadata already present, no native write.                  |
| `verified`            | Requested values, image bytes and preservation checks passed.         |
| `rejected`            | Preconditions failed before attempting a write.                       |
| `verification_failed` | Saved metadata/image or unrelated fields differ.                      |
| `uncertain`           | Transport, native operation or readback leaves an unresolved outcome. |

`device-v1:sha256:…` hashes the detached full native record with recursively sorted
object keys, original array order, JSON scalar values and omitted undefined fields.
It includes references, not referenced file contents, and is not an approval token.

## Review guidance and evidence

Inspect the datasheet, actual footprint and actual bound model before recording
review claims. Use scoped fields such as Review Status, Review Date, Review Scope,
Review Source and Review Notes. Record remaining hinge/service, shell-ground or
design-specific checks. The tool does not establish manufacturing/electrical
approval from a metadata save.

For AI-assisted review of devices used in a design, first compare the actual
footprint and bound model with the manufacturer datasheet. Keep unresolved
findings and exclusions in the review record; only mark the covered checks as
reviewed when their evidence passes. This tool supplies the verified metadata
save step, rather than the footprint or model analysis.

The [redacted Windows live evidence](./evidence/easyeda-live/2026-10-16-windows-easyeda-3.2.206-device-metadata.json)
identifies the exact source commit, production package hash/size and loaded
dispatcher. All reusable-tool writes were confined to the disposable copy.
Fresh native readbacks preserved all unrequested fields, including symbol and
footprint associations, the model reference and transform. Independent downloads
confirmed identical 12,287-byte JPEG content before/after apply and after restart;
the image URL changed as permitted. Repeating apply performed no second write or
image reinsertion. Private UUIDs, image URLs and native payloads remain local.

The initial live preview exposed EasyEDA shadowing the bare `AbortController`
constructor and failed before any write. Downloads now resolve the constructor
through `globalThis`, retaining the timeout and failing closed if unavailable.
Regression tests reproduce the shadowed-constructor failure. Network redirects,
stalls and unknown native outcomes have automated contract coverage; they were
not deliberately induced during the successful live save.

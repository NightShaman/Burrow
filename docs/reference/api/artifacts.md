# Files, Forge and exports


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-11-01**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


These endpoints read and modify runtime-owned files or produce transferable data. These routes pass through the configured interactive-auth gate; diagnostics tokens do not grant them. With authentication mode `none`, that gate does not require credentials.

## Workspace editing

The workspace API supports listing, reading and overwriting existing text files. Query `agentId` and `scope=agent` selects an agent workspace; default `scope=workspaces` selects the workspace container. GET file also needs `path`. POST accepts `path`, string `content`, optional `agentId`, and `scope`/`workspaceScope`.

Listing is bounded to 1,000 entries and omits most hidden/generated directories. Reads and writes are limited to 1 MiB. The write route requires an existing regular file; it is not a general create/delete/terminal endpoint. Lexical path traversal outside the selected root is rejected, but this UI helper is not a security sandbox for the broader runtime.

## Attachments and generated artifacts

List session-referenced attachments with `agentId`, `sessionId` (default `default`) and `limit` (default 200). The artifact path/storage reference is relative runtime metadata returned by BURROW, not an arbitrary absolute path. Use the returned identity to read bytes. DELETE attachment removes that artifact early; it is separate from transcript or conversation deletion.

Generated artifact download and attachment download return bytes with server-selected content type. Keep these URLs and browser caches private. Artifact bytes live under agent workspaces while conversation references are stored in PostgreSQL, so coordinated backup needs both.
See [Storage ownership](../../architecture/persistence.md)

## Forge generation

Read `/api/forge/catalog` before exposing or selecting a mode. Available image, speech or music options depend on configured model capabilities; a Video tab or schema entry is not proof of an implemented generation path. Save mode selection with `{mode, connectionId, modelId}`.

Create a job with `prompt` and a nonblank `idempotencyKey`, plus either:

- `mode`, using its saved model selection; or
- A complete explicit `connectionId`/`modelId` pair, optionally with a compatible `mode`

The optional canonical-photo selectors `useAgentReferenceImage`, `referenceAgentIds` and `useOperatorReferenceImage` are also accepted as described below. `attachments`, `sourceAttachments` and generic `options` are rejected. Generation can be paid. A matching idempotency key/request replays the existing job (200); a new claim returns 202; reusing a key for a different request returns 409. Keep the same key when reconciling an uncertain submission rather than creating another paid job.

Poll job detail for a terminal result and inspect `errorDetails` when present. Artifact GET supports `download=1`. There is no general Forge cancellation endpoint in this reference. A successful generation does not prove attachment delivery.

Attach with exactly `agentId`, `sessionId` and `artifactId` to an existing destination session after job success. Delivery has an idempotency path; verify destination records and bytes separately from generation. The previously missing path import in attachment cleanup is present in this build.
## Forge deletion and retained Archive

`DELETE /api/forge/jobs/{id}` takes no body and returns `{ok: true}`. Only succeeded, failed or interrupted jobs can be deleted. Queued/running jobs return409 `forge_job_active`; missing/deleted jobs return404. A committed Archive receipt is required before removal. This is not a cancellation endpoint.

`GET /api/archive/forge` returns `{records: [...]}`, newest first, across the operator's Forge history. It includes prompt, provider/model IDs, status, timestamps, bounded call summaries and outcome; deleted jobs retain `deletedAt`. It is a **metadata-only** archive, not media storage, but prompts can still be sensitive. Both routes require operator access; diagnostics-only API tokens cannot use them.

Delete removes the live job and eligible generated files, not separate chat attachment copies or files shared by another job. Idempotency claims survive deletion: reusing the old key returns 409 `idempotency_conflict`, never another paid dispatch. Filesystem cleanup and SQL are not one atomic transaction; a failure can leave the terminal job visible with some media already removed. Preserve its Archive evidence, inspect the result, and reconcile before retrying cleanup.

## Selective export/import

Read `/api/export/catalog` to discover categories. POST export with the selected categories and format/security options returns a downloadable bundle, not the ordinary JSON envelope. The current catalog contains agents/profiles, operator text skills, Core scheduled definitions, portable settings, model connections, MCP connections, UI authentication and task-board state. Sessions, traces and API documentation are not selectable categories. Treat all exports as sensitive, particularly identities and provider credentials; secret-bearing categories require a password of at least 12 characters.

Import is preview-first: submit the encoded bundle to `/api/export/import/preview`, inspect changes/conflicts, then apply with explicit confirmation and conflict policy through `/api/export/import`. Without confirmation the apply endpoint returns `400 import_confirmation_required` with the preview.

Categories can span stores; do not assume a full installation image or a single all-or-nothing cross-category transaction. The public assembly includes `backend/docs/openapi.json`, but that file is not a portable export category. Follow [backup and recovery](../../operations/backup-recovery.md) for disaster recovery rather than relying on selective export alone.

## Endpoint inventory

Additional current routes: `DELETE /api/forge/jobs/{id}` and `GET /api/archive/forge`, with the lifecycle and access semantics above.

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/workspace/files` | List workspace files |
| `GET` | `/api/workspace/file` | Read a workspace file |
| `POST` | `/api/workspace/file` | Write a workspace file |
| `GET` | `/api/export/catalog` | List export categories |
| `POST` | `/api/export` | Create a selected export bundle |
| `POST` | `/api/export/import/preview` | Preview an export import |
| `POST` | `/api/export/import` | Apply an export import |
| `GET` | `/api/attachments` | List attachment artifacts referenced by a session |
| `GET` | `/api/attachments/{agentId}/{artifactPath}` | Read an attachment artifact |
| `DELETE` | `/api/attachments/{agentId}/{artifactPath}` | Delete an attachment artifact before retention expiry |
| `GET` | `/api/generated-artifacts/{agentId}/{storageReference}` | Download a persisted generated artifact |
| `GET` | `/api/forge/catalog` | Read eligible generation models |
| `GET` | `/api/forge/jobs` | List persisted generation jobs |
| `POST` | `/api/forge/jobs` | Create or replay a generation job |
| `GET` | `/api/forge/jobs/{id}` | Read one generation job |
| `POST` | `/api/forge/jobs/{id}/attach` | Attach an artifact to an existing session |
| `GET` | `/api/forge/jobs/{id}/artifacts/{artifactId}` | Read/download artifact bytes |
| `GET` | `/api/forge/selections` | Read per-mode model selections |
| `PUT` | `/api/forge/selections` | Save a mode selection |

## Targeted source review

The full page was reconciled on **2026-11-01** against Backend commit `8b5889115680bcdbf698f1b93126254e1cf4d2e6`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/docs/openapi.json](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)
- [backend/scripts/ui/export-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/export-routes.mjs)
- [backend/src/postgres-forge-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-forge-store.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## Canonical reference-image generation

Catalog entries expose `agentReferenceImage:{available,reason}` per model. Top-level `agentReferenceImages` lists registered agents with saved photo metadata; `operatorReferenceImage` is metadata or null. Trusted agent callers also receive their own `agentReferenceImage` or null. Catalog reads metadata, not image bytes. Each photo's `attachmentId` can be inspected with `attachment_view`.

HTTP `POST /api/forge/jobs` and native `forge_create_job` accept nullable ordered `referenceAgentIds` and `useOperatorReferenceImage:true`. Native callers may prepend their own photo with `useAgentReferenceImage:true`; direct HTTP has no trusted caller identity, so that self-only flag fails `forge_context_unavailable`. Explicit agent IDs work over HTTP. Agent selections are deduplicated in first-selection order, with the operator photo last. False/null/omission leaves flags off; null/empty IDs select no additional agents. No public request accepts source bytes, URLs or filesystem paths.

Supported image models send actual original PNG/JPEG/WebP bytes: qualifying OpenAI-compatible image-only models with declared image input use multipart `images/edits`; supported native Google image models use GenerateContent `inlineData`. Explicit capability overrides remain authoritative. Missing photos, non-image modes or unsupported models fail before paid dispatch, not silently as text-only generation. A selected absent operator photo yields `operator_reference_image_missing`; other reference errors include `agent_reference_image_missing`, `agent_reference_image_unsupported`, `agent_reference_image_image_only` and `agent_reference_image_invalid`. Aggregate originals are bounded by the existing media allocation budget (256 MiB default); overflow yields `reference_images_too_large`.

Admission snapshots selected bytes privately before its SQL transaction. Revision, owner, ordering and byte digests bind the idempotency claim; changing a photo conflicts with a reused key. Replacing/removing a saved photo cannot change admitted bytes. SQL stores metadata/digests, not the image bytes. Restart still interrupts queued/running work without redispatch. Generation authorization, operator-wide job ownership and the independently trusted attachment destination are unchanged.

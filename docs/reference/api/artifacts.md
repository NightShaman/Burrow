# Files, Forge and exports


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


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

Only those five fields are accepted. `attachments`, `sourceAttachments` and generic `options` are rejected. Generation can be paid. A matching idempotency key/request replays the existing job (200); a new claim returns 202; reusing a key for a different request returns 409. Keep the same key when reconciling an uncertain submission rather than creating another paid job.

Poll job detail for a terminal result and inspect `errorDetails` when present. Artifact GET supports `download=1`. There is no general Forge cancellation endpoint in this reference. A successful generation does not prove attachment delivery.

Attach with exactly `agentId`, `sessionId` and `artifactId` to an existing destination session after job success. Delivery has an idempotency path; verify destination records and bytes separately from generation. The previously missing path import in attachment cleanup is present in this build.
## Selective export/import

Read `/api/export/catalog` to discover categories. POST export with the selected categories and format/security options returns a downloadable bundle, not the ordinary JSON envelope. Treat exports as sensitive, especially when including identities, conversations, provider configuration or credentials.

Import is preview-first: submit the encoded bundle to `/api/export/import/preview`, inspect changes/conflicts, then apply with explicit confirmation and conflict policy through `/api/export/import`. Without confirmation the apply endpoint returns `400 import_confirmation_required` with the preview.

Categories can span stores; do not assume a full installation image or a single all-or-nothing cross-category transaction. The public assembly includes `backend/docs/openapi.json`; the earlier missing-contract-asset claim no longer applies. API-contract export still needs live verification for the installed release. Follow [backup and recovery](../../operations/backup-recovery.md) for disaster recovery rather than relying on selective export alone.

## Endpoint inventory

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

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/docs/openapi.json](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)
- [backend/scripts/ui/export-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/export-routes.mjs)
- [backend/src/postgres-forge-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-forge-store.mjs)

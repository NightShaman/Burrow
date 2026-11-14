# Files, Forge and exports


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-11-08**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


These endpoints read and modify runtime-owned files or produce transferable data. These routes pass through the configured interactive-auth gate; diagnostics tokens do not grant them. With authentication mode `none`, that gate does not require credentials.

## Workspace editing

The workspace API supports listing, reading and overwriting existing text files. Query `agentId` and `scope=agent` selects an agent workspace; default `scope=workspaces` selects the workspace container. GET file also needs `path`. POST accepts `path`, string `content`, optional `agentId`, and `scope`/`workspaceScope`.

Listing is bounded to 1,000 entries and omits most hidden/generated directories. Reads and writes are limited to 1 MiB. The write route requires an existing regular file; it is not a general create/delete/terminal endpoint. Lexical path traversal outside the selected root is rejected, but this UI helper is not a security sandbox for the broader runtime.

## Attachments and generated artifacts

List session-referenced attachments with `agentId`, `sessionId` (default `default`) and `limit` (default 200). The artifact path/storage reference is relative runtime metadata returned by BURROW, not an arbitrary absolute path. Use the returned identity to read bytes. DELETE attachment removes that artifact early; it is separate from transcript or conversation deletion.

Generated artifact download and attachment download return bytes with server-selected content type. Keep these URLs and browser caches private. Artifact bytes live under agent workspaces while conversation references are stored in PostgreSQL, so coordinated backup needs both.
See [Storage ownership](../../architecture/persistence.md)

## Forge generation

Read `/api/forge/catalog` before exposing or selecting a mode. Available image, video, speech or music options depend on configured model capabilities. Native Google video has an implemented contract described below; a Video tab alone does not establish that your connection supports it. Save mode selection with `{mode, connectionId, modelId}`.

Create a job with `prompt` and a nonblank `idempotencyKey`, plus either:

- `mode`, using its saved model selection; or
- A complete explicit `connectionId`/`modelId` pair, optionally with a compatible `mode`

The optional canonical-photo selectors `useAgentReferenceImage`, `referenceAgentIds` and `useOperatorReferenceImage` are also accepted, alongside typed `imageOptions` and image/video `referenceArtifacts`, as described below. `attachments`, `sourceAttachments` and generic `options` are rejected. Generation can be paid. A matching idempotency key/request replays the existing job (200); a new claim returns 202; reusing a key for a different request returns 409. Keep the same key when reconciling an uncertain submission rather than creating another paid job.

Poll job detail for a terminal result and inspect `errorDetails` when present. Artifact GET supports `download=1`. There is no general Forge cancellation endpoint in this reference. A successful generation does not prove attachment delivery.

Attach with exactly `agentId`, `sessionId` and `artifactId` to an existing destination session after job success. Delivery has an idempotency path; verify destination records and bytes separately from generation. The previously missing path import in attachment cleanup is present in this build.
## Forge deletion and retained Archive

`DELETE /api/forge/jobs/{id}` takes no body and returns `{ok: true}`. Only succeeded, failed or interrupted jobs can be deleted. Queued/running jobs return 409 `forge_job_active`; missing/deleted jobs return 404. A committed Archive receipt is required before removal. This is not a cancellation endpoint.

`GET /api/archive/forge` returns `{records: [...]}`, newest first, across the operator's Forge history. It includes prompt, provider/model IDs, status, timestamps, bounded call summaries and outcome; deleted jobs retain `deletedAt`. It is a **metadata-only** archive, not media storage, but prompts can still be sensitive. Both routes require operator access; diagnostics-only API tokens cannot use them.

Delete removes the live job and eligible generated files, not separate chat attachment copies or files shared by another job. Idempotency claims survive deletion: reusing the old key returns 409 `idempotency_conflict`, never another paid dispatch. Filesystem cleanup and SQL are not one atomic transaction; a failure can leave the terminal job visible with some media already removed. Preserve its Archive evidence, inspect the result, and reconcile before retrying cleanup.

## Forge gallery

Checked **14 November 2026**: the operator-wide Gallery lists retained, succeeded image/video jobs, including eligible legacy agent-generated jobs. It excludes mod-private jobs, audio, ordinary chat uploads and deleted artifacts. Gallery organization does not duplicate media or change its original Forge identity.

| Method | Path | Request/result |
|---|---|---|
| `GET` | `/api/forge/gallery` | `{ok, folders, images}`; folders have `id,name,parentId,createdAt,updatedAt`; each image/video entry has `jobId,artifactId,folderId,createdAt,artifact`. |
| `POST` | `/api/forge/gallery/folders` | JSON `{name,parentId?}`; trimmed name 1–200 characters, omitted/null parent means root; returns 201 `{ok,folder}`. |
| `PUT` | `/api/forge/gallery/images/{jobId}/{artifactId}` | JSON `{folderId}`; explicit null returns media to root; returns `{ok,jobId,artifactId,folderId}`. |
| `DELETE` | `/api/forge/gallery/images/{jobId}/{artifactId}` | Deletes one eligible media artifact; returns `{ok,jobId,artifactId}`. |

The `images` name also covers videos. Artifact projections contain ID, kind, name, MIME type, byte size and authenticated preview/download URLs, not prompts, storage paths or provider request material. Unknown folders/media return 404; malformed requests return 400. There are no folder rename, move or delete routes.

Single-media deletion requires retained Archive evidence and leaves the job's original outcome/count represented in Archive metadata. It removes the live artifact locator and placement, and deletes unshared generated bytes. Original Forge links and copied references then fail; already-sent chat copies remain. The public job no longer lists the deleted artifact. This is irreversible media cleanup, not hiding an item or cancelling generation. SQL and filesystem deletion are not atomic; inspect failures before retrying rather than assuming rollback restored the bytes.

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

The full page was reconciled on **2026-11-08** against Backend commit `6b682eae6cd0dc6efa79e173b7d819fb219443b3`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/docs/openapi.json](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)
- [backend/scripts/ui/export-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/export-routes.mjs)
- [backend/src/postgres-forge-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-forge-store.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## Canonical reference-image generation

Catalog entries expose `agentReferenceImage:{available,reason}` per model. Top-level `agentReferenceImages` lists registered agents with saved photo metadata; `operatorReferenceImage` is metadata or null. Trusted agent callers also receive their own `agentReferenceImage` or null. Catalog reads metadata, not image bytes. Each photo's `attachmentId` can be inspected with `attachment_view`.

HTTP `POST /api/forge/jobs` and native `forge_create_job` accept nullable ordered `referenceAgentIds` and `useOperatorReferenceImage:true`. Native callers may prepend their own photo with `useAgentReferenceImage:true`; direct HTTP has no trusted caller identity, so that self-only flag fails `forge_context_unavailable`. Explicit agent IDs work over HTTP. Agent selections are deduplicated in first-selection order, with the operator photo last. False/null/omission leaves flags off; null/empty IDs select no additional agents. No public request accepts source bytes, URLs or filesystem paths.

Supported reference-image models send actual original PNG/JPEG/WebP bytes. Qualifying OpenAI-compatible image/GIF generation uses multipart `images/edits`; supported native Google image generation uses GenerateContent `inlineData`, and supported Google video uses Interactions image content. Effective image-input capabilities remain authoritative. Missing photos or unsupported mode/model combinations fail before paid dispatch, not silently as text-only generation. A selected absent operator photo yields `operator_reference_image_missing`; other reference errors include `agent_reference_image_missing`, `agent_reference_image_unsupported` and `agent_reference_image_invalid`. Generated-media allocation has no default 256 MiB cap; explicitly configured budgets and the separate reference-image limits still apply.

Admission snapshots selected bytes privately before its SQL transaction. Revision, owner, ordering and byte digests bind the idempotency claim; changing a photo conflicts with a reused key. Replacing/removing a saved photo cannot change admitted bytes. SQL stores metadata/digests, not the image bytes. Restart still interrupts queued/running work without redispatch. Generation authorization, operator-wide job ownership and the independently trusted attachment destination are unchanged.

## Native chat completion and delivery

Checked **6 November 2026**: `forge_create_job` requires a trusted originating agent/session, waits locally for a terminal job, and returns succeeded artifacts after automatic assistant-authored delivery. HTTP `POST /api/forge/jobs` remains asynchronous. The HTTP attach route produces an operator-authored attachment-only turn; native `forge_attach_artifact` sends as the assistant. Do not manually reattach a newly created native result already delivered by creation.

The stored delivery receipt binds agent, session, originating run and reset generation before paid dispatch. Cancelling the waiting chat does not cancel the provider job; a later success still targets that recorded conversation, while reset fencing prevents stale delivery into a new generation. Generation failure returns `ok:false` and the safe failed job without a paid retry. `forge_wait_interrupted` describes interruption of the waiter, not cancellation of the durable job.

Public chat-requested jobs expose `delivery.status` (`pending`, `delivered` or `failed`) and optional `forge_delivery_failed`, not private destination/reset metadata. Delivery failure leaves successful generation/artifacts intact. Reopening the runtime reconciles succeeded undelivered jobs, and explicit same-key retries can reconcile delivery without another paid dispatch. Native assistant attachment retries within the same turn are idempotent. An explicit `forge_attach_artifact` call in a later turn sends the existing artifact again without regenerating it, so external transports can deliver a requested resend. HTTP/manual calls without trusted run identity retain conversation-scoped deduplication; operator and assistant sends have separate identities. An uncertain attachment commit is checked against the durable conversation before copied bytes are removed.

## Viewing a copied Forge image reference

The native `attachment_view` tool accepts a copied `[forge:<jobId>:<artifactId>]` reference (or its unbracketed form), with both IDs in UUID form. Core resolves it through the operator-owned Forge store and reads the existing artifact, rather than treating it as a path or URL. Supported display types are PNG, JPEG, GIF and WebP, at most 20 MiB. Invalid references, unavailable/deleted artifacts, unsupported media and oversized files return distinct failures. This is an image inspection path, not a new HTTP upload endpoint, generation request or proof of chat delivery.

## Typed image options and animated GIF

Checked **12 November 2026**: HTTP and native creation accept nullable `imageOptions`. Omission/null preserves provider defaults; an explicit object selects `outputFormat` (`png`, `jpeg`, `webp` or `gif`) and optional `size`. Read each model's `imageOptions` capability before offering these controls. Compatible OpenAI-style non-text generation models expose still formats when their effective output capabilities include `image`, and GIF only when they include `gif`. A provider name or model-ID spelling does not grant GIF support. GIF-only models remain in Image mode; mixed image/GIF models keep the default still-image path.

GIF adds `frameCount` (integer 2–16, default 9) and `frameDurationMs` (integer 20–2000, default 200, rounded to the nearest 10 ms). Still formats reject those fields. Size defaults to `auto`; custom sizes must be safe positive `WIDTHxHEIGHT` integers with both edges divisible by 16. For still images the longest edge is at most 3840, aspect ratio at most 3:1, and pixel count 655360–8294400. **GIF does not inherit those still-image edge, aspect or pixel limits**: the provider owns its further limits. Catalog size suggestions are not an exhaustive allowlist.

Normalized effective options are saved on the job and bind idempotency; changing them with the same key conflicts. Per-request options do not change the saved connection. Provider-returned GIF bytes remain `image/gif` with a `.gif` artifact; Burrow does not fabricate animation from a still image. Existing previews animate GIFs, and native creation delivers them like other succeeded artifacts. Arbitrary provider options are still rejected.

## Native Google video

Video availability is derived from the catalog, not from a hardcoded model-name allowlist. The implemented path requires native Google `/v1beta` with API-key authentication, effective video output capability, a valid model ID, and a compatible Interactions contract. A model advertising only legacy `predictLongRunning` is not admitted. Declared capability is not proof of account entitlement or a successful paid call.

Dispatch uses one synchronous `POST /interactions`; completed REST `steps[].content[]` video items contain base64 MP4 bytes. Legacy Veo polling, SDK `output_video` envelopes and asynchronous background responses are not interchangeable contracts. There is no automatic paid retry or polling fallback. The default request deadline is 10 minutes, configurable up to 30 minutes; cancellation/deadline and incomplete responses do not count as generation success.

<a id="existing-forge-images-as-video-references"></a>

## Existing Forge images and chat attachments as references

For supported image and video models with image input, catalog entries expose `referenceArtifacts` availability. Video entries report `maxImages:6`; do not apply that video limit to image generation. HTTP/native creation accepts `referenceArtifacts:[{jobId,artifactId}]`. Sources must be succeeded, operator-owned image jobs containing nonempty PNG/JPEG/WebP artifacts no larger than 20 MiB each. GIF and mod-private artifacts are excluded. This is not an arbitrary upload, URL, local-path or byte-input field.

Native callers can also supply ordered `referenceAttachmentIds` for runtime-owned PNG/JPEG/WebP attachments from their trusted current agent/session. Read model `referenceAttachments` availability first. IDs are not paths, URLs or raw bytes; direct HTTP lacks that trusted chat context and rejects nonempty attachment references with `forge_context_unavailable`. These references are separate from unsupported arbitrary `attachments` or `sourceAttachments` inputs.

At most six references are allowed **for video**, combined across saved portraits, existing artifacts and chat attachments. Saved portraits precede ordered artifact images, followed by ordered chat attachment images. The video adapter sends original image bytes with `generation_config.video_config.task` set to `reference_to_video`, not a first-frame task. Supported image generation uses its existing image-edit/reference dispatch. Explicitly disabling image input disables references.

Core resolves and snapshots source bytes before admission; source identity, byte digests and ordering bind idempotency without putting base64 in SQL metadata. Changed references with the same key conflict. Missing/deleted sources fail explicitly instead of regenerating a replacement, so do not assume an old request can be resubmitted after deleting its source.

## Generated-media budgets

There is no default application byte or artifact-count cap for generated media. Provider limits and host memory still apply: JSON/base64 and decoded bytes are held in memory rather than streamed directly to storage, and concurrent jobs multiply demand. Explicit positive safe-integer connection limits `maxResponseBytes`, `maxAssetBytes`, `maxDecodedBytes` and `maxArtifactCount` can bound their respective response, asset, aggregate decoded-byte and artifact-count paths. A decoded-byte cap does not invent a metadata-response cap. Bounded streaming response reads cancel on overflow; an injected non-streaming reader cannot promise a pre-read memory bound. These generation budgets do not remove the separate 20 MiB image-reference/inspection limits or transport-specific delivery limits.

The 14 November delta review used current Backend and UI source for Gallery and image-reference changes; the earlier generation-budget review used Backend `f589673df9124a459617f76230e90d021577a067` and UI `cf5098158596b64597516a70e11a4bb490d57c0e`. Source and test definitions were inspected statically; no provider calls or application tests were run.


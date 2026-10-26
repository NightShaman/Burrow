# Memory and Dreams


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


Brains stores explicit saved memories. Conversation originals, temporary continuity and Dream processing are separate surfaces. Read [memory](../../concepts/memory.md), [Dreams](../../concepts/dreams.md) and [conversation history](../../concepts/conversation-history.md) for lifecycle semantics. The route and store behavior here was checked against current source; no live deployment test is asserted.

## Brains CRUD

Every request requires an `agentId` query parameter. The query owner overrides any body `agentId`; record identity is `(agentId, id)`. There is no global scope selector.

| Method | Path | Input / result |
|---|---|---|
| `GET` | `/api/brains` | `query` (optional substring), `limit` (default 50), `cursor`; returns `{items, nextCursor}` |
| `POST` | `/api/brains` | JSON `title`, `content`, optional string-array `sourceRefs`; returns created record |
| `GET` | `/api/brains/{id}` | Returns the active record; missing/deleted record returns 404 |
| `PUT` | `/api/brains/{id}` | JSON `title`, `content`, `expectedRevision`, optional `sourceRefs`; returns updated record |
| `DELETE` | `/api/brains/{id}` | JSON `expectedRevision`; returns the soft-deleted record |

Titles and content must be nonempty strings. `limit` must be a positive safe integer; the store does not impose a fixed page-size ceiling. Use the server-returned cursor with the same agent and query. Listing is ID-keyset paged, not a snapshot of concurrent writes. An omitted `sourceRefs` on update becomes an empty array, so supply references you intend to retain.

Responses are record/list objects, not a universal `ok` envelope. Validation errors return 400 with `error: brain_*`; revision/ownership conflicts return 409. Reload before retrying `brain_revision_conflict_or_operator_authority`. An `expectedRevision` must be a positive integer. Operator creates/edits/deletes mark records operator-owned; runtime Brain tools cannot mutate operator-owned records. DELETE is a tombstone operation, not conversation purge or physical erasure.
Example creation (use your normal authenticated client):

```http
POST /api/brains?agentId=hatchet
Content-Type: application/json

{"title":"Documentation convention","content":"Pin source links to the reviewed release commit.","sourceRefs":[]}
```

Read the returned `id` and `revision` before editing; URL-encode the ID in the item path. The [Brains interface](../../concepts/memory.md#use-brains-in-the-interface) also exposes revision conflicts and independent per-item bulk deletion. There is no atomic bulk-delete route.

## Brain embeddings

Embeddings are optional and disabled by default. They enrich the explicit runtime `brain_search` tool. `GET /api/brains` continues to use lexical substring listing even when embeddings are enabled.

| Method | Path | Input / result |
|---|---|---|
| `GET` | `/api/settings/brain-embeddings` | Enabled state, selected connection/model, generation, total/indexed/pending/failed counts, storage and last error |
| `PUT` | `/api/settings/brain-embeddings` | JSON `enabled` boolean; complete `connectionId`/`model` pair when enabling or retaining a selection |
| `GET` | `/api/settings/brain-embeddings/models` | `connectionId` query; discover models from that connection |
| `POST` | `/api/settings/brain-embeddings/test` | JSON `connectionId`, `model`; tests embedding capability and returns `{ok, dimensions}` |
| `POST` | `/api/settings/brain-embeddings/reindex` | Reset vectors, enqueue active memories and advance generation; returns status |

These routes use the normal UI authentication/browser-origin boundary. Handled embedding errors return 400 with `brain_embedding_request_failed`. Enabling indexing sends saved-memory title/content to the selected embedding provider; search sends the query. Use a connection appropriate for that data. Indexing is asynchronous: a successful settings/reindex response is not a completed-index receipt. Check `pending`, `failed` and `indexed` afterward. Jobs persist and retry with backoff; edits/deletions invalidate stale vectors.

Hybrid search ranks lexical and exact cosine matches over the active agent's records. On embedding-provider failure it returns lexical results with `retrieval: {mode: "lexical", fallback: "embedding_unavailable"}`. Ranked cursors bind the agent, query and corpus digest; changes can invalidate the cursor, requiring a fresh search. This is explicit recall, never an automatic prompt preload.
## Retired Albdruck routes and original evidence

The current router does **not** mount `/api/albdruck/*`, including `/knowledge`, `/recall`, `/history`, `/retention` or `/purge-conversation`. Legacy store/migration code and stale generated API artifacts can still mention those names; they do not make the HTTP routes available.

Use [session search and Archive](sessions.md) for original conversation evidence and `/api/settings/retention` plus its `/preview` and `/run` actions for trace-retention controls. They are not a replacement per-conversation purge API. Brains deletion does not remove an original conversation. Imported memories preserve legacy migration details; see [migration semantics](../../concepts/memory.md#legacy-albdruck-migration).
## Tiddle and promotion candidates

`GET /api/settings/tiddle` returns status for an agent. `/api/tiddle/cards` accepts `agentId`, `scope`, `limit`; `/api/tiddle/history` accepts `agentId`, `cardId`, `since`, `limit`. Signal history is not the complete original chat transcript. Current working-memory/rolling TTL defaults are 90 days, and `cardTtlDays` reads the persisted rolling policy.

Brain-promotion candidate list/review routes remain a separate surface. A candidate's presence does not mean a saved Brain memory was created.
## Dream controls

All these routes share the normal API authentication boundary. They are present in the public assembly's OpenAPI document as well as the route module; older contract copies omitted them.

| Method | Path | Behavior |
|---|---|---|
| `GET`, `PUT` | `/api/agents/{agentId}/dream-settings` | Read/save settings, with effective model and resolution error |
| `GET`, `POST` | `/api/agents/{agentId}/dream-diary` | List/render diary or append an entry |
| `POST` | `/api/agents/{agentId}/dream-memory/consolidate` | Retained legacy route; current wiring returns the missing synthesized-items error described below |
| `GET`, `POST` | `/api/agents/{agentId}/dream-cycle` | Read receipts or run a cycle |

Dream settings include `enabled`, `quietDayDreams`, `promoteToMemory`, `cron`, `prompt`, optional `modelConnectionId` and `model`. The persisted default is enabled at `0 4 * * *`, with quiet-day Dreams enabled and operator timezone/model selection. Public migration 53 retires per-Dream timezone overrides; the retained `timezone` field is returned as null and the operator timezone governs scheduling. Explicit model overrides must supply a complete valid pair. A Dream prompt is at most 20,000 characters.

Diary GET supports `date`, `phase`, `limit` (default 30) and `format`/`markdown`. Cycle receipt GET defaults to 20 entries. Cycle POST accepts `limit` and optional `generatedAt`; these are processing controls, not a separate scheduling API. Inspect the returned phase outcomes: current Dream cycles save individual Dream-generated Brain connections, not a mandatory DreamMemory preload.

The legacy `/dream-memory/consolidate` route remains mounted, but its current handler supplies no synthesized `items` to a helper that requires them. Static source therefore shows a `400 dream_memory_synthesized_items_required` outcome, not a working standalone consolidation operation. Use the current Dream-cycle workflow; do not keep retrying this legacy route or treat its presence in OpenAPI as proof it works. No runtime fix or live call was performed in this documentation pass.
### Dream publication controls

`GET`/`PUT /api/settings/brain-memory` reads/saves the global boolean `promoteDreamsToMemory` (default true). PUT requires a boolean and rejects invalid input with 400 `promote_dreams_to_memory_invalid`. Each agent also has `promoteToMemory` in Dream settings, default true; both controls must permit publication.

These switches gate saving new or updated Dream-generated Brain connections, not running the Dream cycle. Publication rereads both settings, so switching off during a run prevents later publication. Skipped changes are not queued for automatic catch-up when re-enabled, and existing memories are not deleted. Reconciliation only updates eligible Dream-origin, non-operator-owned records whose expected revision still matches; conflicts are retained for review rather than overwriting operator edits. Inspect actual cycle receipts rather than treating an enabled switch as proof a memory was saved.

## Additional endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations. Brains and embedding endpoints are listed above.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/memory/brain-promotion-candidates` | List Brain promotion candidates |
| `PATCH` | `/api/memory/brain-promotion-candidates` | Update Brain promotion candidate |
| `GET`, `PUT` | `/api/settings/brain-memory` | Global Dream-to-Brains publication setting |
| `GET` | `/api/settings/tiddle` | Read Tiddle rolling-continuity status |
| `GET` | `/api/tiddle/cards` | List current Tiddle warm cards |
| `GET` | `/api/tiddle/history` | Read append-only Tiddle Signal history |

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/ui/brain-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/brain-routes.mjs)
- [backend/scripts/ui/dream-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/dream-routes.mjs)
- [backend/src/postgres-dream-settings-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-dream-settings-store.mjs)
- [backend/docs/openapi.json](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

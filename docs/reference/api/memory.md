# Memory and Dreams

Brains stores explicit saved memories. Conversation originals, temporary continuity and Dream processing are separate surfaces. Read [memory](../../concepts/memory.md), [Dreams](../../concepts/dreams.md) and [conversation history](../../concepts/conversation-history.md) for lifecycle semantics. This page reflects the published 2026.10.10.4 source; it does not assert a live deployment test.

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

[Mounted Brain routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/brain-routes.mjs) · [Store contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs)

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

[Embedding routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/brain-routes.mjs) · [Indexing and search](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-embeddings.mjs) · [Provider contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/brain-embedding-provider.mjs)

## Retired Albdruck routes and original evidence

The current router does **not** mount `/api/albdruck/*`, including `/knowledge`, `/recall`, `/history`, `/retention` or `/purge-conversation`. Legacy store/migration code and stale generated API artifacts can still mention those names; they do not make the HTTP routes available.

Use [session search and Archive](sessions.md) for original conversation evidence and `/api/settings/retention` plus its `/preview` and `/run` actions for trace-retention controls. They are not a replacement per-conversation purge API. Brains deletion does not remove an original conversation. Imported memories preserve legacy migration details; see [migration semantics](../../concepts/memory.md#legacy-albdruck-migration).

[Current route wiring](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs) · [Retention routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/general-settings-routes.mjs)

## Tiddle and promotion candidates

`GET /api/settings/tiddle` returns status for an agent. `/api/tiddle/cards` accepts `agentId`, `scope`, `limit`; `/api/tiddle/history` accepts `agentId`, `cardId`, `since`, `limit`. Signal history is not the complete original chat transcript. Current working-memory/rolling TTL defaults are 90 days, and `cardTtlDays` reads the persisted rolling policy.

Brain-promotion candidate list/review routes remain a separate surface. A candidate's presence does not mean a saved Brain memory was created.

[Tiddle routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/general-settings-routes.mjs) · [Status policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs) · [Candidate route wiring](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs)

## Dream controls missing from the pinned OpenAPI

All these routes share the normal API authentication boundary. They are implemented even though the downloadable contract omits them.

| Method | Path | Behavior |
|---|---|---|
| `GET`, `PUT` | `/api/agents/{agentId}/dream-settings` | Read/save settings, with effective model and resolution error |
| `GET`, `POST` | `/api/agents/{agentId}/dream-diary` | List/render diary or append an entry |
| `POST` | `/api/agents/{agentId}/dream-memory/consolidate` | Consolidate working memory into Dream-memory material |
| `GET`, `POST` | `/api/agents/{agentId}/dream-cycle` | Read receipts or run a cycle |

Dream settings include `enabled`, `cron`, `timezone`, `prompt`, optional `modelConnectionId` and `model`. The persisted default is enabled at `0 4 * * *`, with inherited operator timezone and model selection. Null timezone means inheritance, not a stored snapshot of the effective zone. Explicit model overrides must supply a complete valid pair. A Dream prompt is at most 20,000 characters.

Diary GET supports `date`, `phase`, `limit` (default 30) and `format`/`markdown`. Cycle receipt GET defaults to 20 entries. Consolidation/cycle POST accept `limit` and optional `generatedAt`; these are processing controls, not a separate scheduling API. A cycle result should be inspected for actual phase outcomes.

[Dream route module](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/dream-routes.mjs) · [Controller behavior](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs) · [Defaults/selection](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-dream-settings-store.mjs)


## Additional endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations. Brains and embedding endpoints are listed above.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/memory/brain-promotion-candidates` | List Brain promotion candidates |
| `PATCH` | `/api/memory/brain-promotion-candidates` | Update Brain promotion candidate |
| `GET` | `/api/settings/tiddle` | Read Tiddle rolling-continuity status |
| `GET` | `/api/tiddle/cards` | List current Tiddle warm cards |
| `GET` | `/api/tiddle/history` | Read append-only Tiddle Signal history |

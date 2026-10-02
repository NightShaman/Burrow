# Memory and Dreams

This surface distinguishes derived knowledge, original conversation evidence, continuity cards and Dream processing. Read [memory](../../concepts/memory.md), [Dreams](../../concepts/dreams.md) and [conversation history](../../concepts/conversation-history.md) for lifecycle semantics.

## Albdruck knowledge

List knowledge with query `agentId`, `scope` (default `agent`), `state` (default `active`), `query`, `cursor` and `pageSize`. Detail and review retain the query-supplied scope; body scope cannot silently override it.

PUT reviews/corrects an item, with `operation` defaulting to `correct`. DELETE is a soft-delete review operation and reads a JSON body. Neither means purging the original conversation. `/recall` searches derived knowledge; `/history` searches original live and archived conversation entries. They are different evidence surfaces.

Albdruck responses do not universally use the common `ok` envelope. Validation errors use `error`; invalid arguments normally return 400, state/identity conflicts 409 and missing detail 404.

[Albdruck routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/albdruck-routes.mjs#L1-L31)

## Original history and purge

`POST /api/albdruck/history` searches retained original evidence; the UI Recall tab uses this endpoint. Results can include live, archived and reset conversations with completeness information. Do not replace a missing original with a generated summary and label it the same evidence.

`POST /api/albdruck/purge-conversation` is irreversible and requires the store's exact conversation identity confirmation and a reason. Active/current-main guards reject unsafe targets. It removes the original conversation and linked derived evidence through the defined store paths, but is not a promise to erase arbitrary copies, exported bundles or attachment files. Take the consequences seriously before using it.

[Purge implementation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L65-L90) · [Retention and deletion distinctions](../../concepts/memory.md)

## Tiddle and promotion candidates

`GET /api/settings/tiddle` returns status for an agent. `/api/tiddle/cards` accepts `agentId`, `scope`, `limit`; `/api/tiddle/history` accepts `agentId`, `cardId`, `since`, `limit`. The history is an append-only Signal view, not the complete original chat transcript.

Brain-promotion candidate list/review routes remain available as a separate surface. A candidate's presence is not automatic promotion or proof of a universal memory backend. Current working-memory/rolling TTL defaults are 90 days; a retained Tiddle status label can still say 30. Consult persisted policy rather than that label.

[Tiddle routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/general-settings-routes.mjs#L17-L27) · [Candidate route wiring](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3275-L3276)

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

[Dream route module](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/dream-routes.mjs#L1-L27) · [Controller behavior](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L919-L970) · [Defaults/selection](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-dream-settings-store.mjs#L21-L64)


## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/memory/brain-promotion-candidates` | List Brain promotion candidates |
| `PATCH` | `/api/memory/brain-promotion-candidates` | Update Brain promotion candidate |
| `GET` | `/api/settings/tiddle` | Read Tiddle rolling-continuity status |
| `GET` | `/api/tiddle/cards` | List current Tiddle warm cards |
| `GET` | `/api/tiddle/history` | Read append-only Tiddle Signal history |
| `GET` | `/api/albdruck/knowledge` | List derived knowledge |
| `GET` | `/api/albdruck/knowledge/{id}` | Read a knowledge item and evidence |
| `PUT` | `/api/albdruck/knowledge/{id}` | Review/correct a knowledge item |
| `DELETE` | `/api/albdruck/knowledge/{id}` | Soft-delete a knowledge item |
| `POST` | `/api/albdruck/recall` | Search derived knowledge |
| `GET` | `/api/albdruck/retention` | Read memory/conversation retention |
| `PUT` | `/api/albdruck/retention` | Save memory/conversation retention |
| `POST` | `/api/albdruck/history` | Search original live and archived conversation entries |
| `POST` | `/api/albdruck/purge-conversation` | Irreversibly purge an original conversation and its derived evidence |

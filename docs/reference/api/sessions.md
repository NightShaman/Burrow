# Sessions and Archive

A session's canonical conversation evidence is in PostgreSQL. The current prompt tail, human-facing transcript, original export, trace proof and reset/archive snapshots are distinct views. See [conversation history](../../concepts/conversation-history.md) before choosing an export or deleting data.

## Discovery and transcript operations

`GET /api/sessions` supports `agentId`, `archived=true`, `q`, `updatedSince` and `limit`. Without `agentId`, it aggregates enabled agents, sorts by update time and applies the overall limit. Archived sessions are excluded by default here; Archive list defaults differ.

For `/api/sessions/{sessionId}` and its actions, pass `agentId` in the query. Read detail for the UI projection or `/export` for canonical raw records. Mutation bodies include:

| Action | Relevant body / effect |
|---|---|
| `reset` | Captures a boundary handoff, snapshots the prior conversation and clears active entries; not erasure |
| `rename` | `{ "targetSessionId": "new-name" }` |
| `archive` | Optional `archived`; false unarchives, otherwise marks archived and can request a summary |
| `unarchive` | Clears the archive flag |
| `fork` | Optional `targetSessionId`, otherwise `<source>-fork`; separate copy/provenance, not a live branch |

Reset and archive retain original evidence. For irreversible removal use the dedicated, guarded [Albdruck purge](memory.md#original-history-and-purge) operation. Do not conflate hiding a session with deleting retained content.

[Session routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/session-routes.mjs#L152-L201) · [Store lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L833-L930)

## Context, search and continuity

`/api/session/context` and `/api/context` inspect context; `/api/session/context-status` includes current limits and live usage where available. Defaults use session `default`. These responses may expose private conversational material.

Session search accepts `q`, `role`, `limit` (default 50), `sourceId`, `since`, `until`, `agentId`, `sessionId`, `scope` and `archived`. Scope defaults to `session` when an agent/session/source selector is present, otherwise `burrow`. Explicit `scope=session` targets one selected session; broader search gathers enabled-agent evidence and includes archives unless `archived=false`.

Continuity scope is an operator-selected namespace. GET/DELETE use query fields; PUT accepts agent/session plus `continuityScope` (or `scope`). It is not a path, cwd or execution-target selector. Handoff and handoff-candidate endpoints persist continuity evidence; they do not grant authority to change agent identity.

[Context/search](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/session-routes.mjs#L44-L95) · [Continuity helpers](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L2381-L2420)

## Archive pagination

| Surface | Useful selectors |
|---|---|
| `/api/archive/calendar` | `kind`, `month`, `timezone`, `agentId` |
| `/api/archive/sessions` | `archived` (default included), `q`, `agentId`, `date`, `timezone`, `limit` (default 200), `cursor` |
| Session detail | `limit` (default 100), `before`, `from`, `to` |
| `/api/archive/runs` | `agentId`, `sessionId`, `limit` (default 100), `cursor` |
| `/api/archive/dreams` | `agentId`, `date`, `timezone`, `phase`, `limit` (default 200), `cursor` |
| `/api/archive/continuity/cards` | `agentId`, `scope`, `limit` (default 200), `cursor` |

Use server-returned cursors and completeness/continuation information. A visible page or “copy loaded” UI action is not necessarily a full-history export. Calendar grouping uses the requested timezone. Invalid calendar/date/timezone/cursor arguments return a 400-class error.

Authority endpoints return execution explanations, not a new permission grant. Archive proof success, child completion, verification and final delivery are separate pieces of evidence.

[Archive routing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/session-routes.mjs#L96-L151) · [Archive UI](../../concepts/interface.md)


## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | List sessions for incremental export discovery |
| `GET` | `/api/sessions/{sessionId}` | Read one session |
| `POST` | `/api/sessions/{sessionId}/reset` | Reset a session |
| `GET` | `/api/session/continuity-scope` | Read continuity scope |
| `PUT` | `/api/session/continuity-scope` | Set continuity scope |
| `DELETE` | `/api/session/continuity-scope` | Clear continuity scope |
| `GET` | `/api/session/handoff` | Read session handoff |
| `POST` | `/api/session/handoff` | Write session handoff |
| `POST` | `/api/session/handoff-candidate` | Write a handoff candidate |
| `GET` | `/api/archive/sessions` | List human-facing archived sessions and reset snapshots |
| `GET` | `/api/archive/sessions/{agentId}/{sessionId}` | Read a human-facing archived session or reset snapshot |
| `POST` | `/api/sessions/{sessionId}/rename` | Rename a session |
| `POST` | `/api/sessions/{sessionId}/archive` | Archive a session |
| `POST` | `/api/sessions/{sessionId}/unarchive` | Unarchive a session |
| `POST` | `/api/sessions/{sessionId}/fork` | Fork a session |
| `GET` | `/api/sessions/{sessionId}/authority` | List session authority explanations |
| `GET` | `/api/sessions/{sessionId}/authority/latest` | Read latest session authority explanation |
| `GET` | `/api/session/context` | Inspect session context |
| `GET` | `/api/context` | Inspect session context alias |
| `GET` | `/api/session/context-status` | Read context status |
| `GET` | `/api/session/search` | Search session entries |
| `GET` | `/api/archive/dreams` | List archive-ready Dream cards |
| `GET` | `/api/archive/dreams/{agentId}/{entryId}` | Read an archive-ready Dream document |
| `GET` | `/api/archive/continuity/cards` | List current warm continuity cards for Archive inspection |
| `GET` | `/api/archive/continuity/cards/{agentId}/{cardId}` | Read a current continuity card and its Signal history |
| `GET` | `/api/archive/runs` | List archived runtime proof packets |
| `GET` | `/api/archive/runs/{runId}` | Read one archived runtime proof packet |
| `GET` | `/api/sessions/{sessionId}/export` | Export canonical raw session records |
| `GET` | `/api/archive/calendar` | List retained Archive days in the requested timezone |

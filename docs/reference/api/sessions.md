# Sessions and Archive


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


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

Reset and archive retain original evidence. Current reset captures a handoff, blocks new admissions during the boundary change, supersedes active session runs, and resets the stored conversation. The response can include `supersededRuns`; Archive summary generation is queued separately, so reset success is not a summary-completion receipt. Historical public 2026.10.19 predates this reset coordination. The former Albdruck purge endpoint is retired. The current retention preview/run controls manage traces, not individual conversation purge; see [retention and deletion](../../concepts/conversation-history.md#retention-and-deletion). Do not conflate hiding a session with deleting retained content.
## Context, search and continuity

`/api/session/context` and `/api/context` inspect context; `/api/session/context-status` includes current limits and live usage where available. Defaults use session `default`. These responses may expose private conversational material.

Session search accepts `q`, `role`, `limit` (default 50), `sourceId`, `since`, `until`, `agentId`, `sessionId`, `scope` and `archived`. Scope defaults to `session` when an agent/session/source selector is present, otherwise `burrow`. Explicit `scope=session` targets one selected session; broader search gathers enabled-agent evidence and includes archives unless `archived=false`.

### Agent recall is a separate tool contract

The explicit `session_search` agent tool searches only its current agent's historical sessions, including reset snapshots. It is not equivalent to passing `scope=agent_sessions` to the operator HTTP route: any non-`session` HTTP scope takes the broader enabled-agent search branch. Use explicit `scope=session`, `agentId` and `sessionId` when an operator query must stay within one session.

Tool results include source references, dates and neighboring dialogue. The tool supports `since`, `until`, `sourceId`, `sourceSessionId`, `neighborCount` and `limit`. To expand an original, pass the returned `sourceRef.entryId` as `sourceId` with its session ID as `sourceSessionId`; the result then includes `original`. Default tool result limit is 12; neighbor radius defaults to one and is capped at three. Original source content remains distinct from a handoff or compression recap.

No historical search is automatically run before a turn: the compatibility recall helper reports `automatic_recall_disabled`, and the support builder supplies no automatic session recall. Ask the agent to retrieve previous discussion explicitly, or use Archive/session search yourself.
Continuity scope is an operator-selected namespace. GET/DELETE use query fields; PUT accepts agent/session plus `continuityScope` (or `scope`). It is not a path, cwd or execution-target selector. Handoff and handoff-candidate endpoints persist continuity evidence; they do not grant authority to change agent identity.
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
See [Archive UI](../../concepts/interface.md)

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

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/ui/session-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/session-routes.mjs)
- [backend/src/postgres-session-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-session-store.mjs)

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

Reset and archive retain original evidence. Current reset captures a handoff, blocks new admissions during the boundary change, supersedes active session runs, and resets the stored conversation. Current cancellation propagates into PostgreSQL work, with rollback/drain before client release and generation fencing against late writes; do not interpret a cancellation acknowledgement as immediate quiescence. The response can include `supersededRuns`; Archive summary generation is queued separately, so reset success is not a summary-completion receipt. Historical public 2026.10.19 predates this reset coordination. The former Albdruck purge endpoint is retired. The current retention preview/run controls manage traces, not individual conversation purge; see [retention and deletion](../../concepts/conversation-history.md#retention-and-deletion). Do not conflate hiding a session with deleting retained content.
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

## 28 October development delta

Changed behavior above was checked statically against Backend `a04acb16b0eab2a910c3ef0fb452622df81a05cb` on **2026-10-28**. This is not a live provider, database or collector test, nor a revalidation of unchanged historical sections. See [source coverage](../../project/source-map.md).

## Current Archive groups and workflow events

| Method/path | Contract |
|---|---|
| `GET /api/archive/dreams/groups` | Optional `q`, `date`, `agentId`, `timezone`, `limit` (default 200, maximum 500), `cursor`; complete agent/local-day group summaries, including disabled agents and receipt-only days. |
| `GET /api/archive/dreams/groups/:agentId/:day` | Same `timezone` as listing; retained diaries, recorded phase attempts and unattributed cycle failures/progress for the selected group. |
| `GET /api/archive/workflow-events` | Same optional list filters; default limit 100, maximum 500. Retained completion snapshots ordered by acceptance `createdAt` and ID descending. |

Dream groups are ordered by day/agent descending. Search covers complete retained narratives and sanitized attempt/error fields, returning the whole matching group. Diary creation and cycle start determine local-day membership; phase timestamps are not inferred from cycle timing. Only an explicit receipt diary ID is a link, and the referenced diary can be outside the group or no longer retained. Legacy individual `/api/archive/dreams` routes remain available.

Workflow records include watch, repository/workflow, attempt/SHA/conclusion, agent/session, instruction, handling status, chat-run identity, result/error and timing. Returned results are boundary-redacted; `ownerId` and `traceDir` are omitted. Retained instruction/error prose still requires review before sharing. These are ordinary authenticated Archive reads, not changes to webhook acceptance or evidence that handling succeeded.

Use a fresh first page after changing filters/timezone. Invalid dates, zones, cursors or limits return the normal 400 errors. Source reviewed against Core `bea2171508d1821440ed5c554a688768848699c9` on 30 October 2026.

## Current Chat Archive read contract

Source reviewed on **31 October 2026** against Core `8275b6bedf1fcd969fb5289cf0b673a80ddc8146` and UI `f48a29337abccdfeb8c34895d043d6be4110b1fb`; no live API or database test was run.

- Session calendar/date queries include retained visible message occurrence days across live/compacted history and each reset's own generation window, alongside catalog update/reset-creation dates. Unknown occurrence timestamps are not substituted with storage/reset times.
- Date-selected session rows can return `matchedDate` in the requested timezone. Respect that authoritative match even when the catalog timestamp differs. Reset cards include proven `sourceSessionId` and actual reset `archivedAt`; `chatTurnCount` can be null when only an inherited tail count was available.
- `GET /api/archive/sessions/{agentId}/{sessionId}` reads canonical pages directly from PostgreSQL. `limit` defaults to 100 and is clamped to 1–500. `session.turns` is chronological within the newest-first page window. Optional inclusive `from`/`to` bounds preserve microseconds; bare dates mean midnight UTC. The UI supplies the selected browser-local day's inclusive bounds on every page, including 23/25-hour DST days.
- Signed `nextCursor` values go in `before` and bind agent/session, the exact raw bounds and retained source revision. Repeat bounds unchanged. A mutation, rewrite, restart or cursor-format upgrade can invalidate paging with `400 archive_cursor_invalid`; begin again at the newest page. Do not rely on older append-tolerant cursor or 409-stale behavior for this reader.
- `hasMore`, `nextCursor` and `historyStatus: complete` describe retained results. A catalog-date match can legitimately have no messages on that date. They do not recover deleted originals or replace canonical full export APIs.
- Interactive Archive GETs own a **15-second total budget**, including queue/pool wait. Disconnect or timeout cancels owned read work; a database statement/lock timeout returns `504 { "ok": false, "error": "archive_query_timeout" }`, not an empty collection. Durable runs/jobs are not canceled by page navigation. A failed isolated reader returns `503 archive_reader_unavailable` rather than fabricated history.

Chat calendar discovery uses one isolated reader lane; Chat list/detail and Proof share another. Each uses one connection to the same canonical database. A slow calendar therefore does not occupy the foreground lane, but queued reads retain their original deadline. Other Archive collections keep their existing service paths. Large retained transcripts and cold/backfilling discovery can still be expensive; isolation is not a promise of constant-time reads.

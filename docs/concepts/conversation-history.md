# Conversation history and archives

A conversation is scoped by agent and session. PostgreSQL stores active entries, immutable archive snapshots and session metadata. Explicit session search and Dream can resolve evidence through these persisted originals. Brains stores saved memories separately.

## Original-message storage

`conversation_entries` stores the active transcript. `conversation_archives` identifies archived generations, and `conversation_archive_entries` stores their native message occurrences. `conversation_original_rows` is a read-only union view over live and archived payloads. It is not another independent copy of conversation authority. [Native archives](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs), [current original view](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

Original payload columns use PostgreSQL **`json`**, not `jsonb`. That preserves lexical JSON, including escaped NUL characters and lone surrogate escapes that a `jsonb` conversion would reject. Message decoding for original resolution happens in JavaScript; relational metadata can still use `jsonb`. [Lossless migration](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs), [original reads](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

Live entries have session-scoped unique entry IDs and idempotency keys. Append locks the session row before allocating sequence values, preserving commit-order pagination. Bigint sequence cursors are represented as decimal strings rather than JavaScript numbers. Retrying a matching append returns the existing entry with `idempotent: true`. [Append semantics](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

## Operations and their effects

| Operation | Active transcript | Historical originals |
|---|---|---|
| Append | Adds an entry, or reuses an idempotent append | Preserved |
| Compact | Replaces active entries with a summary and retained material | Saves the full previous generation first |
| Reset | Clears the active transcript and advances reset generation | Saves a `reset` archive first |
| Archive session | Changes archive metadata | Preserved |
| Rename session | Moves session identity transactionally | Payloads and archive records preserved |
| Fork session | Copies a bounded active tail to a new target | Original source session remains unchanged |
| Purge/delete | Deletes eligible conversation authority | Cascades to its native archive rows; derivative cleanup has separate limits |

Compaction and reset update generation counters transactionally. Fork defaults to the latest 200 active entries, reserves the target and rejects an existing target or the source itself. [Compaction/reset](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs), [fork/rename/archive](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

!!! warning "Reset preserves history"
    Reset starts a fresh active transcript but retains earlier original messages in reset archives. Explicit agent-history search and Dream can still use those originals. Reset is not an erasure operation.

## Compression and prompt context

Compression manages a model's working context, while archives preserve conversation history. The default trigger is 75% of known context capacity, with a preferred recent tail of 48 entries capped at 24,000 estimated tokens. Leaf and summary targets are 20,000 and 6,000 tokens, with at most four sweeps and a 120-second deadline. This module estimates tokens at four characters per token. [Compression planning](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/context-compression.mjs)

The preferred tail alone does not trigger compression when capacity is known. Under pressure the tail can shrink, but the newest entry is preserved. Deterministic summaries are explicitly lossy, non-authoritative navigation recaps. They disclose that older prose may be omitted and direct the agent to `session_search` for exact history; explicit lifecycle state is rendered separately. Canonical tool calls/results and context-state records are preserved in active material even when surrounding chat is condensed. [Session compression](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/session-compression.mjs)

The stored compaction summary is a debug entry marked `entersPrompt: false`; it should not be mistaken for an original person-facing message. The runtime controls how compressed context is assembled. See [Runtime architecture](../architecture/runtime.md). [Compaction write](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

## Search and recall

BURROW has several related search boundaries:

| Path | Scope |
|---|---|
| Normal session evidence search | Active and compacted history since the latest reset |
| Explicit agent-session evidence search | Agent history including reset archives, with provenance labels |
| Internal original-history store | Cursor-paged originals; the former Albdruck history HTTP route is retired |
| Operator cross-agent search | Operator inspection; marked `entersPrompt: false` |

PostgreSQL errors or empty results do not trigger a hidden fallback to workspace JSONL. Ordinary session search ranks exact phrases first, then ASCII token coverage; multi-term queries require at least two matching tokens. Results are bounded to 200 with excerpts up to 240 characters. Agent recall deduplicates original entry identities and can include recent handoffs. [Search contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/session-search.mjs), [agent/operator search](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/session-search.mjs)

Historical retrieval is explicit. `session_search` searches the active agent's own sessions, including reset snapshots, with dates, original source references and neighboring dialogue. It accepts `since`/`until`; use a result's `sourceRef.entryId` as `sourceId` and `sourceRef.sessionId` as `sourceSessionId` to expand an original. The default neighbor radius is one, capped at three. The current compatibility recall helper returns `automatic_recall_disabled`; the pre-turn support builder supplies no automatic session-recall or run-evidence context. Saved Brain memories likewise require explicit tools. [Search/expansion](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/session-search.mjs), [Tool schema](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-proposal.mjs), [Recall boundary](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/session-recall.mjs), [Support context](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/runtime-support-context.mjs)

Original-history cursors bind the scope, agent and query as well as the position. The store scans candidate pages under a repeatable-read snapshot, so an early relevance cutoff does not silently omit later matches. SQL's conservative ASCII-run candidate indexes are an optimization; the JavaScript matcher is the final matching authority. Ambiguous or undecodable source fields retain a fallback search path. [Original-history paging](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs), [candidate extraction](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

Original resolution prefers the live entry and then a retained archived occurrence. Dream's original-entry enumeration deduplicates repeated live/archive identities and returns chronological evidence. See [Dream cycles](dreams.md) and [Brains](memory.md#brains-explicit-saved-memories). [Original resolution and enumeration](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

## Transcript export and archive display

Transcript export uses one database snapshot. It includes compacted predecessor generations since the latest reset plus active entries; reset archives remain separately retrievable. An export of the current conversation is therefore different from exporting every retained historical generation. [Transcript export](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs), [archive reads](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

Archive cursors bind collection/filter scope and use descending timestamp plus identity. Calendar availability is calculated from retained rows; day filters use the supplied timezone. Page size is capped at 500. Human-readable archive summaries are model-generated and bounded; a summary is not a verification receipt. [Archive pagination](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/archive-pagination.mjs), [archive summary](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/archive-summary.mjs)

### Evidence and completion

Archive proof combines terminal receipts, canonical tool calls/results and trace evidence, correlated by call IDs to avoid double reporting. Without a terminal receipt, an answer is `unverified`; without an answer it is `incomplete`. Assistant prose alone does not establish success. Child verification uses typed results such as `passed`, `failed`, `failed_expected` and `not_run`. [Proof classification](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/archive-proof.mjs), [evidence aggregation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/archive-proof.mjs)

Proof details are bounded and redacted. Context receipts distinguish current from retained attachments and record compression outcomes. Review those receipts when investigating whether a claimed action had durable effects. [Context and attachment proof](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/archive-proof.mjs)

## Retention and deletion

Retention has several independent owners:

| Data | Default policy | Important behavior |
|---|---|---|
| Conversation and operational history | Legacy conversation/operational age fields default to no limit | Review the current retention preview and selected policy before cleanup |
| Brain saved memories | No TTL | Revision-checked soft deletion; separate from original history and legacy migration snapshots |
| Working records and rolling cards | 90 days | Pinned working records bypass expiry; expired-card read filtering is distinct from physical deletion |
| Handoffs | 14 days | Separate store and expiry |
| Dream preloads | 7 days | Derived bounded records |
| Attachment bytes | 30 days by file modification time | `null` disables attachment expiry |
| Generated-artifact bytes | No automatic TTL in the generated-artifact store | Do not apply the attachment default to original generated files |
| Run traces | Disabled, no age/byte limit | Enabling requires at least one limit |

[Legacy internal retention policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-albdruck-store.mjs), [working-memory policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/working-memory-retention-settings.mjs), [handoff expiry](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-continuity-handoff-store.mjs), [Dream preloads](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/dream-cycle-runner.mjs), [attachments](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/attachment-store.mjs), [generated artifacts](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/generated-artifact-store.mjs), [trace policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention-settings.mjs)

When a session policy is explicitly enabled, fallback kind ages are main 60 days, task 30 days and subagent 7 days. The background retention scheduler does not enable session pruning merely because these fallbacks exist. **The CLI is different:** `retention` supplies environment-derived kind ages of 60/30/7 by default, so its confirmed invocation can prune eligible sessions even when persisted UI retention is disabled. Preview that CLI's full targets separately. [CLI policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/cli-authority-commands.mjs), [environment defaults](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs). Current/main/default sessions and `running` or `finalizing` sessions are protected. Task sessions require an owning board task with `done` or `cancelled` status and a terminal timestamp; other non-main sessions require completion evidence. The planner accepts both nested and flattened metadata. It rechecks eligibility before deletion, while the store independently guards active/current sessions and native continuity state. These are source-level safeguards, not a claim that cleanup was tested on your deployment. [Retention eligibility and recheck](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention.mjs), [Store deletion guard](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-session-store.mjs)

Trace cleanup plans are dry-run by default; deletion requires explicit confirmation. The implementation uses a cross-process filesystem lease, containment/signature checks and a current-main recheck. Age selection precedes oldest-first allocated-byte quota selection. Its cadence defaults to 1,440 minutes. Independent cleanup can still run when trace retention or Dream is disabled. [Trace cleanup](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention.mjs), [cleanup execution](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention.mjs), [scheduler](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention-scheduler.mjs)

!!! warning "Deletion is not a complete-erasure guarantee"
    The old `/api/albdruck/purge-conversation` route is no longer mounted. Internal legacy purge code is not a supported HTTP workflow. Brains soft deletion, session retention, attachment cleanup, migration snapshots and external backups are distinct; no single operation here establishes erasure of every derivative or copy. The current retention preview/run API manages traces; it does not restore per-conversation purge. Inspect the appropriate cleanup targets before confirming any deletion. [Mounted routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs), [Current cleanup routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/general-settings-routes.mjs)

Use the operator [API reference](../reference/api.md) and [procedures](../operations/procedures.md) rather than direct SQL deletion. Review [Backup and recovery](../operations/backup-recovery.md) before applying irreversible retention changes.

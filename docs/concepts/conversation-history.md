# Conversation history and archives


!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current public-release user guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.

A conversation is scoped by agent and session. PostgreSQL stores active entries, immutable archive snapshots and session metadata. Explicit session search and Dream can resolve evidence through these persisted originals. Brains stores saved memories separately.

## Original-message storage

`conversation_entries` stores the active transcript. `conversation_archives` identifies archived generations, and `conversation_archive_entries` stores their native message occurrences. `conversation_original_rows` is a read-only union view over live and archived payloads. It is not another independent copy of conversation authority.
Original payload columns use PostgreSQL **`json`**, not `jsonb`. That preserves lexical JSON, including escaped NUL characters and lone surrogate escapes that a `jsonb` conversion would reject. Message decoding for original resolution happens in JavaScript; relational metadata can still use `jsonb`.
Live entries have session-scoped unique entry IDs and idempotency keys. Append locks the session row before allocating sequence values, preserving commit-order pagination. Bigint sequence cursors are represented as decimal strings rather than JavaScript numbers. Retrying a matching append returns the existing entry with `idempotent: true`.

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

Compaction and reset update generation counters transactionally. Fork defaults to the latest 200 active entries, reserves the target and rejects an existing target or the source itself.

!!! warning "Reset preserves history"
    Reset starts a fresh active transcript but retains earlier original messages in reset archives. Explicit agent-history search and Dream can still use those originals. Reset is not an erasure operation.

## Compression and prompt context

Compression manages a model's working context, while archives preserve conversation history. The default trigger is 75% of known context capacity, with a preferred recent tail of 48 entries capped at 24,000 estimated tokens. Leaf and summary targets are 20,000 and 6,000 tokens, with at most four sweeps and a 120-second deadline. This module estimates tokens at four characters per token.

The preferred tail alone does not trigger compression when capacity is known. Under pressure the tail can shrink, but the newest entry is preserved. Deterministic summaries are explicitly lossy, non-authoritative navigation recaps. They disclose that older prose may be omitted and direct the agent to `session_search` for exact history; explicit lifecycle state is rendered separately. Canonical tool calls/results and context-state records are preserved in active material even when surrounding chat is condensed.

The stored compaction summary is a debug entry marked `entersPrompt: false`; it should not be mistaken for an original person-facing message. The runtime controls how compressed context is assembled. See [Runtime architecture](../architecture/runtime.md).

### Newer Core: one wrapper and whole source items

The newer compression implementation reviewed on 21 October rebuilds previously covered items from available original entries and combines them with newly covered messages. It deduplicates stable source entry IDs and renders one handoff wrapper. When space is tight, it prefers newer complete items and omits whole items rather than joining arbitrary character slices.

This remains a lossy navigation recap. A single item larger than the available budget can be omitted completely; preservation of every correction or instruction is not guaranteed. The headings do not make this an LLM-written semantic summary. Use `session_search` for exact wording.

Covered IDs support rebuilding on a subsequent compression cycle when originals are available. This is not a background repair of every malformed stored summary. Missing originals cannot be reconstructed from a source ID alone. Keep archives when exact historical recovery matters.

[Release status](../project/release-status.md) distinguishes this path from the public 2026.10.19 implementation.

## Search and recall

BURROW has several related search boundaries:

| Path | Scope |
|---|---|
| Normal session evidence search | Active and compacted history since the latest reset |
| Explicit agent-session evidence search | Agent history including reset archives, with provenance labels |
| Internal original-history store | Cursor-paged originals; the former Albdruck history HTTP route is retired |
| Operator cross-agent search | Operator inspection; marked `entersPrompt: false` |

PostgreSQL errors or empty results do not trigger a hidden fallback to workspace JSONL. Ordinary session search ranks exact phrases first, then ASCII token coverage; multi-term queries require at least two matching tokens. Results are bounded to 200 with excerpts up to 240 characters. Agent recall deduplicates original entry identities and can include recent handoffs.
Historical retrieval is explicit. `session_search` searches the active agent's own sessions, including reset snapshots, with dates, original source references and neighboring dialogue. It accepts `since`/`until`; use a result's `sourceRef.entryId` as `sourceId` and `sourceRef.sessionId` as `sourceSessionId` to expand an original. The default neighbor radius is one, capped at three. The current compatibility recall helper returns `automatic_recall_disabled`; the pre-turn support builder supplies no automatic session-recall or run-evidence context. Saved Brain memories likewise require explicit tools.
Original-history cursors bind the scope, agent and query as well as the position. The store scans candidate pages under a repeatable-read snapshot, so an early relevance cutoff does not silently omit later matches. SQL's conservative ASCII-run candidate indexes are an optimization; the JavaScript matcher is the final matching authority. Ambiguous or undecodable source fields retain a fallback search path.
Original resolution prefers the live entry and then a retained archived occurrence. Dream's original-entry enumeration deduplicates repeated live/archive identities and returns chronological evidence. See [Dream cycles](dreams.md) and [Brains](memory.md#brains-explicit-saved-memories).

## Transcript export and archive display

Transcript export uses one database snapshot. It includes compacted predecessor generations since the latest reset plus active entries; reset archives remain separately retrievable. An export of the current conversation is therefore different from exporting every retained historical generation.
Archive cursors bind collection/filter scope and use descending timestamp plus identity. Calendar availability is calculated from retained rows; day filters use the supplied timezone. Page size is capped at 500. Human-readable archive summaries are model-generated and bounded; a summary is not a verification receipt.
### Evidence and completion

Archive proof combines terminal receipts, canonical tool calls/results and trace evidence, correlated by call IDs to avoid double reporting. Without a terminal receipt, an answer is `unverified`; without an answer it is `incomplete`. Assistant prose alone does not establish success. Child verification uses typed results such as `passed`, `failed`, `failed_expected` and `not_run`.
Proof details are bounded and redacted. Context receipts distinguish current from retained attachments and record compression outcomes. Review those receipts when investigating whether a claimed action had durable effects.

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
When a session policy is explicitly enabled, fallback kind ages are main 60 days, task 30 days and subagent 7 days. The background retention scheduler does not enable session pruning merely because these fallbacks exist. **The CLI is different:** `retention` supplies environment-derived kind ages of 60/30/7 by default, so its confirmed invocation can prune eligible sessions even when persisted UI retention is disabled. Preview that CLI's full targets separately. Current/main/default sessions and `running` or `finalizing` sessions are protected. Task sessions require an owning board task with `done` or `cancelled` status and a terminal timestamp; other non-main sessions require completion evidence. The planner accepts both nested and flattened metadata. It rechecks eligibility before deletion, while the store independently guards active/current sessions and native continuity state. These are source-level safeguards, not a claim that cleanup was tested on your deployment.
Trace cleanup plans are dry-run by default; deletion requires explicit confirmation. The implementation uses a cross-process filesystem lease, containment/signature checks and a current-main recheck. Age selection precedes oldest-first allocated-byte quota selection. Its cadence defaults to 1,440 minutes. Independent cleanup can still run when trace retention or Dream is disabled.

!!! warning "Deletion is not a complete-erasure guarantee"
    The old `/api/albdruck/purge-conversation` route is no longer mounted. Internal legacy purge code is not a supported HTTP workflow. Brains soft deletion, session retention, attachment cleanup, migration snapshots and external backups are distinct; no single operation here establishes erasure of every derivative or copy. The current retention preview/run API manages traces; it does not restore per-conversation purge. Inspect the appropriate cleanup targets before confirming any deletion.

Use the operator [API reference](../reference/api.md) and [procedures](../operations/procedures.md) rather than direct SQL deletion. Review [Backup and recovery](../operations/backup-recovery.md) before applying irreversible retention changes.

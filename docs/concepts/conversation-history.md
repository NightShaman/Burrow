# Conversation history and archives

A conversation is scoped by agent and session. PostgreSQL stores active entries, immutable archive snapshots and session metadata. Search, Dream and Albdruck resolve evidence through these persisted originals.

## Original-message storage

`conversation_entries` stores the active transcript. `conversation_archives` identifies archived generations, and `conversation_archive_entries` stores their native message occurrences. `conversation_original_rows` is a read-only union view over live and archived payloads. It is not another independent copy of conversation authority. [Native archives](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L270-L299), [current original view](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L365-L422)

Original payload columns use PostgreSQL **`json`**, not `jsonb`. That preserves lexical JSON, including escaped NUL characters and lone surrogate escapes that a `jsonb` conversion would reject. Message decoding for original resolution happens in JavaScript; relational metadata can still use `jsonb`. [Lossless migration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L51-L59), [original reads](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L546-L658)

Live entries have session-scoped unique entry IDs and idempotency keys. Append locks the session row before allocating sequence values, preserving commit-order pagination. Bigint sequence cursors are represented as decimal strings rather than JavaScript numbers. Retrying a matching append returns the existing entry with `idempotent: true`. [Append semantics](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L660-L713)

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

Compaction and reset update generation counters transactionally. Fork defaults to the latest 200 active entries, reserves the target and rejects an existing target or the source itself. [Compaction/reset](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L833-L882), [fork/rename/archive](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L884-L930)

!!! warning "Reset preserves history"
    Reset starts a fresh active transcript but retains earlier original messages in reset archives. Explicit agent-history search and Dream can still use those originals. Reset is not an erasure operation.

## Compression and prompt context

Compression manages a model's working context, while archives preserve conversation history. The default trigger is 75% of known context capacity, with a preferred recent tail of 48 entries capped at 24,000 estimated tokens. Leaf and summary targets are 20,000 and 6,000 tokens, with at most four sweeps and a 120-second deadline. This module estimates tokens at four characters per token. [Compression planning](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/context-compression.mjs#L57-L174)

The preferred tail alone does not trigger compression when capacity is known. Under pressure the tail can shrink, but the newest entry is preserved. Deterministic summaries are explicitly non-authoritative and retain the latest request, goals, outcomes and typed execution/context state. Canonical tool calls/results and context-state records are preserved in active material even when surrounding chat is condensed. [Session compression](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/session-compression.mjs#L49-L185)

The stored compaction summary is a debug entry marked `entersPrompt: false`; it should not be mistaken for an original person-facing message. The runtime controls how compressed context is assembled. See [Runtime architecture](../architecture/runtime.md). [Compaction write](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L833-L857)

## Search and recall

BURROW has several related search boundaries:

| Path | Scope |
|---|---|
| Normal session evidence search | Active and compacted history since the latest reset |
| Explicit agent-session evidence search | Agent history including reset archives, with provenance labels |
| Original-history search | Cursor-paged agent or explicit global originals |
| Operator cross-agent search | Operator inspection; marked `entersPrompt: false` |

PostgreSQL errors or empty results do not trigger a hidden fallback to workspace JSONL. Ordinary session search ranks exact phrases first, then ASCII token coverage; multi-term queries require at least two matching tokens. Results are bounded to 200 with excerpts up to 240 characters. Agent recall deduplicates entries and content and can include recent handoffs. [Search contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/session-search.mjs#L4-L149), [agent/operator search](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/session-search.mjs#L201-L379)

Original-history cursors bind the scope, agent and query as well as the position. The store scans candidate pages under a repeatable-read snapshot, so an early relevance cutoff does not silently omit later matches. SQL's conservative ASCII-run candidate indexes are an optimization; the JavaScript matcher is the final matching authority. Ambiguous or undecodable source fields retain a fallback search path. [Original-history paging](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L546-L616), [candidate extraction](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L425-L499)

Original resolution prefers the live entry and then a retained archived occurrence. Dream's original-entry enumeration deduplicates repeated live/archive identities and returns chronological evidence. See [Dream cycles](dreams.md) and [Albdruck](memory.md#albdruck-knowledge). [Original resolution and enumeration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L619-L658)

## Transcript export and archive display

Transcript export uses one database snapshot. It includes compacted predecessor generations since the latest reset plus active entries; reset archives remain separately retrievable. An export of the current conversation is therefore different from exporting every retained historical generation. [Transcript export](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L933-L946), [archive reads](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L775-L793)

Archive cursors bind collection/filter scope and use descending timestamp plus identity. Calendar availability is calculated from retained rows; day filters use the supplied timezone. Page size is capped at 500. Human-readable archive summaries are model-generated and bounded; a summary is not a verification receipt. [Archive pagination](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/archive-pagination.mjs#L6-L47), [archive summary](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/archive-summary.mjs#L7-L29)

### Evidence and completion

Archive proof combines terminal receipts, canonical tool calls/results and trace evidence, correlated by call IDs to avoid double reporting. Without a terminal receipt, an answer is `unverified`; without an answer it is `incomplete`. Assistant prose alone does not establish success. Child verification uses typed results such as `passed`, `failed`, `failed_expected` and `not_run`. [Proof classification](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/archive-proof.mjs#L16-L22), [evidence aggregation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/archive-proof.mjs#L212-L318)

Proof details are bounded and redacted. Context receipts distinguish current from retained attachments and record compression outcomes. Review those receipts when investigating whether a claimed action had durable effects. [Context and attachment proof](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/archive-proof.mjs#L373-L507)

## Retention and deletion

Retention has several independent owners:

| Data | Default policy | Important behavior |
|---|---|---|
| Conversation and operational history | No age limit in Albdruck retention | Session pruning requires an explicitly enabled conversation/kind policy |
| Knowledge, evidence and revisions | No age limit | Knowledge pruning removes records; evidence pruning clears excerpts but retains references; revision pruning removes audit rows |
| Working records and rolling cards | 90 days | Pinned working records bypass expiry; expired-card read filtering is distinct from physical deletion |
| Handoffs | 14 days | Separate store and expiry |
| Dream preloads | 7 days | Derived bounded records |
| Attachment bytes | 30 days by file modification time | `null` disables attachment expiry |
| Generated-artifact bytes | No automatic TTL in the generated-artifact store | Do not apply the attachment default to original generated files |
| Run traces | Disabled, no age/byte limit | Enabling requires at least one limit |

[Albdruck policy](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L30-L118), [working-memory policy](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/working-memory-retention-settings.mjs#L3-L25), [handoff expiry](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-continuity-handoff-store.mjs#L3-L6), [Dream preloads](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/dream-cycle-runner.mjs#L761-L766), [attachments](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/attachment-store.mjs#L4-L40), [generated artifacts](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/generated-artifact-store.mjs#L55-L120), [trace policy](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention-settings.mjs#L2-L24)

When a session policy is explicitly enabled, fallback kind ages are main 60 days, task 30 days and subagent 7 days. The UI/Albdruck scheduler does not enable session pruning merely because these fallbacks exist. **The CLI is different:** `retention` supplies environment-derived kind ages of 60/30/7 by default, so its confirmed invocation can prune eligible sessions even when persisted UI retention is disabled. Preview that CLI's full targets separately. [CLI policy](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/cli-authority-commands.mjs#L21-L27), [environment defaults](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L231-L245). Current/main/default sessions and `running` or `finalizing` sessions are protected. The planner is intended to require a terminal board task for task sessions and completion evidence for other non-main sessions, but the metadata-shape mismatch below prevents relying on those gates. The store rechecks protected state under its deletion lock, including a native continuity head in `running`/`finalizing` or a running recovery queue. [Retention eligibility](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention.mjs#L93-L160), [deletion guard](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-session-store.mjs#L520-L545)

!!! warning "Session-retention eligibility mismatch"
    The current PostgreSQL session list flattens metadata, while the planner reads `record.metadata`. Task/subagent sessions can therefore be misclassified as main, bypassing the intended board-status/completion checks. A read-only injected-store preview reproduces this behavior. Avoid confirmed session cleanup until this boundary is corrected and validated. Active/current-session deletion guards remain separate protections. See [Known limitations](../project/known-limitations.md#session-retention-has-a-metadata-shape-mismatch).

Trace cleanup plans are dry-run by default; deletion requires explicit confirmation. The implementation uses a cross-process filesystem lease, containment/signature checks and a current-main recheck. Age selection precedes oldest-first allocated-byte quota selection. Its cadence defaults to 1,440 minutes. Independent cleanup can still run when trace retention or Dream is disabled. [Trace cleanup](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention.mjs#L21-L91), [cleanup execution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention.mjs#L168-L269), [scheduler](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention-scheduler.mjs#L3-L49)

!!! warning "Purge is not a complete-erasure guarantee"
    The explicit Albdruck conversation-purge path clears linked evidence/revisions, orphaned knowledge, several continuity records, matching native Dream ledger/preload/scope-review entries and conversation authority. Current/active sessions remain protected. The implementation does not establish complete erasure of every possible derived cache, filesystem copy or backup. Review the affected stores before making a deletion guarantee. [Purge implementation](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-albdruck-store.mjs#L65-L95)

Use the operator [API reference](../reference/api.md) and [procedures](../operations/procedures.md) rather than direct SQL deletion. Review [Backup and recovery](../operations/backup-recovery.md) before applying irreversible retention changes.

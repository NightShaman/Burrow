# Memory and continuity

BURROW separates original conversation evidence, editable agent profiles, operational working memory and derived knowledge. These have different scopes, lifetimes and routes into model context. Understanding those boundaries helps explain both recall and retention.

## Memory layers

| Layer | Purpose | Scope and use |
|---|---|---|
| Original conversation history | Recover what was actually said | Agent/session originals, including retained archive generations |
| Profile documents | Identity, behavior, preferences and compact DreamMemory | Six PostgreSQL-backed documents per agent |
| Working memory | Decisions, findings, blockers, handoffs and tasks | Agent plus explicit continuity scope; explicit search/write tools |
| Tiddle rolling cards | Recurring topics and cross-session continuity | Scoped cards; explicit rolling search |
| Session handoff | Compact goal, outcome and evidence pointers | Agent/session-local recall metadata |
| Albdruck | Evidence-backed derived knowledge | Agent or explicitly global scope, with evidence and revision records |
| Dream diary | Operator-facing reflection | Separate narrative history; never runtime prompt authority |

Originals remain the evidence authority. A memory record, excerpt or summary can help locate and interpret evidence, but it does not turn an assistant claim into verified fact. See [Conversation history](conversation-history.md) and [Dream cycles](dreams.md).

## Profiles and preferences

Every agent has six profile kinds: `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS` and `DREAM_MEMORY`. Each stores Markdown in PostgreSQL and is bounded to 48,000 characters. References beginning `postgres:agent_profile_documents/` are virtual file-like references, not physical Markdown files to edit on disk. Complete profile replacement requires all six documents. [Profile contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/agent-profile-store.mjs#L2-L47), [profile store](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L46-L110)

`PREFERENCES` holds learned or operator-edited behavioral preferences. Accepted automatic changes commit the document, learning state and audit metadata atomically. `DREAM_MEMORY` is a compact, human-editable, semi-durable summary produced by [Dream](dreams.md); mutable facts should be checked against current evidence. Profile roles and prompt assembly are covered in [Agents and minions](agents-minions.md).

## Explicit scope and recall

The runtime/operator selects the continuity scope. A model can select within its current scope but cannot invent a scope from a path or chat prose. A tool request with a different project value fails with `continuity_scope_mismatch`; missing scope also fails closed. [Tool scope checks](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/memory-tool-executor.mjs#L7-L69)

| Tool | Contract |
|---|---|
| `memory_working_search` | Search operational records in the current agent/scope |
| `memory_working_write` | Record operational evidence using runtime-owned agent/session/conversation scope |
| `memory_rolling_search` | Search rolling cards; returns `owner: rolling_continuity` and `entersPrompt: false` |
| `session_read_handoff` | Read a recent local handoff |
| `session_write_handoff` | Write an explicit agent/session-local handoff |

These names describe memory executors; availability also depends on the runtime's [tool configuration and permissions](tools.md). [Memory executors](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/memory-tool-executor.mjs#L16-L96)

Ordinary working-continuity assembly deliberately returns no ambient working records or rolling cards. It also keeps handoffs as recall metadata rather than projecting them into active prompt rows. Explicit tool recall remains available; `entersPrompt: false` describes this ambient-continuity policy and does not mean that a requested tool result is invisible to the agent. [Prompt boundary](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/working-memory-continuity.mjs#L19-L70)

## Operational working memory

Records have a kind (`decision`, `finding`, `blocker`, `handoff` or `task`) and state (`active`, `resolved` or `superseded`). Titles allow 240 characters, content 6,000 characters and source-reference lists up to 12 entries. Records retain creation/update/expiry timestamps and optional pinning. [Record validation and schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-working-memory-store.mjs#L8-L94)

The default record TTL is **90 days**, configurable from 1 to 36,500 days. Pinned records bypass expiry filtering. Rewriting unchanged material preserves its existing expiry rather than extending it indefinitely. Search is bounded to ten results; listing is bounded to 100. [Retention settings](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/working-memory-retention-settings.mjs#L3-L25), [record lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-working-memory-store.mjs#L164-L255)

A memory item whose kind is `task` is operational evidence. Board task status and execution receipts have their own store and lifecycle; see [Workers and tasks](workers-tasks.md).

## Tiddle rolling continuity

Tiddle collects terminal-turn residue with bounded message excerpts and periodically proposes continuity cards. The terminal append is intentionally cheap: it stores residue without a model call or direct card mutation. The normal pass runs every **four hours**, considers the last **24 hours** of residue and tracks success separately per scope. A failed scope therefore does not require replaying already successful scopes. [Residue and pass selection](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-continuity.mjs#L7-L121)

Residue and history are native `tiddle_entries` rows with `tiddle_envelopes` retaining scheduling and envelope metadata. Residue appends prune older than the 24-hour cutoff and replace the same reference; history appends prune older than 180 days. The previous 240-residue count cap is removed. Due work uses an indexed `next_run_at` projection. These storage changes do not remove the bounded evidence excerpts or synthesis selection budget. [Native Tiddle store](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-tiddle-store.mjs#L1-L37), [due selection](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-persistence.mjs#L21-L35)

The default proposal is a no-op. One vivid exchange alone is not sufficient recurrence. Accepted updates target exact card identities and preserve evidence references. Behavioral corrections may become preference signals, but Tiddle does not directly rewrite agent profiles. Card changes, history and per-scope success commit atomically under an agent-scoped PostgreSQL advisory lock. [Proposal application](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/tiddle-continuity.mjs#L213-L271), [atomic persistence](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-persistence.mjs#L17-L38)

Cross-scope synthesis considers a 21-day window, requires at least two source cards across two scopes and checks referenced card identities. Its daily boundary is the first due pass on a different **UTC date**, rather than a separate local-time nightly cron. The scheduler checks every 60 seconds and starts with an immediate tick. [Synthesis](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/tiddle-continuity.mjs#L131-L199), [scheduler](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/tiddle-continuity.mjs#L315-L339)

Rolling cards use the persisted rolling TTL, **90 days by default**. Expired cards are filtered from reads; that is not a guarantee of immediate physical deletion. Relational scope and identity are `(agent_id, project, card_id)`, and card JSON preserves evidence and legacy metadata. [Rolling store](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-rolling-continuity-store.mjs#L1-L86)

!!! note "Status-field discrepancy"
    In this source version, `tiddleStatus.cardTtlDays` reports a hard-coded `30`, while writes use the persisted policy with a default of `90`. Use the retention setting as the write-policy authority. See [Known limitations](../project/known-limitations.md). [Status field](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-continuity.mjs#L289-L298), [write policy](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-persistence.mjs#L31-L38)

## Session handoffs

A handoff summarizes the current goal, result and evidence references. Runtime-generated handoffs skip trivial exchanges but can retain substantive planning even when no tool ran. The curator distinguishes an assistant's assertion from successful tool evidence. [Handoff builder](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/continuity-handoff-store.mjs#L16-L35), [curator](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/continuity-handoff-curator.mjs#L7-L43)

Handoffs default to **14 days**, with a 240-character title, 24,000-character body and at most eight source references. An explicit handoff cannot be overwritten by an automatic runtime handoff. Recent-handoff selection prioritizes explicit material, then the current session. Handoffs are recall aids, separate from the execution-owner protocol described in [Persistence architecture](../architecture/persistence.md#runtime-continuity-and-crash-recovery). [Handoff lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-continuity-handoff-store.mjs#L3-L109)

## Albdruck knowledge

Albdruck stores a normalized claim with optional rationale, alternatives, constraints and relationships. Each record has a canonical fingerprint, a scope, evidence references and revisions. Its states are `active`, `superseded` and `deleted`. [Knowledge contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L7-L55)

An original reference identifies `kind: conversation_entry`, `agentId`, `sessionId` and `entryId`. Writes resolve originals before and inside the transaction, check scope, and reject stale originals, changed fingerprints or inactive targets. Superseding a claim requires user-message evidence. Contradictory claims remain reviewable rather than silently replacing one another. Manual correction, supersession and deletion require a reason. [Evidence-checked writes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L144-L237)

Detail responses distinguish:

- `live_original`: the original conversation entry can still be resolved, including from retained archives
- `preserved_excerpt`: only the stored excerpt is available
- `unavailable`: neither source is available

The label `live_original` refers to resolvable original evidence, not solely to the current active transcript. An excerpt does not become original authority when the source disappears. [Evidence resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L213-L223), [original resolver](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L650-L658)

Recall uses PostgreSQL English lexical ranking over active claims and context; knowledge listing and original-history search are separate interfaces. Use [API reference](../reference/api.md) for operator endpoints. [Recall and listing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L119-L143)

## Retention is per store

Working records, rolling cards, handoffs, Dream preloads, knowledge, excerpts and original conversations have separate policies. Albdruck defaults do not expire knowledge, evidence or revisions; attachments default to 30 days. Evidence cleanup clears excerpts while retaining source references. A reset preserves archived originals, and an explicit purge should not be treated as a verified deletion of every possible derivative or external backup. [Albdruck retention](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L30-L118)

For deletion protections and exact distinctions, continue to [Conversation retention](conversation-history.md#retention-and-deletion). For recovery of memory together with its original evidence, use [Backup and recovery](../operations/backup-recovery.md).

# Memory and continuity

BURROW separates original conversation evidence, editable agent profiles, operational working memory and explicit saved memories. These have different scopes, lifetimes and routes into model context. Understanding those boundaries helps explain both recall and retention.

## Memory layers

| Layer | Purpose | Scope and use |
|---|---|---|
| Original conversation history | Recover what was actually said | Agent/session originals, including retained archive generations |
| Profile documents | Identity, behavior, preferences and compact DreamMemory | Six PostgreSQL-backed documents per agent |
| Working memory | Decisions, findings, blockers, handoffs and tasks | Agent plus explicit continuity scope; explicit search/write tools |
| Tiddle rolling cards | Recurring topics and cross-session continuity | Scoped cards; explicit rolling search |
| Session handoff | Compact goal, outcome and evidence pointers | Agent/session-local recall metadata |
| Brains | Explicit saved memories | One agent owner, revision-checked edits, no TTL or automatic preload |
| Dream diary | Operator-facing reflection | Separate narrative history; never runtime prompt authority |

Originals remain the evidence authority. A memory record, excerpt or summary can help locate and interpret evidence, but it does not turn an assistant claim into verified fact. See [Conversation history](conversation-history.md) and [Dream cycles](dreams.md).

## Profiles and preferences

Every agent has six profile kinds: `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS` and `DREAM_MEMORY`. Each stores Markdown in PostgreSQL and is bounded to 48,000 characters. References beginning `postgres:agent_profile_documents/` are virtual file-like references, not physical Markdown files to edit on disk. Complete profile replacement requires all six documents. [Profile contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/agent-profile-store.mjs), [profile store](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-profile-store.mjs)

`PREFERENCES` holds learned or operator-edited behavioral preferences. Accepted automatic changes commit the document, learning state and audit metadata atomically. `DREAM_MEMORY` is a compact, human-editable, semi-durable summary produced by [Dream](dreams.md); mutable facts should be checked against current evidence. Profile roles and prompt assembly are covered in [Agents and minions](agents-minions.md).

## Explicit scope and recall

The runtime/operator selects the continuity scope. A model can select within its current scope but cannot invent a scope from a path or chat prose. A tool request with a different project value fails with `continuity_scope_mismatch`; missing scope also fails closed. [Tool scope checks](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/memory-tool-executor.mjs)

| Tool | Contract |
|---|---|
| `memory_working_search` | Search operational records in the current agent/scope |
| `memory_working_write` | Record operational evidence using runtime-owned agent/session/conversation scope |
| `memory_rolling_search` | Search rolling cards; returns `owner: rolling_continuity` and `entersPrompt: false` |
| `session_read_handoff` | Read a recent local handoff |
| `session_write_handoff` | Write an explicit agent/session-local handoff |

These names describe memory executors; availability also depends on the runtime's [tool configuration and permissions](tools.md). [Memory executors](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/memory-tool-executor.mjs)

Ordinary working-continuity assembly deliberately returns no ambient working records or rolling cards. It also keeps handoffs as recall metadata rather than projecting them into active prompt rows. Explicit tool recall remains available; `entersPrompt: false` describes this ambient-continuity policy and does not mean that a requested tool result is invisible to the agent. [Prompt boundary](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/working-memory-continuity.mjs)

## Operational working memory

Records have a kind (`decision`, `finding`, `blocker`, `handoff` or `task`) and state (`active`, `resolved` or `superseded`). Titles allow 240 characters, content 6,000 characters and source-reference lists up to 12 entries. Records retain creation/update/expiry timestamps and optional pinning. [Record validation and schema](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-working-memory-store.mjs)

The default record TTL is **90 days**, configurable from 1 to 36,500 days. Pinned records bypass expiry filtering. Rewriting unchanged material preserves its existing expiry rather than extending it indefinitely. Search is bounded to ten results; listing is bounded to 100. [Retention settings](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/working-memory-retention-settings.mjs), [record lifecycle](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-working-memory-store.mjs)

A memory item whose kind is `task` is operational evidence. Board task status and execution receipts have their own store and lifecycle; see [Workers and tasks](workers-tasks.md).

## Tiddle rolling continuity

Tiddle collects terminal-turn residue with bounded message excerpts and periodically proposes continuity cards. The terminal append is intentionally cheap: it stores residue without a model call or direct card mutation. The normal pass runs every **four hours**, considers the last **24 hours** of residue and tracks success separately per scope. A failed scope therefore does not require replaying already successful scopes. [Residue and pass selection](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs)

Residue and history are native `tiddle_entries` rows with `tiddle_envelopes` retaining scheduling and envelope metadata. Residue appends prune older than the 24-hour cutoff and replace the same reference; history appends prune older than 180 days. The previous 240-residue count cap is removed. Due work uses an indexed `next_run_at` projection. These storage changes do not remove the bounded evidence excerpts or synthesis selection budget. [Native Tiddle store](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-tiddle-store.mjs), [due selection](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-persistence.mjs)

The default proposal is a no-op. One vivid exchange alone is not sufficient recurrence. Accepted updates target exact card identities and preserve evidence references. Behavioral corrections may become preference signals, but Tiddle does not directly rewrite agent profiles. Card changes, history and per-scope success commit atomically under an agent-scoped PostgreSQL advisory lock. [Proposal application](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs), [atomic persistence](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-persistence.mjs)

Cross-scope synthesis considers a 21-day window, requires at least two source cards across two scopes and checks referenced card identities. Its daily boundary is the first due pass on a different **UTC date**, rather than a separate local-time nightly cron. The scheduler checks every 60 seconds and starts with an immediate tick. [Synthesis](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs), [scheduler](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs)

Rolling cards use the persisted rolling TTL, **90 days by default**. Expired cards are filtered from reads; that is not a guarantee of immediate physical deletion. Relational scope and identity are `(agent_id, project, card_id)`, and card JSON preserves evidence and legacy metadata. [Rolling store](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-rolling-continuity-store.mjs)

`tiddleStatus.cardTtlDays` now reads the persisted rolling TTL, so status and the write policy share the same setting. [Tiddle status](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/tiddle-continuity.mjs)

## Session handoffs

A handoff summarizes the current goal, result and evidence references. Runtime-generated handoffs skip trivial exchanges but can retain substantive planning even when no tool ran. The curator distinguishes an assistant's assertion from successful tool evidence. [Handoff builder](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/continuity-handoff-store.mjs), [curator](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/continuity-handoff-curator.mjs)

Handoffs default to **14 days**, with a 240-character title, 24,000-character body and at most eight source references. An explicit handoff cannot be overwritten by an automatic runtime handoff. Recent-handoff selection prioritizes explicit material, then the current session. Handoffs are recall aids, separate from the execution-owner protocol described in [Persistence architecture](../architecture/persistence.md#runtime-continuity-and-crash-recovery). [Handoff lifecycle](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-continuity-handoff-store.mjs)

## Brains: explicit saved memories

Brains replaces the retired Albdruck operator surface. Each memory has a single `agentId` owner, a generated immutable ID, `title`, `content`, string `sourceRefs`, a revision and ownership/provenance metadata. Saved memories have **no TTL** and are **not automatically loaded into prompts**. They are useful for durable preferences and compact project knowledge, but a saved claim or source reference is not verification of current state. [Brain store](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs), [Tool contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-proposal.mjs)

### Use Brains in the interface

1. Open **Brains** and choose **Agent owner** before searching or writing.
2. Search existing memories first. Select **New memory**, add a title and content, and optionally enter one source reference per line.
3. Open a saved memory to edit or delete it. Operator writes mark it operator-owned; an agent cannot update or remove an operator-owned record.
4. If another writer changed the revision, select **Reload memory**, review the new content and retry deliberately. A stale revision is rejected rather than overwriting newer work.
5. For bulk deletion, select individual records or **Select page**, then **Delete selected memories**. Each deletion is independent, not atomic. Review the per-item results and reload conflicts before retrying. Selecting a page does not select the entire archive.

[Brains UI](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/albdruck/AlbdruckPage.tsx), [Revision and ownership enforcement](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs)

### Explicit retrieval and updates

Agents use `brain_search`, `brain_read`, `brain_save`, `brain_update` and `brain_remove`, subject to their tool permissions. The executor binds these calls to the active agent; it rejects a different requested agent. Updates and removals require `expectedRevision`. Removal creates a tombstone and hides the item from normal reads/search; it does not purge conversation originals or constitute physical erasure. Search before writing and read back important changes. [Brain executor](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/brain-tool-executor.mjs), [Persistence](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs)

The operator list uses case-insensitive substring matching over title/content, with agent/query-bound cursors. Optional Brain embeddings enrich explicit `brain_search`; they do not change the operator list into semantic search and do not enable automatic recall. Embeddings are disabled by default. When enabled, the store combines lexical matching with exact cosine ranking over the current agent's saved memories. Provider failure falls back to lexical results with `retrieval.fallback: embedding_unavailable`. See [memory API](../reference/api/memory.md#brain-embeddings) for settings and indexing status. [Embedding search](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-embeddings.mjs)

### Legacy Albdruck migration

The repeat-safe import preserves legacy knowledge/evidence/revision snapshots. Agent-scoped records retain their owner; legacy global records become owned by `hatchet`. Imported records are labelled `migrated_albdruck`, and the UI exposes **Legacy migration details**. Non-active legacy records are imported as deleted; operator-corrected/deleted records preserve operator ownership. Re-running the import does not overwrite edits or resurrect tombstones. Legacy tables remain present for migration/internal compatibility; they are not the current operator API. [Import mapping](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs)

## Retention is per store

Brains, working records, rolling cards, handoffs, Dream preloads, original conversations and attachment files have separate lifecycles. Brains has no automatic expiry. Working and rolling records default to 90 days, handoffs to 14 days, and attachment retention defaults to 30 days. Reset preserves archived originals. Deleting a Brain memory does not erase its original conversation, and cleaning up a conversation does not establish deletion of every saved memory, migration snapshot, exported copy or backup.

The former `/api/albdruck/*` routes, including history, retention and conversation purge, are not mounted in this release. Use [session search and Archive](../reference/api/sessions.md) for retained conversation evidence and the current [retention controls](../reference/api/settings.md) for supported trace cleanup. Those controls are not a replacement per-conversation purge API. Do not use an old Albdruck purge example as a current API procedure. [Current route wiring](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs), [Retention routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/general-settings-routes.mjs)

For deletion protections and exact distinctions, continue to [Conversation retention](conversation-history.md#retention-and-deletion). For recovery of memory together with its original evidence, use [Backup and recovery](../operations/backup-recovery.md).

# Dream cycles

Dreaming revisits retained conversation evidence. It produces operator-facing diary entries and can derive useful connections or preference signals. The memory publication path depends on Core's version; see [release status](../project/release-status.md).

## Schedule and model

Open **Settings → Agents → [agent] → Dreams**. Set enabled state, cron, prompt, and an optional model override, then save. Dreams follows the operator timezone, with UTC as fallback. The default schedule is `0 4 * * *`. A configured schedule does not verify provider credentials or model availability.

**Dream on quiet days** controls diary work when there is no new material to process. A quiet cycle may legitimately produce no new connections. Inspect Recent activity for the actual result rather than treating an unchanged memory list as a scheduler failure.

## Three evidence windows

| Phase | Lookback | Purpose |
|---|---:|---|
| Light | 1 day | Recent conversation evidence and reflection |
| Deep | 14 days | Broader recurring context |
| REM | 30 days | Longest-window synthesis |

The cycle uses retained original person-facing messages, including reset archives. It excludes system/tool/debug entries and subagent-provenance messages. Original identities prevent repeated archive occurrences from being counted as independent evidence. Compression summaries do not replace originals.

## Public Core 2026.10.19

In the inspected public release, REM candidates feed the compact `DREAM_MEMORY` profile and bounded scoped preload records. DreamMemory remains human-editable. This older publication path is separate from Brains and does not automatically create Brain records.

The public consolidator limits the compact document to 12 items, with bounded titles/content. Scoped preloads retain up to five items per selected scope, expire after seven days and are distinct from ordinary working-memory/rolling-card recall. Failed extraction or reconciliation preserves existing publication rather than claiming a new successful synthesis.

[Public cycle implementation](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/dream-cycle-runner.mjs) · [Public consolidator](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/dream-memory-consolidator.mjs)

## Newer Core: searchable Dream-generated connections

The newer implementation reviewed on 21 October replaces that publication path:

1. Extract grounded evidence from the configured windows.
2. Consider that evidence alongside existing Dream-generated connections owned by the same agent.
3. Synthesize useful associations across distinct subjects or recurring patterns. Producing no discovery is valid.
4. Save accepted results as individual Brains records with `origin: dreaming`, title, content, source references and revision/ownership metadata.
5. Keep retrieval explicit. Agents search/read Brains when relevant; the normal turn path supplies neither a Dream preload nor the legacy DreamMemory profile.

The Brains interface labels these records **Dream-generated**. Operator edits make records operator-owned, and ordinary agent mutation cannot overwrite those records. The old DreamMemory document can still be visible as legacy stored data; editing it does not restore automatic prompt injection in this newer path.

Current final synthesis reconciles prior active Dream-origin records using `new`, `update`, `noop`, or `review`. A material improvement can update the same ID only when Dream ownership and the expected revision still match. Paraphrases can be no-ops; review is non-destructive. Operator-owned, explicit, stale, invalid, or conflicting targets are not overwritten. This is bounded reconciliation, not automatic deletion/splitting of every similar memory.

### Control automatic promotion

Both **Settings → General → Brain memory → Promote Dreams to memory** and the selected agent's **Dreams → Promote Dreams to memory** must be enabled at publication. Both default on for existing installations. Save each changed setting. Turning either off preserves diaries/reflection, explicit saves, and existing memories; it stops automatic publication, not Dream scheduling. Re-enabling does not queue skipped promotions for catch-up.

### Memory expression and explicit previews

In **Settings → Agents → [agent] → Dreams**, **Memory emphasis** ranges from **0 Analytical** through **50 Balanced** (default) to **100 Meaning-focused**. It changes final memory expression, not source selection, evidence or citations. SOUL supplies voice, not invented facts. **Memory prompt override** replaces the built-in expression prompt (up to 20,000 characters); even an explicitly empty override is distinct from the default. **Revert to default** restores the default in the draft; use **Save dream settings** to persist changes. The separate **Dream prompt** still controls the diary.

**Preview memories** is an explicit, potentially paid model request using the saved Dream model and the draft expression settings. It does not save memories/settings, publish promotion, or run a full Dream cycle. It reuses recent validated extraction checkpoints that still match eligible REM-window sources: not all history, new extraction, or the existing Brain corpus. No eligible material means no model request. Preview results show source count/references and **Not saved**.

Repeat previews normally reuse the same source sample for up to 15 minutes, allowing expression comparisons without changing evidence; output can still vary. The process-wide cache is bounded and restart/eviction/source changes can invalidate a sample. **Preview new sample** explicitly captures different material. Saving expression changes affects a later authorized synthesis; it is not a bulk rewrite of existing memories. No-save means no Dream-store mutation, **not** no evidence: nonempty production previews retain ordinary filesystem execution traces and model diagnostics under normal retention.

### Preferences and diary remain separate

User-grounded preference candidates pass through preference adjudication into `PREFERENCES`. A diary passage is not an instruction or permission grant. Diary entries are operator-facing narrative, retained separately from searchable Brain connections.

## Citation and failure behavior

Source references must identify available evidence. Both reviewed paths have a bounded citation-repair attempt. In the newer implementation, candidates still containing invalid references after repair are dropped individually, with diagnostics; valid candidates can survive. A cycle with no useful connection can complete successfully with zero saved records.

Other extraction, provider or reconciliation errors remain visible in cycle receipts. Review `completed`, `partial`, `failed` or interrupted status, phase errors, source coverage and model diagnostics. The newer receipt reports `dreamConnectionCount` and `dreamConnectionIds`; these are publication receipts, not proof that the model's association is correct.

Check enabled state and effective timezone first, then the selected provider/model and cycle's phase errors. A successful diary is not evidence that memory publication also succeeded.

## Storage and retention

Brains connections have no automatic TTL and remain separated by agent owner. Original conversations, diaries, legacy preload rows, preferences and Brain records have independent lifecycles. Removing a Brain record does not remove its cited conversation or every exported/backup copy.

See [Memory and continuity](memory.md), [Conversation history](conversation-history.md), and [Backup and recovery](../operations/backup-recovery.md).

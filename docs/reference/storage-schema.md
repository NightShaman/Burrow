# Storage schema

This reference describes the current PostgreSQL schema at application migration **49**, plus runtime-owned filesystem data. It is an ownership and relationship guide, not a supported direct-write API. Use the application stores or [API](api.md) for mutation so validation, evidence checks, encryption and lifecycle rules remain intact.

See [Persistence architecture](../architecture/persistence.md) for the data flow and [Backup and recovery](../operations/backup-recovery.md) for recovery scope.

## Migration ledger

`burrow_schema_migrations` records `version`, `name`, `checksum` and `applied_at`. The runner validates an append-only, contiguous history and uses a transaction advisory lock. Changing an already applied migration is an error. `burrow_migration_receipts` is a separate table for verified source-cutover receipts (`migration_id`, manifest, fingerprint, result and completion time). [Ledger](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-migrations.mjs#L6-L64), [manifest](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-application-schema.mjs#L31-L77)

| Version | Migration name |
|---:|---|
| 1 | `application-stores` |
| 2 | `conversation-session-boundary` |
| 3 | `conversation-archives` |
| 4 | `settings-metadata-boundary` |
| 5 | `ui-auth-secrets` |
| 6 | `core-mod-settings-lifecycle` |
| 7 | `mod-distribution` |
| 8 | `verified-source-cutover-receipts` |
| 9 | `lossless-conversation-json` |
| 10 | `operator-message-lookup` |
| 11 | `scheduled-job-timezone-inheritance` |
| 12 | `dream-timezone-inheritance` |
| 13 | `albdruck-knowledge` |
| 14 | `dream-incremental-extraction` |
| 15 | `lexical-original-lookup` |
| 16 | `original-occurrence-rows` |
| 17 | `conversation-search-candidates` |
| 18 | `unified-rolling-continuity` |
| 19 | `native-conversation-archive-payloads` |
| 20 | `native-conversation-extracted-metadata` |
| 21 | `ascii-run-search-candidates` |
| 22 | `forge-native-status-and-identity` |
| 23 | `native-continuity-log-and-queue` |
| 24 | `mcp-provider-lifecycle-state` |
| 25 | `native-dream-state-entries` |
| 26 | `native-tiddle-entries-and-scheduling` |
| 27 | `lossless-continuity-payloads` |
| 28 | `forge-mcp-native-persistence-boundaries` |
| 29 | `stable-dream-scope-review-identity` |
| 30 | `native-dream-tiddle-identity` |
| 31 | `typed-mod-lifecycle-boundary` |
| 32 | `native-model-mcp-catalogs` |
| 33 | `lossless-settings-json` |
| 34 | `native-timestamps-and-agent-identities` |
| 35 | `restore-required-instant-contracts` |
| 36 | `safe-session-reset-instant` |
| 37 | `history-keyset-order-and-precedence` |
| 38 | `logical-json-member-identity` |
| 39 | `archive-relational-fallback-identity` |
| 40 | `catalog-lossless-scalar-identity` |
| 41 | `logical-original-lookup-indexes` |
| 42 | `indexed-dream-occurrence-windows` |
| 43 | `durable-agent-message-deliveries` |
| 44 | `dream-quiet-day-setting` |
| 45 | `agent-owned-deliberate-brains` |
| 46 | `legacy-albdruck-brain-snapshot` |
| 47 | `optional-brain-embeddings` |
| 48 | `indexed-operator-message-instants` |
| 49 | `live-run-steering` |

Early schema constants intentionally remain immutable. Read them together with later migrations: for example, the original `conversation_archives.entries` column is removed by version 19, and timezone columns introduced as non-null become nullable in versions 11 and 12.

## Identity, profiles and model settings

| Table | Key / relationship | Stored data |
|---|---|---|
| `agents` | `id` | Name, enabled flag, available capabilities, context and execution-environment configuration |
| `agent_profile_documents` | `(agent_id, kind)`; agent FK cascades | Markdown for `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS`, `DREAM_MEMORY` |
| `chat_identities` | `(kind, id)`; kind is operator/agent | Display name and avatar; separate from the runtime agent registry |
| `model_connections` | `id`; ASCII-case-insensitive unique provider label | API type, base URL, input capabilities and model catalog JSON text |
| `model_connection_secrets` | `id`; unique `(connection_id, name)`; connection FK cascades | Ciphertext, nonce and authentication tag |
| `model_auth_previews` | `connection_id`; connection FK cascades | Non-secret authentication preview JSON text |
| `model_settings_cache` | `cache_key` | Catalog/settings cache JSON text and update time |
| `agent_model_selections` | `agent_id`; agent FK cascades, connection FK restricts | Selected connection/model, reasoning effort and temperature |

[Agents](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-registry.mjs#L51-L80), [profiles](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L12-L21), [model schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-model-settings-store.mjs#L10-L40)

Temperature is constrained to 0–2, default 0.2. Profile kind is constrained by the database; profile size and complete-replacement semantics are enforced by the store. Secret tables store encrypted bytes, not the external `BURROW_SETTINGS_KEY`. See [Authentication](../security/authentication.md).

## Conversations and original evidence

| Table/view | Identity | Contract |
|---|---|---|
| `conversation_sessions` | `(agent_id, session_id)` | JSONB metadata, timestamps; owns native entries and archives |
| `conversation_entries` | `(agent_id, session_id, sequence)` | Live `entry JSON`; unique entry ID and idempotency key within session |
| `conversation_archives` | `(agent_id, session_id, archive_id)` | Generation, kind, metadata and timestamp; no aggregate `entries` payload in current schema |
| `conversation_archive_entries` | `(agent_id, session_id, source_store, source_id, ordinal)` | Native archived occurrence and original `entry JSON`; owner FK cascades from archive header |
| `conversation_original_rows` | Read-only `UNION ALL` view | Unified lookup across live entries and archive occurrences |

The session owner FK cascades to entries and archive headers; archive ownership cascades to native archive occurrences. Conversation session `agent_id` is a scope field, not an `agents` foreign key. Do not infer cross-table deletion behavior from similarly named columns. [Initial session/archives schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L7-L49), [occurrence schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L151-L169), [native conversion](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L270-L299)

Current native rows also contain extracted `entry_key`, `search_projection`, `search_grams`, `has_payload_id` and `has_compression_summary` metadata. Triggers extract metadata only when payloads change, with conservative fallback when fields cannot be safely projected. GIN candidate indexes speed lookup; original JSON and the final JavaScript matcher remain authoritative. [Metadata migration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L365-L422), [ASCII-run candidates](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-session-store.mjs#L425-L499)

Session metadata retains transcript/reset generation, archive status and read evidence. Migration 23 moves `continuityHead`, `interruptedRun` and `recoveryQueue` into native stores and removes the old metadata copies. Session listing joins the current head for compatibility. [Native transition](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-continuity-state-store.mjs#L24-L33), [session projection](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-session-store.mjs#L772-L776), [read evidence](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/read-evidence-store.mjs#L3-L13)

| Table | Key / relationship | Stored data |
|---|---|---|
| `continuity_state` | `(agent_id, session_id)`; session FK cascades | `head`, `manifest`, `queue` as `json`; extracted owner/head/queue state, auto-resume and queued/update time |
| `continuity_log` | Identity bigint `sequence`; session FK cascades | Append-only transition snapshots using `json` payloads |

Continuity updates lock the session row, atomically update native state and append a log only when the continuity payload changes. Pending/active indexes drive recovery selection. Original session rename updates both tables; session deletion and Albdruck purge reject active native heads or running recovery queues. [Native state writer](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-continuity-state-store.mjs#L42-L78), [rename/deletion](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-session-store.mjs#L530-L545)


## Working memory, rolling continuity and handoffs

| Table | Key / relationship | Stored data |
|---|---|---|
| `working_memory` | `id`; scope columns agent/session/conversation/project | Kind, state, title, content, source refs, pinning, timestamps, expiry and last recall |
| `working_memory_meta` | `key` | Remaining working-memory JSONB metadata; native Dream collections moved in migration 25 |
| `working_memory_retention_settings` | `owner_id` | Persisted working-record and rolling-card TTL policy |
| `rolling_continuity_cards` | `(agent_id, project, card_id)` | Complete card JSON, update time and preserved migration metadata |
| `rolling_continuity_envelopes` | `(legacy_source, legacy_key)` | Preserved legacy envelope metadata from migration 18 |
| `continuity_handoffs` | `id`; indexed by agent/expiry/update | Agent/session/run, explicit/runtime source, content, refs, evidence summary and expiry |
| `tiddle_envelopes` | `key` | Envelope JSONB, update time and indexed `next_run_at` scheduling projection |
| `tiddle_entries` | Identity bigint `id`; envelope FK cascades | Ordered JSONB history/residue entries with timestamp and reference |

Working-memory kind is constrained to `decision`, `finding`, `blocker`, `handoff`, `task`; state to `active`, `resolved`, `superseded`. Scope columns here are not agent/session foreign keys. Lifecycle and purge behavior therefore belong to the stores as well as the schema. [Working memory schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-working-memory-store.mjs#L57-L60), [rolling migration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-rolling-continuity-store.mjs#L1-L74), [handoffs](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-continuity-handoff-store.mjs#L9-L25), [retention settings](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-working-memory-retention-settings-store.mjs#L4-L14)

Migration 26 moves Tiddle residue/history and pass/scope/receipt/synthesis envelopes out of `settings_meta`. Native append keeps ordering and prunes by age/reference; the old 240-entry residue cap is removed. Generic metadata atomic updates reject these keys, requiring the native writer. [Tiddle migration and writer](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-tiddle-store.mjs#L1-L37), [metadata dispatch](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-settings-metadata-store.mjs#L21-L46)

Migration 18 moves legacy rolling envelopes into relational scope/identity while preserving complete card JSON and additional envelope metadata. Malformed source envelopes stop the migration rather than being silently discarded. See [Memory and continuity](../concepts/memory.md).

## Dream

| Table | Key / relationship | Stored data |
|---|---|---|
| `dream_settings` | `agent_id`; agent FK cascades | Enabled, cron, nullable timezone, prompt and optional model override |
| `dream_diary_entries` | `id`; agent FK cascades | Date, phase, narrative, digest and source refs; unique agent/date/phase/digest |
| `dream_cycle_state` | `agent_id`; agent FK cascades | Scheduler/cycle state JSONB |
| `dream_cycle_occurrences` | `(agent_id, scheduled_for)`; agent FK cascades | Claim identity and occurrence JSONB |
| `dream_cycle_receipts` | `(agent_id, run_id)`; agent FK cascades | Progress/result receipt JSONB, indexed by update time |
| `dream_extraction_batches` | `(agent_id, batch_id)`; agent FK cascades | Contract version, source fingerprints, pre-reconciliation candidates and completion time |
| `dream_state_envelopes` | `key` | Kind (`ledger`, `preload`, `scope_review`), metadata JSONB and update time |
| `dream_ledger_entries` | `(key, position)`; envelope FK cascades | Ordered ledger payload JSONB |
| `dream_preload_entries` | `(key, position)`; envelope FK cascades | Ordered preload payload JSONB |
| `dream_scope_review_entries` | `(key, position)`; envelope FK cascades | Ordered scope-review candidate JSONB |

[Settings](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-dream-settings-store.mjs#L6-L18), [diary](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-dream-diary-store.mjs#L4-L18), [cycle tables](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-dream-cycle-receipt-store.mjs#L30-L35), [extraction checkpoints](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-dream-extraction-store.mjs#L3-L17)

Migration 25 splits legacy Dream collections from `working_memory_meta` into envelope metadata and native rows, preserving array order and refusing malformed object/array envelopes. The write helper uses an advisory lock per key, merges metadata and appends or replaces entries transactionally. It removes legacy store-level count/reference truncation; generation callers can still select bounded subsets. [Dream state schema](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-dream-state-schema.mjs#L1-L26), [writer](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-working-memory-store.mjs#L270-L361)

Diary phase permits `light`, `deep`, `rem` and `manual`. Incremental batches are successful derived checkpoints, including empty candidate results; they are not another store of original transcripts. The compact DreamMemory result lives in `agent_profile_documents`, not a dedicated DreamMemory table. See [Dream cycles](../concepts/dreams.md).

## Brains and optional embeddings

`brain_memories` is keyed by `(agent_id, id)` and stores title, content, source references, revision, operator ownership, timestamps and a soft-delete marker. Operator-owned entries cannot be changed by agent tools; edits require the expected revision. Migration 46 preserves legacy snapshots in `brain_legacy_albdruck` and adds origin/status/snapshot fields to migrated memories. Legacy global entries are assigned to `hatchet`, not copied to every agent.

Optional embedding configuration, vectors and pending jobs live in `brain_embedding_settings`, `brain_embedding_vectors` and `brain_embedding_jobs`. Embeddings start disabled. Revision/generation checks keep stale vectors from becoming current; disabling semantic search does not delete the saved memory itself.

[Memory schema](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-store.mjs) · [Embedding schema](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-brain-embeddings.mjs) · [Current manifest](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-application-schema.mjs).

## Legacy Albdruck knowledge

These tables remain in the database for compatibility and migration. They do not establish a current Albdruck UI or mounted HTTP route. Use [Brains and recall](../concepts/memory.md) for current operator behavior.


| Table | Key / relationship | Stored data |
|---|---|---|
| `albdruck_knowledge` | `id`; unique `(scope, fingerprint)` | Normalized document JSONB, active/superseded/deleted state and timestamps |
| `albdruck_evidence` | `(knowledge_id, evidence_key)`; knowledge FK cascades | Original locator JSONB, preserved excerpt and creation time |
| `albdruck_revisions` | Identity bigint `id`; knowledge FK cascades | Operation, document JSONB and timestamp |
| `albdruck_retention` | `owner_id` | Policy JSONB |

Original references are semantic locators resolved through the conversation store; they are not SQL foreign keys into message payloads. Evidence and knowledge are derived. Store validation checks source existence, scope, fingerprints and user evidence for supersession. [Albdruck schema and contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L7-L55), [write validation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-albdruck-store.mjs#L144-L237)

## Task board and scheduling

| Table | Key / relationship | Stored data |
|---|---|---|
| `task_board_projects` | `id`; unique name | Description, notes and timestamps |
| `task_board_project_paths` | `id`; project FK cascades | Label/path/note and sort order |
| `task_board_tasks` | `id`; project FK cascades, assigned-agent FK sets null | Status, priority, metadata/provenance JSONB and execution JSONB |
| `conversation_project_bindings` | `(agent_id, session_id)`; agent and project FKs cascade | Explicit conversation-to-project binding |
| `scheduled_jobs` | `id`; agent FK cascades | Owner mod, prompt, cron, nullable inherited timezone, effective timezone, session/model and next/last run |
| `scheduled_job_runs` | `id`; job FK cascades; unique `(job_id, scheduled_for)` | Run status, dispatch/completion, trace/result/error fields |

Task statuses are `backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`; priorities are `critical`, `high`, `normal`, `low`. Scheduled-run statuses are `running`, `completed`, `failed`, `cancelled`, `missed`, `skipped`. Model override fields on scheduled jobs are validated by the store rather than declared as model-connection foreign keys. [Task schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-task-board-store.mjs#L189-L195), [schedule schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-scheduled-job-store.mjs#L149-L154), [timezone migration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-application-schema.mjs#L54-L57)

## Forge and filesystem artifacts

| Table | Key | Stored data |
|---|---|---|
| `forge_jobs` | `id`; idempotency/status indexes; identity `ordinal` | Operator ownership, owner token, native status, request/record JSONB, timestamps and artifact references |
| `forge_selections` | `mode` | Saved connection/model selection |
| `forge_idempotency_claims` | `idem`; `first_job_id` FK to jobs | Unique claim for an idempotency identity, preserving existing colliding historical jobs |

Forge claims idempotency under an advisory lock and inserts a unique claim row before provider dispatch. Migration 22 preserves colliding legacy jobs while reserving their shared identity; a trigger derives native `status` from the job record. Artifact bytes live on disk. Store initialization retains compatibility DDL and checks native-schema presence under a transaction advisory lock. [Forge native schema](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-forge-native-schema.mjs#L1-L22), [initialization](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-forge-store.mjs#L134-L146), [job claim](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-forge-store.mjs#L335-L397)

The current attachment-to-session error-cleanup path has a source-level defect documented in [Known limitations](../project/known-limitations.md); do not treat a stored generated artifact as proof of successful session delivery.

## MCP, skills, mods and authentication

| Table | Key / relationship | Stored data |
|---|---|---|
| `mcp_connections` | `id`; unique name | Transport/kind, URL or stdio command/args, lifecycle, enabled state and tool catalog |
| `mcp_connection_secrets` | `id`; unique `(connection_id, name)`; connection FK cascades | Encrypted API key/environment values |
| `agent_mcp_tools` | `(agent_id, connection_id, tool_name)`; both FKs cascade | Per-agent enablement grants |
| `mcp_provider_events` | Identity bigint `sequence` | Sanitized lifecycle receipt as `json`; latest 200 retained |
| `mcp_provider_legacy_imports` | `source_path` | Complete legacy JSONL text and import timestamp, once per path |
| `skills` | `id` | Name, description, content and lifecycle |
| `skill_global_assignments` | `skill_id`; skill FK cascades | Global assignment |
| `agent_skill_assignments` | `(agent_id, skill_id)`; both FKs cascade | Agent assignment |
| `mod_settings` | `(mod_id, name)` | JSON text settings |
| `mod_secrets` | `(mod_id, name)` | Encrypted secret bytes |
| `mod_lifecycle` | `mod_id` | Enabled state and timestamps |
| `mod_sources` | `id`; unique URL | Distribution source, discovered version/archive, status and errors |
| `mod_source_secrets` | `source_id`; source FK cascades | Encrypted source credential |
| `mod_installations` | `mod_id`; source FK sets null | Installed version, archive SHA-256 and timestamps |
| `api_tokens` | `id`; unique token hash | SHA-256 hash, prefix, scope, expiry/revocation and last use |
| `ui_auth_secrets` | `id`; unique name | Encrypted UI-auth material |

[MCP schema](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-mcp-settings-store.mjs#L5-L24), [skills](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-skill-settings-store.mjs#L2-L5), [mod state](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-mod-store.mjs#L5-L19), [mod distribution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-mod-distribution-repository.mjs#L3-L19), [API tokens](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-api-token-store.mjs#L4-L10), [UI-auth secrets](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-ui-auth-secret-store.mjs#L6-L14)

In the composed server, MCP lifecycle events use PostgreSQL. Hydration imports an existing JSONL file once per path, preserves the entire raw source (including malformed lines/unknown fields) in the import table, and combines normalized historical/live receipts before keeping the latest 200. The original file is not removed. **The raw import receipt is not a redaction guarantee.** Standalone adapters without the configured store retain the file-backed fallback. [MCP state store](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-mcp-provider-state-store.mjs#L1-L62), [adapter boundary](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/mcporter-adapter.mjs#L27-L66)

Managed mod MCP catalogs use stable `mod://` identities. Removing an installation preserves mod settings/secrets and sibling mod-data files; uninstall is not a full data purge. The API-token scope implemented in this version is `diagnostics:read`. See [MCP](../concepts/mcp.md), [Extensions](../development/extensions.md) and [Authentication](../security/authentication.md) for supported administration.

## General metadata and policy

| Table | Key | Stored data |
|---|---|---|
| `settings_meta` | `key` | JSON text and update time; application-owned metadata keys |
| `installation_setup_state` | `owner_id` | Persisted initial-setup state JSONB |
| `retention_settings` | `owner_id` | Trace retention policy/state JSONB |
| `working_memory_retention_settings` | `owner_id` | Working/rolling TTL settings JSONB |

[Settings metadata](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-settings-metadata-store.mjs#L3-L47), [setup](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-setup-state-store.mjs#L1-L14), [trace retention](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-retention-settings-store.mjs#L4-L17), [memory retention](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-working-memory-retention-settings-store.mjs#L4-L14)

The schema uses a mixture of timestamp text and `timestamptz`, and JSON text, `json` and `jsonb`. Do not normalize these columns wholesale: original `json` is a deliberate losslessness boundary, and changing historical migration SQL breaks ledger validation.

## Files outside PostgreSQL

Database rows may reference bytes or records under the configured roots:

- Agent workspace `artifacts/attachments/` and `artifacts/generated/`
- Runtime `subagents/<id>/subagent.json` and `work-items/<id>/work-item.json`
- Group-channel metadata and per-run trace files
- Installed mod files and mod-owned sibling data

See [Persistence architecture](../architecture/persistence.md#filesystem-state) for storage owners. Portable settings export does not include the entire database or these files. Use the [backup procedure](../operations/backup-recovery.md), preserving the external settings-encryption key as part of the recovery plan.

import { POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL } from './postgres-archive-discovery-indexes.mjs';
import { POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL } from './postgres-archive-chat-projection.mjs';
import { POSTGRES_ARCHIVE_LEXICAL_SQL } from './postgres-archive-lexical.mjs';
import { POSTGRES_CHAT_INPUT_SCHEMA_SQL } from './postgres-chat-input-store.mjs';
import { POSTGRES_EVENT_OPERATOR_PROJECTION_SQL } from './postgres-event-operator-projection.mjs';
import { POSTGRES_COMPLETION_EVENT_SETTINGS_SQL } from './postgres-completion-event-settings-store.mjs';
import { POSTGRES_COMPLETION_EVENT_SCHEMA_SQL } from './postgres-completion-event-store.mjs';
import { POSTGRES_PROVIDER_POOL_METRICS_SQL } from './postgres-provider-pool-metrics.mjs';
import { POSTGRES_FORGE_ARCHIVE_SQL } from './postgres-forge-archive.mjs';
import { POSTGRES_COMPACTION_PROJECTIONS_SQL } from './postgres-compaction-projections.mjs';
import { POSTGRES_MOD_GENERATION_SCHEMA_SQL } from './postgres-mod-generation-store.mjs';
import { POSTGRES_MOD_EXTERNAL_TURN_SCHEMA_SQL } from './postgres-mod-external-turn-store.mjs';
import { POSTGRES_MOD_AUTHORITY_SCHEMA_SQL } from './mod-authority.mjs';
import { POSTGRES_SKILL_SOURCES_SQL } from './postgres-skill-sources.mjs';
import { POSTGRES_LIVE_RUN_STEERING_SQL } from './postgres-live-run-steering.mjs';
import { POSTGRES_OPERATOR_INSTANT_SQL } from './postgres-operator-instant.mjs';
import { POSTGRES_BRAIN_EMBEDDINGS_SQL } from './postgres-brain-embeddings.mjs';
import { POSTGRES_BRAIN_SCHEMA_SQL, POSTGRES_BRAIN_LEGACY_IMPORT_SQL } from './postgres-brain-store.mjs';
import { POSTGRES_DREAM_WINDOW_SQL } from './postgres-dream-window.mjs';
import { POSTGRES_LOGICAL_MEMBER_SQL, POSTGRES_ARCHIVE_RELATIONAL_ID_SQL, POSTGRES_CATALOG_SCALAR_ID_SQL, POSTGRES_LOGICAL_LOOKUP_INDEX_SQL } from './postgres-lexical-identity.mjs';
import { POSTGRES_HISTORY_KEYSET_SQL } from './postgres-history-keyset.mjs';
import { POSTGRES_RESET_INSTANT_SQL } from './postgres-reset-instant.mjs';
import { POSTGRES_REQUIRED_TIMESTAMPS_SQL } from './postgres-required-timestamps.mjs';
import { POSTGRES_NATIVE_TIMESTAMPS_SQL } from './postgres-native-timestamps.mjs';
import { POSTGRES_REMAINING_JSON_SQL } from './postgres-remaining-json.mjs';
import { POSTGRES_NATIVE_CATALOGS_SQL } from './postgres-native-catalogs.mjs';
import { POSTGRES_TYPED_BOUNDARY_SQL } from './postgres-typed-boundary.mjs';
import { POSTGRES_NATIVE_DREAM_TIDDLE_IDENTITY_SQL } from './postgres-native-dream-tiddle-identity.mjs';
import { POSTGRES_FORGE_MCP_BOUNDARY_SCHEMA_SQL } from './postgres-forge-mcp-boundary-migration.mjs';
import { LOSSLESS_CONTINUITY_SQL } from './postgres-lossless-continuity.mjs';
import { POSTGRES_TIDDLE_SCHEMA_SQL } from './postgres-tiddle-store.mjs';
import { POSTGRES_DREAM_STATE_SCHEMA_SQL, POSTGRES_DREAM_SCOPE_IDENTITY_SQL } from './postgres-dream-state-schema.mjs';
import { POSTGRES_MCP_PROVIDER_STATE_SCHEMA_SQL } from './postgres-mcp-provider-state-store.mjs';
import { POSTGRES_CONTINUITY_STATE_SCHEMA_SQL } from './postgres-continuity-state-store.mjs';
import { POSTGRES_FORGE_NATIVE_SCHEMA_SQL } from './postgres-forge-native-schema.mjs';
import { POSTGRES_ROLLING_CONTINUITY_SCHEMA_SQL } from './postgres-rolling-continuity-store.mjs';
import { POSTGRES_DREAM_EXTRACTION_SCHEMA_SQL } from './postgres-dream-extraction-store.mjs';
import { POSTGRES_ALBDRUCK_SCHEMA_SQL } from './postgres-albdruck-store.mjs';
import { POSTGRES_MOD_DISTRIBUTION_SCHEMA_SQL, POSTGRES_MOD_MANAGEMENT_SCHEMA_SQL } from './postgres-mod-distribution-repository.mjs';
import { POSTGRES_MOD_SCHEMA_SQL } from './postgres-mod-store.mjs';
import { POSTGRES_AGENT_REGISTRY_SCHEMA_SQL } from './postgres-agent-registry.mjs';
import { POSTGRES_AGENT_PROFILE_SCHEMA_SQL } from './postgres-agent-profile-store.mjs';
import { POSTGRES_MODEL_SETTINGS_SCHEMA_SQL, POSTGRES_MINION_MODEL_SETTINGS_SCHEMA_SQL, POSTGRES_PROVIDER_POOL_SCHEMA_SQL } from './postgres-model-settings-store.mjs';
import { POSTGRES_MCP_SETTINGS_SCHEMA_SQL } from './postgres-mcp-settings-store.mjs';
import { POSTGRES_TASK_BOARD_SCHEMA_SQL } from './postgres-task-board-store.mjs';
import { POSTGRES_TASK_AUDIT_SCHEMA_SQL } from './postgres-task-audit-schema.mjs';
import { POSTGRES_SCHEDULED_JOB_SCHEMA_SQL } from './postgres-scheduled-job-store.mjs';
import { POSTGRES_DREAM_SETTINGS_SCHEMA_SQL } from './postgres-dream-settings-store.mjs';
import { POSTGRES_DREAM_DIARY_SCHEMA_SQL, POSTGRES_DREAM_CALENDAR_INDEX_SQL } from './postgres-dream-diary-store.mjs';
import { POSTGRES_DREAM_CYCLE_RECEIPT_SCHEMA_SQL } from './postgres-dream-cycle-receipt-store.mjs';
import { POSTGRES_CONTINUITY_HANDOFF_SCHEMA_SQL } from './postgres-continuity-handoff-store.mjs';
import { POSTGRES_FORGE_SCHEMA_SQL } from './postgres-forge-store.mjs';
import { POSTGRES_WORKING_MEMORY_SCHEMA_SQL } from './postgres-working-memory-store.mjs';
import { POSTGRES_API_TOKEN_SCHEMA_SQL } from './postgres-api-token-store.mjs';
import { POSTGRES_SKILL_SETTINGS_SCHEMA_SQL, POSTGRES_OFFICIAL_SKILL_DEFAULT_SQL } from './postgres-skill-settings-store.mjs';
import { POSTGRES_SETUP_STATE_SCHEMA_SQL } from './postgres-setup-state-store.mjs';
import { POSTGRES_RETENTION_SETTINGS_SCHEMA_SQL } from './postgres-retention-settings-store.mjs';
import { POSTGRES_WORKING_MEMORY_RETENTION_SCHEMA_SQL } from './postgres-working-memory-retention-settings-store.mjs';
import { POSTGRES_SESSION_SCHEMA_SQL, POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL, POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL, POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL, POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL, POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL, POSTGRES_SESSION_SEARCH_SCHEMA_SQL, POSTGRES_SESSION_NATIVE_SCHEMA_SQL, POSTGRES_SESSION_METADATA_SCHEMA_SQL, POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL, POSTGRES_ARCHIVE_LISTING_INDEX_SQL, POSTGRES_ARCHIVE_RUN_INDEX_SQL } from './postgres-session-store.mjs';
import { POSTGRES_UI_AUTH_SECRET_SCHEMA_SQL } from './postgres-ui-auth-secret-store.mjs';
import { POSTGRES_OTEL_SETTINGS_SCHEMA_SQL, POSTGRES_OTEL_DESTINATIONS_SCHEMA_SQL } from './postgres-otel-settings-store.mjs';
import { POSTGRES_AGENT_DELIVERY_OWNER_SQL, POSTGRES_AGENT_DELIVERY_SCHEMA_SQL } from './postgres-agent-delivery-store.mjs';

// Version 1 and its component SQL are immutable after adoption. Schema changes
// require an appended migration, never edits to a previously applied checksum.
export const POSTGRES_APPLICATION_SCHEMA_SQL = Object.freeze([
  POSTGRES_AGENT_REGISTRY_SCHEMA_SQL, POSTGRES_AGENT_PROFILE_SCHEMA_SQL,
  POSTGRES_MODEL_SETTINGS_SCHEMA_SQL, POSTGRES_MCP_SETTINGS_SCHEMA_SQL,
  POSTGRES_TASK_BOARD_SCHEMA_SQL, POSTGRES_SCHEDULED_JOB_SCHEMA_SQL,
  POSTGRES_DREAM_SETTINGS_SCHEMA_SQL, POSTGRES_DREAM_DIARY_SCHEMA_SQL,
  POSTGRES_DREAM_CYCLE_RECEIPT_SCHEMA_SQL, POSTGRES_CONTINUITY_HANDOFF_SCHEMA_SQL,
  POSTGRES_FORGE_SCHEMA_SQL, POSTGRES_WORKING_MEMORY_SCHEMA_SQL,
  POSTGRES_API_TOKEN_SCHEMA_SQL, POSTGRES_SKILL_SETTINGS_SCHEMA_SQL,
  POSTGRES_SETUP_STATE_SCHEMA_SQL, POSTGRES_RETENTION_SETTINGS_SCHEMA_SQL,
  POSTGRES_WORKING_MEMORY_RETENTION_SCHEMA_SQL,
].join('\n\n'));

export const POSTGRES_APPLICATION_SCHEMA_MANIFEST = Object.freeze([
  { version: 1, name: 'application-stores', sql: POSTGRES_APPLICATION_SCHEMA_SQL },
  // Append-only: conversation authority is a staged successor migration; v1 is immutable.
  { version: 2, name: 'conversation-session-boundary', sql: POSTGRES_SESSION_SCHEMA_SQL },
  { version: 3, name: 'conversation-archives', sql: POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL },
  // Metadata was added after v1 adoption; keep v1-v3 byte-for-byte immutable.
  { version: 4, name: 'settings-metadata-boundary', sql: 'CREATE TABLE IF NOT EXISTS settings_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);' },
  { version: 5, name: 'ui-auth-secrets', sql: POSTGRES_UI_AUTH_SECRET_SCHEMA_SQL },
  { version: 6, name: 'core-mod-settings-lifecycle', sql: POSTGRES_MOD_SCHEMA_SQL },
  { version: 7, name: 'mod-distribution', sql: POSTGRES_MOD_DISTRIBUTION_SCHEMA_SQL },
  { version: 8, name: 'verified-source-cutover-receipts', sql: `CREATE TABLE IF NOT EXISTS burrow_migration_receipts (
    migration_id TEXT PRIMARY KEY, manifest JSONB NOT NULL, fingerprint TEXT NOT NULL,
    completed_at TEXT NOT NULL, result JSONB NOT NULL);` },
  { version: 9, name: 'lossless-conversation-json', sql: POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL },
  { version: 10, name: 'operator-message-lookup', sql: POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL },
  { version: 11, name: 'scheduled-job-timezone-inheritance', sql: `ALTER TABLE scheduled_jobs ALTER COLUMN timezone DROP NOT NULL;
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS effective_timezone TEXT;` },
  { version: 12, name: 'dream-timezone-inheritance', sql: 'ALTER TABLE dream_settings ALTER COLUMN timezone DROP NOT NULL;' },
  { version: 13, name: 'albdruck-knowledge', sql: POSTGRES_ALBDRUCK_SCHEMA_SQL },
  { version: 14, name: 'dream-incremental-extraction', sql: POSTGRES_DREAM_EXTRACTION_SCHEMA_SQL },
  { version: 15, name: 'lexical-original-lookup', sql: POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL },
  { version: 16, name: 'original-occurrence-rows', sql: POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL },
  { version: 17, name: 'conversation-search-candidates', sql: POSTGRES_SESSION_SEARCH_SCHEMA_SQL },
  { version: 18, name: 'unified-rolling-continuity', sql: POSTGRES_ROLLING_CONTINUITY_SCHEMA_SQL },
  { version: 19, name: 'native-conversation-archive-payloads', sql: POSTGRES_SESSION_NATIVE_SCHEMA_SQL },
  { version: 20, name: 'native-conversation-extracted-metadata', sql: POSTGRES_SESSION_METADATA_SCHEMA_SQL },
  { version: 21, name: 'ascii-run-search-candidates', sql: POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL },
  { version: 22, name: 'forge-native-status-and-identity', sql: POSTGRES_FORGE_NATIVE_SCHEMA_SQL },
  { version: 23, name: 'native-continuity-log-and-queue', sql: POSTGRES_CONTINUITY_STATE_SCHEMA_SQL },
  { version: 24, name: 'mcp-provider-lifecycle-state', sql: POSTGRES_MCP_PROVIDER_STATE_SCHEMA_SQL },
  { version: 25, name: 'native-dream-state-entries', sql: POSTGRES_DREAM_STATE_SCHEMA_SQL },
  { version: 26, name: 'native-tiddle-entries-and-scheduling', sql: POSTGRES_TIDDLE_SCHEMA_SQL },
  { version: 27, name: 'lossless-continuity-payloads', sql: LOSSLESS_CONTINUITY_SQL },
  { version: 28, name: 'forge-mcp-native-persistence-boundaries', sql: POSTGRES_FORGE_MCP_BOUNDARY_SCHEMA_SQL },
  { version: 29, name: 'stable-dream-scope-review-identity', sql: POSTGRES_DREAM_SCOPE_IDENTITY_SQL },
  { version: 30, name: 'native-dream-tiddle-identity', sql: POSTGRES_NATIVE_DREAM_TIDDLE_IDENTITY_SQL },
  { version: 31, name: 'typed-mod-lifecycle-boundary', sql: POSTGRES_TYPED_BOUNDARY_SQL },
  { version: 32, name: 'native-model-mcp-catalogs', sql: POSTGRES_NATIVE_CATALOGS_SQL },
  { version: 33, name: 'lossless-settings-json', sql: POSTGRES_REMAINING_JSON_SQL },
  { version: 34, name: 'native-timestamps-and-agent-identities', sql: POSTGRES_NATIVE_TIMESTAMPS_SQL },
  { version: 35, name: 'restore-required-instant-contracts', sql: POSTGRES_REQUIRED_TIMESTAMPS_SQL },
  { version: 36, name: 'safe-session-reset-instant', sql: POSTGRES_RESET_INSTANT_SQL },
  { version: 37, name: 'history-keyset-order-and-precedence', sql: POSTGRES_HISTORY_KEYSET_SQL },
  { version: 38, name: 'logical-json-member-identity', sql: POSTGRES_LOGICAL_MEMBER_SQL },
  { version: 39, name: 'archive-relational-fallback-identity', sql: POSTGRES_ARCHIVE_RELATIONAL_ID_SQL },
  { version: 40, name: 'catalog-lossless-scalar-identity', sql: POSTGRES_CATALOG_SCALAR_ID_SQL },
  { version: 41, name: 'logical-original-lookup-indexes', sql: POSTGRES_LOGICAL_LOOKUP_INDEX_SQL },
  { version: 42, name: 'indexed-dream-occurrence-windows', sql: POSTGRES_DREAM_WINDOW_SQL },
  { version: 43, name: 'durable-agent-message-deliveries', sql: POSTGRES_AGENT_DELIVERY_SCHEMA_SQL },
  { version: 44, name: 'dream-quiet-day-setting', sql: 'ALTER TABLE dream_settings ADD COLUMN IF NOT EXISTS quiet_day_dreams BOOLEAN NOT NULL DEFAULT TRUE;' },
  { version: 45, name: 'agent-owned-deliberate-brains', sql: POSTGRES_BRAIN_SCHEMA_SQL },
  // Non-destructive snapshot; legacy globals belong to hatchet, never fan out.
  { version: 46, name: 'legacy-albdruck-brain-snapshot', sql: `
ALTER TABLE brain_memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'explicit_saved_memory';
ALTER TABLE brain_memories ADD COLUMN legacy_status TEXT;
ALTER TABLE brain_memories ADD COLUMN legacy_snapshot JSONB;
CREATE TABLE brain_legacy_albdruck (
 legacy_id TEXT PRIMARY KEY, scope TEXT NOT NULL, snapshot JSONB NOT NULL
);
` + POSTGRES_BRAIN_LEGACY_IMPORT_SQL },
  { version: 47, name: 'optional-brain-embeddings', sql: POSTGRES_BRAIN_EMBEDDINGS_SQL },
  { version: 48, name: 'indexed-operator-message-instants', sql: POSTGRES_OPERATOR_INSTANT_SQL },
  { version: 49, name: 'live-run-steering', sql: POSTGRES_LIVE_RUN_STEERING_SQL },
  { version: 50, name: 'agent-minion-model-defaults', sql: POSTGRES_MINION_MODEL_SETTINGS_SCHEMA_SQL },
  { version: 51, name: 'git-managed-skills', sql: POSTGRES_SKILL_SOURCES_SQL },
  { version: 52, name: 'official-runtime-source-adoption', sql: POSTGRES_OFFICIAL_SKILL_DEFAULT_SQL },
  // Invalidate pending timezone caches; scheduler reconciliation computes from now,
  // never catching up occurrences belonging to a retired override.
  { version: 53, name: 'operator-only-scheduling-timezone', sql: `
UPDATE scheduled_jobs SET timezone=NULL,effective_timezone=NULL;
UPDATE dream_settings SET timezone=NULL;
ALTER TABLE skill_git_sources ADD COLUMN effective_timezone TEXT;
` },
  // Existing explicit choices remain intact; only future lifecycle rows default off.
  { version: 54, name: 'mods-disabled-by-default', sql: 'ALTER TABLE mod_lifecycle ALTER COLUMN enabled SET DEFAULT FALSE;' },
  { version: 55, name: 'durable-mod-management-operations', sql: POSTGRES_MOD_MANAGEMENT_SCHEMA_SQL },
  { version: 56, name: 'bounded-archive-listing-indexes', sql: POSTGRES_ARCHIVE_LISTING_INDEX_SQL + POSTGRES_DREAM_CALENDAR_INDEX_SQL },
  { version: 57, name: 'indexed-proof-run-directory', sql: POSTGRES_ARCHIVE_RUN_INDEX_SQL },
  { version: 58, name: 'operator-owned-mod-authority', sql: POSTGRES_MOD_AUTHORITY_SCHEMA_SQL },
  { version: 59, name: 'task-audit-history-and-documents', sql: POSTGRES_TASK_AUDIT_SCHEMA_SQL },
  { version: 60, name: 'opentelemetry-operator-settings', sql: POSTGRES_OTEL_SETTINGS_SCHEMA_SQL },
  { version: 61, name: 'global-profile-documents', sql: `
ALTER TABLE agents ADD COLUMN use_global_rules BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN use_global_orientation BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE global_profile_documents (kind TEXT PRIMARY KEY CHECK(kind IN ('RULES','ORIENTATION')), markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO global_profile_documents(kind,markdown,created_at,updated_at) VALUES ('RULES','',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text),('ORIENTATION','',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text);
` },
  { version: 62, name: 'global-profile-document-timestamps', sql: `
ALTER TABLE global_profile_documents
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;
` },
  { version: 63, name: 'mod-external-agent-turns', sql: POSTGRES_MOD_EXTERNAL_TURN_SCHEMA_SQL },
  { version: 64, name: 'mod-text-generations', sql: POSTGRES_MOD_GENERATION_SCHEMA_SQL },
  { version: 65, name: 'native-compaction-projection-reuse', sql: POSTGRES_COMPACTION_PROJECTIONS_SQL },
  { version: 66, name: 'owned-agent-message-deliveries', sql: POSTGRES_AGENT_DELIVERY_OWNER_SQL },
  { version: 67, name: 'mod-external-turn-display-message', sql: `
ALTER TABLE mod_external_turns ADD COLUMN display_message TEXT;
UPDATE mod_external_turns SET display_message=message WHERE display_message IS NULL;
ALTER TABLE mod_external_turns ALTER COLUMN display_message SET NOT NULL;
` },
  { version: 68, name: 'scheduled-model-context-mode', sql: `
ALTER TABLE scheduled_jobs ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'continue' CHECK (context_mode IN ('continue','fresh'));
` },
  { version: 69, name: 'provider-pool-connections-and-routing-state', sql: POSTGRES_PROVIDER_POOL_SCHEMA_SQL },
  { version: 70, name: 'dream-memory-promotion-toggle', sql: 'ALTER TABLE dream_settings ADD COLUMN IF NOT EXISTS promote_to_memory BOOLEAN NOT NULL DEFAULT TRUE;' },
  { version: 71, name: 'retained-forge-execution-history', sql: POSTGRES_FORGE_ARCHIVE_SQL },
  { version: 72, name: 'native-openai-pool-metrics', sql: POSTGRES_PROVIDER_POOL_METRICS_SQL },
  { version: 73, name: 'dream-memory-expression-controls', sql: `
ALTER TABLE dream_settings ADD COLUMN memory_emphasis INTEGER NOT NULL DEFAULT 50 CHECK (memory_emphasis BETWEEN 0 AND 100);
ALTER TABLE dream_settings ADD COLUMN memory_prompt_override TEXT CHECK (char_length(memory_prompt_override) <= 20000);
` },
  { version: 74, name: 'durable-github-completion-events', sql: POSTGRES_COMPLETION_EVENT_SCHEMA_SQL },
  { version: 75, name: 'settings-first-completion-webhook', sql: POSTGRES_COMPLETION_EVENT_SETTINGS_SQL },
  { version: 76, name: 'event-operator-projection-copies', sql: POSTGRES_EVENT_OPERATOR_PROJECTION_SQL },
  { version: 77, name: 'durable-chat-inputs', sql: POSTGRES_CHAT_INPUT_SCHEMA_SQL },
  { version: 78, name: 'opentelemetry-destinations', sql: POSTGRES_OTEL_DESTINATIONS_SCHEMA_SQL },
  // Shared group transcripts have a durable owner, not an executable agent.
  // Keep existing identity metadata (including historical backfill) untouched.
  { version: 79, name: 'builtin-group-channel-identity', sql: `
INSERT INTO agent_identity_registry(agent_id,archived) VALUES('group-channel',false)
ON CONFLICT(agent_id) DO NOTHING;
` },
  { version: 80, name: 'mod-external-turn-attachments', sql: `
ALTER TABLE mod_external_turns ADD COLUMN attachments JSON NOT NULL DEFAULT '[]'::json;
` },
  { version: 81, name: 'archive-lossless-candidate-projection', sql: POSTGRES_ARCHIVE_LEXICAL_SQL },
  { version: 82, name: 'archive-chat-projection-revisions', sql: POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL },
  { version: 83, name: 'archive-discovery-scalar-probe-indexes', sql: POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL },
  { version: 84, name: 'scheduled-board-tasks-and-once', sql: `
ALTER TABLE scheduled_jobs ALTER COLUMN cron_expression DROP NOT NULL;
ALTER TABLE scheduled_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'prompt' CHECK (job_kind IN ('prompt','task'));
ALTER TABLE scheduled_jobs ADD COLUMN task_id TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN extra_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduled_jobs ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_kind IN ('cron','once'));
ALTER TABLE scheduled_jobs ADD COLUMN run_at TIMESTAMPTZ;
ALTER TABLE scheduled_jobs ADD COLUMN consumed_at TIMESTAMPTZ;
ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_target_check CHECK ((job_kind='prompt' AND task_id IS NULL) OR (job_kind='task' AND task_id IS NOT NULL AND session_id='default' AND context_mode='continue'));
ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_schedule_check CHECK ((schedule_kind='cron' AND cron_expression IS NOT NULL AND run_at IS NULL) OR (schedule_kind='once' AND cron_expression IS NULL AND run_at IS NOT NULL));
-- Deliberately no task FK: a removed task must remain an identifiable skip.
ALTER TABLE scheduled_job_runs ADD COLUMN task_id TEXT;
CREATE INDEX scheduled_job_runs_latest_idx ON scheduled_job_runs(job_id,created_at DESC,scheduled_for DESC,id DESC);
` },
]);

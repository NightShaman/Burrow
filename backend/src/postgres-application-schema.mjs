import { POSTGRES_FORGE_GALLERY_SCHEMA_SQL } from './postgres-forge-gallery.mjs';
import { POSTGRES_AGENT_RUN_FEED_SQL } from './postgres-agent-run-feed.mjs';
import { POSTGRES_SESSION_RECALL_NONBLOCKING_SQL } from './postgres-session-recall-nonblocking.mjs';
import { POSTGRES_SESSION_RETRIEVAL_SQL } from './postgres-session-retrieval.mjs';
import { POSTGRES_SESSION_RECALL_REPAIRS_SQL } from './postgres-session-recall-repairs.mjs';
import { POSTGRES_SESSION_RECALL_RELEVANCE_SQL } from './postgres-session-recall-relevance.mjs';
import { POSTGRES_CONVERSATION_EMBEDDINGS_SQL } from './postgres-conversation-embeddings.mjs';
import { POSTGRES_RESET_PROJECTIONS_SQL } from './postgres-reset-projections.mjs';
import { POSTGRES_CHAT_RESULT_PROJECTION_SQL } from './postgres-chat-result-projection.mjs';
import { POSTGRES_AGENT_REFERENCE_IMAGE_SQL, POSTGRES_MOD_REFERENCE_IMAGE_SQL, POSTGRES_OPERATOR_REFERENCE_IMAGE_SQL } from './postgres-agent-reference-image-store.mjs';
import { POSTGRES_ANTHROPIC_THINKING_SQL } from './postgres-anthropic-thinking.mjs';
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
import { POSTGRES_MOD_MINION_SCHEMA_SQL } from './postgres-mod-minion-store.mjs';
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
import { POSTGRES_MOD_DISTRIBUTION_SCHEMA_SQL, POSTGRES_MOD_MANAGEMENT_SCHEMA_SQL, POSTGRES_MOD_AUTO_UPDATE_SCHEMA_SQL } from './postgres-mod-distribution-repository.mjs';
import { POSTGRES_MOD_SCHEMA_SQL } from './postgres-mod-store.mjs';
import { POSTGRES_AGENT_REGISTRY_SCHEMA_SQL } from './postgres-agent-registry.mjs';
import { POSTGRES_AGENT_PROFILE_SCHEMA_SQL } from './postgres-agent-profile-store.mjs';
import { POSTGRES_MODEL_SETTINGS_SCHEMA_SQL, POSTGRES_MINION_MODEL_SETTINGS_SCHEMA_SQL, POSTGRES_PROVIDER_POOL_SCHEMA_SQL } from './postgres-model-settings-store.mjs';
import { POSTGRES_MCP_SETTINGS_SCHEMA_SQL, POSTGRES_MCP_VERIFY_TLS_SQL } from './postgres-mcp-settings-store.mjs';
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
  { version: 85, name: 'anthropic-thinking-mode-selections', sql: POSTGRES_ANTHROPIC_THINKING_SQL },
  { version: 86, name: 'canonical-agent-reference-images', sql: POSTGRES_AGENT_REFERENCE_IMAGE_SQL },
  { version: 87, name: 'mod-character-reference-images', sql: POSTGRES_MOD_REFERENCE_IMAGE_SQL },
  { version: 88, name: 'structured-chat-result-projection', sql: POSTGRES_CHAT_RESULT_PROJECTION_SQL },
  { version: 89, name: 'canonical-operator-reference-image', sql: POSTGRES_OPERATOR_REFERENCE_IMAGE_SQL },
  { version: 90, name: 'mod-owned-agents', sql: 'ALTER TABLE agents ADD COLUMN mod_agent_json JSONB;' },
  { version: 91, name: 'independent-mod-agent-authority', sql: `
ALTER TABLE core_mod_authority ADD COLUMN mod_management_agent_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE core_mod_authority ADD COLUMN core_api_agent_ids JSONB NOT NULL DEFAULT '[]';
UPDATE core_mod_authority SET mod_management_agent_ids=admin_agent_ids, core_api_agent_ids=admin_agent_ids;
` },
  { version: 92, name: 'reset-archive-projection-copies', sql: POSTGRES_RESET_PROJECTIONS_SQL },
  { version: 93, name: 'indexed-session-recall', sql: POSTGRES_SESSION_RETRIEVAL_SQL },
  { version: 94, name: 'background-conversation-embeddings', sql: `ALTER TABLE brain_embedding_settings ADD COLUMN conversation_enabled boolean NOT NULL DEFAULT false;\n` + POSTGRES_CONVERSATION_EMBEDDINGS_SQL },
  { version: 95, name: 'session-recall-projection-repairs', sql: POSTGRES_SESSION_RECALL_REPAIRS_SQL },
  { version: 96, name: 'nonblocking-session-recall', sql: POSTGRES_SESSION_RECALL_NONBLOCKING_SQL },
  { version: 97, name: 'openai-expiring-reset-claims', sql: `
ALTER TABLE model_connections ADD COLUMN auto_use_expiring_resets BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE openai_reset_credit_claims (
 account_key TEXT NOT NULL, credit_id TEXT NOT NULL, request_id TEXT NOT NULL,
 claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(account_key,credit_id), UNIQUE(account_key,request_id)
);
` },
  { version: 98, name: 'openai-reset-durable-outcomes', sql: `
ALTER TABLE openai_reset_credit_claims
 ADD COLUMN expires_at TIMESTAMPTZ,
 ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('unknown','consumed','retryable','unavailable')),
 ADD COLUMN retry_at TIMESTAMPTZ,
 ADD COLUMN code TEXT,
 ADD COLUMN http_status INTEGER,
 ADD COLUMN error TEXT;
CREATE TABLE openai_reset_credit_attempts (
 account_key TEXT NOT NULL,
 credit_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 claimed_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ,
 outcome TEXT NOT NULL CHECK (outcome IN ('unknown','consumed','retryable','unavailable')),
 settled_at TIMESTAMPTZ,
 retry_at TIMESTAMPTZ,
 code TEXT,
 http_status INTEGER,
 error TEXT,
 PRIMARY KEY(account_key,request_id),
 FOREIGN KEY(account_key,credit_id) REFERENCES openai_reset_credit_claims(account_key,credit_id)
);
-- Legacy v97 claims have no expiry/outcome evidence: preserve the unknown fence.
INSERT INTO openai_reset_credit_attempts(account_key,credit_id,request_id,claimed_at,expires_at,outcome)
 SELECT account_key,credit_id,request_id,claimed_at,NULL,'unknown' FROM openai_reset_credit_claims;
CREATE INDEX openai_reset_credit_claims_unknown_idx ON openai_reset_credit_claims(account_key) WHERE outcome='unknown';
` },
  { version: 99, name: 'agent-run-completion-feed', sql: POSTGRES_AGENT_RUN_FEED_SQL },
  { version: 100, name: 'parked-board-task-status', sql: `
ALTER TABLE task_board_tasks DROP CONSTRAINT task_board_tasks_status_check;
ALTER TABLE task_board_tasks ADD CONSTRAINT task_board_tasks_status_check CHECK (status IN ('backlog','todo','in_progress','review','done','cancelled','parked'));
` },
  { version: 101, name: 'workflow-watch-conclusions', sql: `
ALTER TABLE github_workflow_watches ADD COLUMN conclusions TEXT[] NOT NULL DEFAULT ARRAY['failure','timed_out','startup_failure','action_required']::text[];
` },
  { version: 102, name: 'forge-image-gallery', sql: POSTGRES_FORGE_GALLERY_SCHEMA_SQL },
  { version: 103, name: 'anthropic-coordination-state', sql: `
CREATE TABLE anthropic_coordination_state (key TEXT PRIMARY KEY, state_json JSONB NOT NULL);
` },
  { version: 104, name: 'mcp-connection-tls-verification', sql: POSTGRES_MCP_VERIFY_TLS_SQL },
  { version: 105, name: 'forge-durable-artifact-cleanup', sql: `
CREATE TABLE forge_artifact_cleanup (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_agent_id TEXT NOT NULL,
 storage_reference TEXT NOT NULL,
 last_attempt_at TIMESTAMPTZ,
 UNIQUE (source_agent_id, storage_reference)
);
` },
  { version: 106, name: 'per-mod-auto-update', sql: POSTGRES_MOD_AUTO_UPDATE_SCHEMA_SQL },
  { version: 107, name: 'bounded-task-workflow-waits', sql: `
CREATE TABLE github_completion_inbox (
 repository TEXT NOT NULL, run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL,
 completion JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(repository,run_id,run_attempt)
);
CREATE TABLE task_workflow_waits (
 id UUID PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
 repository TEXT NOT NULL, workflow TEXT NOT NULL, run_id TEXT NOT NULL,
 run_attempt INTEGER NOT NULL CHECK(run_attempt>0), head_sha TEXT NOT NULL,
 checkpoint TEXT NOT NULL CHECK(char_length(checkpoint) BETWEEN 1 AND 20000),
 status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','matched','resumed','skipped')),
 reason_code TEXT, reason TEXT, source JSONB NOT NULL, trigger JSONB, continuation JSONB, outcome JSONB,
 registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), matched_at TIMESTAMPTZ, resumed_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX task_workflow_waits_active_idx ON task_workflow_waits(task_id) WHERE status IN ('waiting','matched');
CREATE UNIQUE INDEX task_workflow_waits_source_idx ON task_workflow_waits(task_id,(source->>'agentId'),(source->>'sessionId'),(source->>'runId'));
CREATE INDEX task_workflow_waits_target_idx ON task_workflow_waits(repository,run_id,run_attempt) WHERE status='waiting';
CREATE INDEX task_workflow_waits_task_idx ON task_workflow_waits(task_id,registered_at DESC,id DESC);
ALTER TABLE github_completion_events ADD COLUMN task_wait_id UUID;
ALTER TABLE github_completion_events ADD COLUMN task_id TEXT;
CREATE UNIQUE INDEX github_completion_events_wait_idx ON github_completion_events(task_wait_id) WHERE task_wait_id IS NOT NULL;
CREATE INDEX github_completion_events_normalized_identity_idx ON github_completion_events(lower(repository),run_id,run_attempt);
-- Retain skips across task deletion, reassignment, status changes and manual claims.
CREATE FUNCTION burrow_invalidate_task_waits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE task_workflow_waits SET status='skipped',reason_code='task_deleted',reason='Task deleted',finished_at=now() WHERE task_id=OLD.id AND status IN ('waiting','matched');
  RETURN OLD;
 END IF;
 UPDATE task_workflow_waits SET status='skipped',reason_code='task_no_longer_eligible',reason='Task status, assignment or execution superseded wait',finished_at=now()
 WHERE task_id=NEW.id AND status IN ('waiting','matched') AND
 (NEW.status NOT IN ('todo','in_progress') OR NEW.assigned_agent_id IS DISTINCT FROM agent_id OR
 (NEW.execution_json->>'runId' IS DISTINCT FROM OLD.execution_json->>'runId' AND NEW.execution_json->>'runId' IS DISTINCT FROM source->>'runId'));
 RETURN NEW;
END $$;
CREATE TRIGGER task_workflow_wait_invalidation AFTER UPDATE OR DELETE ON task_board_tasks FOR EACH ROW EXECUTE FUNCTION burrow_invalidate_task_waits();
` },
  { version: 108, name: 'archive-run-occurrence-order-indexes', sql: `
-- Match the exact bytewise occurrence tiebreakers used by Archive cursors.
-- Existing published indexes/migrations stay unchanged.
CREATE INDEX conversation_archive_runs_occurrence_order_idx
 ON conversation_archive_runs(agent_id,sort_timestamp DESC,run_id COLLATE "C" DESC,session_id COLLATE "C" DESC);
CREATE INDEX conversation_archive_runs_session_occurrence_order_idx
 ON conversation_archive_runs(agent_id,session_id,sort_timestamp DESC,run_id COLLATE "C" DESC);
` },
  { version: 109, name: 'identity-deletion-lifecycle', sql: `
CREATE TABLE identity_deletion_events (
 event_id UUID PRIMARY KEY, agent_id TEXT NOT NULL, owner_mod_id TEXT, storage_reference TEXT, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, retry_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX identity_deletion_events_pending_idx ON identity_deletion_events(retry_at,deleted_at) WHERE state <> 'complete';
CREATE TABLE identity_deletion_recipients (
 event_id UUID NOT NULL REFERENCES identity_deletion_events(event_id) ON DELETE CASCADE,
 mod_id TEXT NOT NULL, acknowledged_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, retry_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(event_id,mod_id)
);
CREATE INDEX identity_deletion_recipients_pending_idx ON identity_deletion_recipients(mod_id,retry_at) WHERE acknowledged_at IS NULL;
CREATE TABLE identity_deletion_handlers (
 mod_id TEXT PRIMARY KEY, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE identity_deletion_reconciliation (
 agent_id TEXT PRIMARY KEY, event_id UUID NOT NULL UNIQUE REFERENCES identity_deletion_events(event_id) ON DELETE CASCADE,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
` },
  { version: 110, name: 'session-recall-provenance-and-exactness', sql: POSTGRES_SESSION_RECALL_RELEVANCE_SQL },
  { version: 111, name: 'generic-mod-minion-jobs', sql: POSTGRES_MOD_MINION_SCHEMA_SQL },
  { version: 112, name: 'generic-mod-follow-through-returns', sql: `
CREATE TABLE mod_follow_through_returns (
 id UUID PRIMARY KEY, owner_mod_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, reset_identity TEXT NOT NULL,
 origin_run_id TEXT NOT NULL, key TEXT NOT NULL, result JSON,
 state TEXT NOT NULL CHECK(state IN ('waiting','ready','delivering','delivered','fenced')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
 delivery_run_id TEXT, error TEXT, UNIQUE(owner_mod_id,agent_id,session_id,origin_run_id,key)
);
CREATE INDEX mod_follow_through_ready_idx ON mod_follow_through_returns(completed_at,id) WHERE state='ready';
` },
  { version: 113, name: 'native-workflow-follow-through-waits', sql: `
CREATE TABLE workflow_follow_through_waits (
 id UUID PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, session_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, reset_identity TEXT NOT NULL,
 repository TEXT NOT NULL, workflow TEXT NOT NULL, run_id TEXT NOT NULL, run_attempt INTEGER NOT NULL CHECK(run_attempt>0), head_sha TEXT NOT NULL,
 checkpoint TEXT NOT NULL CHECK(char_length(checkpoint) BETWEEN 1 AND 20000),
 source JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','matched','claimed','report_ready','delivered','continued','failed','fenced')),
 completion JSONB, result JSONB, error TEXT, execution_session_id TEXT, execution_run_id TEXT,
 registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), matched_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
 UNIQUE(agent_id,session_id,conversation_id,reset_identity,source,repository,workflow,run_id,run_attempt,head_sha)
);
CREATE INDEX workflow_follow_through_waits_target_idx ON workflow_follow_through_waits(repository,run_id,run_attempt) WHERE status='waiting';
CREATE INDEX workflow_follow_through_waits_ready_idx ON workflow_follow_through_waits(matched_at,id) WHERE status='matched';
CREATE INDEX workflow_follow_through_parent_idx ON workflow_follow_through_waits(agent_id,(source->>'handoffId')) WHERE source ? 'handoffId';
CREATE INDEX workflow_follow_through_reports_idx ON workflow_follow_through_waits(registered_at,id) WHERE status='report_ready';
` },
  { version: 114, name: 'mod-follow-through-wait-triggers', sql: `
ALTER TABLE mod_follow_through_returns ADD COLUMN wait_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workflow_follow_through_waits ALTER COLUMN repository DROP NOT NULL;
ALTER TABLE workflow_follow_through_waits ALTER COLUMN workflow DROP NOT NULL;
ALTER TABLE workflow_follow_through_waits ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE workflow_follow_through_waits ALTER COLUMN run_attempt DROP NOT NULL;
ALTER TABLE workflow_follow_through_waits ALTER COLUMN head_sha DROP NOT NULL;
ALTER TABLE workflow_follow_through_waits ADD COLUMN mod_return_id UUID REFERENCES mod_follow_through_returns(id) ON DELETE CASCADE;
ALTER TABLE workflow_follow_through_waits ADD CONSTRAINT workflow_follow_through_trigger_shape CHECK (
 (mod_return_id IS NULL AND repository IS NOT NULL AND workflow IS NOT NULL AND run_id IS NOT NULL AND run_attempt IS NOT NULL AND head_sha IS NOT NULL)
 OR (mod_return_id IS NOT NULL AND repository IS NULL AND workflow IS NULL AND run_id IS NULL AND run_attempt IS NULL AND head_sha IS NULL)
);
CREATE UNIQUE INDEX workflow_follow_through_mod_return_unique_idx ON workflow_follow_through_waits(mod_return_id) WHERE mod_return_id IS NOT NULL;
CREATE INDEX mod_follow_through_report_ready_idx ON mod_follow_through_returns(completed_at,id) WHERE state='ready' AND wait_only=false;
` },
  { version: 115, name: 'workflow-follow-through-runtime-activity', sql: `
ALTER TABLE workflow_follow_through_waits ADD COLUMN activity_progress JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX workflow_follow_through_activity_idx ON workflow_follow_through_waits(agent_id,session_id,conversation_id,reset_identity)
 WHERE status IN ('waiting','matched','claimed','report_ready');
` },
]);

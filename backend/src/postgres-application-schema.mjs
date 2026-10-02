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
import { POSTGRES_MOD_DISTRIBUTION_SCHEMA_SQL } from './postgres-mod-distribution-repository.mjs';
import { POSTGRES_MOD_SCHEMA_SQL } from './postgres-mod-store.mjs';
import { POSTGRES_AGENT_REGISTRY_SCHEMA_SQL } from './postgres-agent-registry.mjs';
import { POSTGRES_AGENT_PROFILE_SCHEMA_SQL } from './postgres-agent-profile-store.mjs';
import { POSTGRES_MODEL_SETTINGS_SCHEMA_SQL } from './postgres-model-settings-store.mjs';
import { POSTGRES_MCP_SETTINGS_SCHEMA_SQL } from './postgres-mcp-settings-store.mjs';
import { POSTGRES_TASK_BOARD_SCHEMA_SQL } from './postgres-task-board-store.mjs';
import { POSTGRES_SCHEDULED_JOB_SCHEMA_SQL } from './postgres-scheduled-job-store.mjs';
import { POSTGRES_DREAM_SETTINGS_SCHEMA_SQL } from './postgres-dream-settings-store.mjs';
import { POSTGRES_DREAM_DIARY_SCHEMA_SQL } from './postgres-dream-diary-store.mjs';
import { POSTGRES_DREAM_CYCLE_RECEIPT_SCHEMA_SQL } from './postgres-dream-cycle-receipt-store.mjs';
import { POSTGRES_CONTINUITY_HANDOFF_SCHEMA_SQL } from './postgres-continuity-handoff-store.mjs';
import { POSTGRES_FORGE_SCHEMA_SQL } from './postgres-forge-store.mjs';
import { POSTGRES_WORKING_MEMORY_SCHEMA_SQL } from './postgres-working-memory-store.mjs';
import { POSTGRES_API_TOKEN_SCHEMA_SQL } from './postgres-api-token-store.mjs';
import { POSTGRES_SKILL_SETTINGS_SCHEMA_SQL } from './postgres-skill-settings-store.mjs';
import { POSTGRES_SETUP_STATE_SCHEMA_SQL } from './postgres-setup-state-store.mjs';
import { POSTGRES_RETENTION_SETTINGS_SCHEMA_SQL } from './postgres-retention-settings-store.mjs';
import { POSTGRES_WORKING_MEMORY_RETENTION_SCHEMA_SQL } from './postgres-working-memory-retention-settings-store.mjs';
import { POSTGRES_SESSION_SCHEMA_SQL, POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL, POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL, POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL, POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL, POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL, POSTGRES_SESSION_SEARCH_SCHEMA_SQL, POSTGRES_SESSION_NATIVE_SCHEMA_SQL, POSTGRES_SESSION_METADATA_SCHEMA_SQL, POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL } from './postgres-session-store.mjs';
import { POSTGRES_UI_AUTH_SECRET_SCHEMA_SQL } from './postgres-ui-auth-secret-store.mjs';

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
]);

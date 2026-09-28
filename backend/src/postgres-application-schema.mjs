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
]);

import { POSTGRES_LOGICAL_MEMBER_SQL } from './postgres-lexical-identity.mjs';
import { POSTGRES_SESSION_METADATA_SCHEMA_SQL } from './postgres-session-store.mjs';

// Reuse the byte-linear, single-pass parser at the adopted execution boundary.
// Published migration SQL/checksums remain unchanged.
export const POSTGRES_LOGICAL_METADATA_LINEAR_SQL = POSTGRES_SESSION_METADATA_SCHEMA_SQL
 .slice(0, POSTGRES_SESSION_METADATA_SCHEMA_SQL.indexOf('ALTER TABLE conversation_entries'))
 .replace("key_text := convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8');", "key_text := burrow_history_key(convert_from(substring(s FROM key_start FOR i-key_start+1),'UTF8'));")
 .replace(/WHEN '"(id|role|type|visibility|content|metadata)"' THEN/g, (_, key) => `WHEN '${Buffer.from(key, 'utf16le').swap16().toString('hex')}' THEN`)
 .replace("IF slot > 0 AND result[slot] IS NOT NULL THEN slot := 0; END IF;", "IF slot = 6 THEN result[7] := NULL; END IF;")
 .replace("convert_from(substring(s FROM nested_key_start FOR i-nested_key_start+1),'UTF8') = '\"compressionSummary\"' AND result[7] IS NULL", "burrow_history_key(convert_from(substring(s FROM nested_key_start FOR i-nested_key_start+1),'UTF8')) = '0063006f006d007000720065007300730069006f006e00530075006d006d006100720079'");

// Distinguish keys from unrelated string values: otherwise every byte of a
// large string value is passed through the logical-key decoder.
export const POSTGRES_LOGICAL_MEMBER_LINEAR_SQL = POSTGRES_LOGICAL_MEMBER_SQL
 .slice(0, POSTGRES_LOGICAL_MEMBER_SQL.indexOf('CREATE OR REPLACE FUNCTION burrow_json_metadata'))
 .replace('key_start int := 0;', 'key_start int := 0; expecting_key boolean := true;')
 .replace('depth = 1 AND start_at IS NULL', 'depth = 1 AND expecting_key')
 .replace("ELSIF c = ':' AND depth = 1 THEN", "ELSIF c = ':' AND depth = 1 THEN expecting_key := false;")
 .replace("ELSIF c = ',' AND depth = 1 THEN", "ELSIF c = ',' AND depth = 1 THEN expecting_key := true;");

export async function applyLogicalMemberMigration(client, migration) {
 const boundary = migration.sql.indexOf('CREATE OR REPLACE FUNCTION burrow_json_metadata');
 const backfill = migration.sql.indexOf('UPDATE conversation_entries');
 if (boundary < 0 || backfill < boundary) throw new Error('unsupported logical member migration');
 await client.query(POSTGRES_LOGICAL_MEMBER_LINEAR_SQL + POSTGRES_LOGICAL_METADATA_LINEAR_SQL + migration.sql.slice(backfill));
}

// v83: a null decoded string key also includes id-less tool/receipt rows. The
// old scalar winner probe visited those rows for *every* Chat candidate before
// filtering has_payload_id. Keep that cold coercion branch on an exact partial
// index instead. Only lexical ID keys are inspected; retained payload bytes
// are neither decoded nor rewritten. IF NOT EXISTS also permits an operator
// to prebuild these identical indexes CONCURRENTLY before a running upgrade.
export const POSTGRES_ARCHIVE_DISCOVERY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS conversation_entries_scalar_payload_idx ON conversation_entries
 (agent_id,session_id,sequence)
 WHERE has_payload_id = true AND burrow_history_key(entry_key) IS NULL;
CREATE INDEX IF NOT EXISTS conversation_archive_entries_scalar_payload_idx ON conversation_archive_entries
 (agent_id,session_id,generation DESC,source_id DESC,ordinal)
 WHERE has_payload_id = true AND burrow_history_key(entry_key) IS NULL;
`;

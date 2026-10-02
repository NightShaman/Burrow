// Append through the migration ledger only; store initialization must not run DDL.
export const POSTGRES_FORGE_MCP_BOUNDARY_SCHEMA_SQL = `
DROP TRIGGER forge_native_fields ON forge_jobs;
DROP FUNCTION burrow_forge_native_fields();
ALTER TABLE forge_jobs DROP COLUMN status;
ALTER TABLE forge_jobs ADD COLUMN status TEXT GENERATED ALWAYS AS (record->>'status') STORED;
CREATE INDEX forge_jobs_status_ordinal ON forge_jobs(status,ordinal DESC);
CREATE INDEX forge_jobs_agent_status_ordinal ON forge_jobs(agent_id,status,ordinal DESC);
CREATE TABLE mcp_provider_current (
 provider_id TEXT PRIMARY KEY,
 event JSON NOT NULL
);
INSERT INTO mcp_provider_current(provider_id,event)
 SELECT DISTINCT ON (event->>'providerId') event->>'providerId',event
 FROM mcp_provider_events WHERE event->>'providerId' IS NOT NULL
 ORDER BY event->>'providerId',sequence DESC;
`;

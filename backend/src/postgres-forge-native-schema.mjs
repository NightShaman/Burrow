// Append-only successor to the immutable v1 Forge schema.
// Colliding legacy keys remain distinct jobs; the claim table reserves their
// shared identity without imposing a destructive unique constraint on history.
export const POSTGRES_FORGE_NATIVE_SCHEMA_SQL = `
ALTER TABLE forge_jobs ADD COLUMN status TEXT;
UPDATE forge_jobs SET status=record->>'status';
CREATE INDEX forge_jobs_status_ordinal ON forge_jobs(status,ordinal DESC);
CREATE INDEX forge_jobs_idem_ordinal ON forge_jobs(idem,ordinal);
CREATE TABLE forge_idempotency_claims (
 idem TEXT PRIMARY KEY,
 first_job_id TEXT NOT NULL REFERENCES forge_jobs(id)
);
INSERT INTO forge_idempotency_claims(idem,first_job_id)
 SELECT DISTINCT ON (idem) idem,id FROM forge_jobs ORDER BY idem,ordinal ASC,id;
CREATE FUNCTION burrow_forge_native_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.status := NEW.record->>'status';
 RETURN NEW;
END $$;
CREATE TRIGGER forge_native_fields BEFORE INSERT OR UPDATE OF record ON forge_jobs
 FOR EACH ROW EXECUTE FUNCTION burrow_forge_native_fields();
`;

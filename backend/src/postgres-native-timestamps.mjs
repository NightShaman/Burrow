/** Migration 34: native instants and durable, non-runtime agent identities. */
export const POSTGRES_NATIVE_TIMESTAMPS_SQL = `
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE burrow_timestamp_views ON COMMIT DROP AS
 SELECT viewname,definition FROM pg_views WHERE schemaname=current_schema()
 AND viewname='conversation_original_rows';
DROP VIEW IF EXISTS conversation_original_rows;

CREATE TABLE legacy_timestamp_values (
 table_name text NOT NULL, column_name text NOT NULL, row_identity json NOT NULL,
 original_value text NOT NULL, reason text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION burrow_legacy_instant(value text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
BEGIN
 -- Only unambiguous ISO dates/instants are promoted. Relative words such as
 -- 'now' must not silently become the migration execution time.
 IF value !~ '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}(:?\\d{2})?)?)?$' THEN RETURN NULL; END IF;
 RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT table_name,column_name FROM information_schema.columns
 WHERE table_schema=current_schema() AND data_type='text'
 AND (column_name LIKE '%\\_at' ESCAPE '\\' OR column_name='timestamp')
 AND table_name <> 'legacy_timestamp_values'
 AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname=current_schema()) LOOP
 EXECUTE format('INSERT INTO legacy_timestamp_values(table_name,column_name,row_identity,original_value,reason) SELECT %L,%L,row_to_json(t),%I,''invalid or ambiguous legacy timestamp'' FROM %I t WHERE %I IS NOT NULL AND burrow_legacy_instant(%I) IS NULL',c.table_name,c.column_name,c.column_name,c.table_name,c.column_name,c.column_name);
 -- Invalid values remain recoverable verbatim, with the complete original row
 -- identity; NULL is explicitly unknown, never a manufactured instant.
 EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT, ALTER COLUMN %I DROP NOT NULL',c.table_name,c.column_name,c.column_name);
 EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING burrow_legacy_instant(%I)',c.table_name,c.column_name,c.column_name);
 END LOOP;
END $$;
DROP FUNCTION burrow_legacy_instant(text);
DO $$ DECLARE v record; BEGIN
 FOR v IN SELECT * FROM burrow_timestamp_views LOOP
 EXECUTE format('CREATE VIEW %I AS %s',v.viewname,v.definition);
 END LOOP;
END $$;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_enabled_check;
-- This registry is identity authority, not the executable agents catalog.
-- Historical identities remain valid even after their runtime agent is removed.
CREATE TABLE agent_identity_registry (
 agent_id text PRIMARY KEY,
 archived boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO agent_identity_registry(agent_id,archived) SELECT id,false FROM agents;
-- Forge operator-owned work has a real durable non-agent principal identity.
INSERT INTO agent_identity_registry(agent_id,archived) VALUES('__operator__',false) ON CONFLICT DO NOTHING;
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT table_name FROM information_schema.columns
 WHERE table_schema=current_schema() AND column_name='agent_id'
 AND table_name <> 'agent_identity_registry'
 AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname=current_schema()) LOOP
 EXECUTE format('INSERT INTO agent_identity_registry(agent_id,archived) SELECT DISTINCT agent_id,true FROM %I WHERE agent_id IS NOT NULL ON CONFLICT DO NOTHING',c.table_name);
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(agent_id) REFERENCES agent_identity_registry(agent_id)',c.table_name,c.table_name || '_agent_identity_fk');
 END LOOP;
END $$;
CREATE FUNCTION burrow_register_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_identity_registry(agent_id,archived) VALUES(NEW.id,false)
 ON CONFLICT(agent_id) DO UPDATE SET archived=false;
 RETURN NEW;
END $$;
CREATE TRIGGER agents_register_identity AFTER INSERT OR UPDATE OF id ON agents
 FOR EACH ROW EXECUTE FUNCTION burrow_register_agent_identity();
CREATE FUNCTION burrow_archive_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE agent_identity_registry SET archived=true WHERE agent_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER agents_archive_identity AFTER DELETE ON agents
 FOR EACH ROW EXECUTE FUNCTION burrow_archive_agent_identity();
`;

import { archiveOccurrenceTokenSQL, archiveVisibleMessageSQL } from './postgres-archive-lexical.mjs';

// v82 is a schema migration, not a payload migration. Retained rows start
// pending and are indexed in small transactions by postgres-archive-chat-backfill.
// New/updated originals are projected by the BEFORE trigger. Neither path
// rewrites legacy JSON or relaxes the NOT VALID legacy timestamp checks.
const token = archiveOccurrenceTokenSQL('p');
const visible = archiveVisibleMessageSQL('p');
export const POSTGRES_ARCHIVE_CHAT_PROJECTION_SQL = `
ALTER TABLE conversation_entries ADD COLUMN archive_chat_visible boolean;
ALTER TABLE conversation_entries ADD COLUMN archive_chat_at timestamptz;
ALTER TABLE conversation_entries ADD COLUMN archive_chat_projected boolean NOT NULL DEFAULT false;
ALTER TABLE conversation_archive_entries ADD COLUMN archive_chat_visible boolean;
ALTER TABLE conversation_archive_entries ADD COLUMN archive_chat_at timestamptz;
ALTER TABLE conversation_archive_entries ADD COLUMN archive_chat_projected boolean NOT NULL DEFAULT false;
CREATE FUNCTION burrow_archive_chat_projection(payload json, search_projection text)
 RETURNS TABLE(visible boolean,instant timestamptz) LANGUAGE sql STABLE AS $chat$
 SELECT COALESCE((${visible}),false),
   CASE WHEN json_typeof((${token})::json)='string' THEN burrow_archive_instant((${token})::json) END
 FROM (SELECT burrow_archive_fields(payload) AS fields,search_projection OFFSET 0) p
$chat$;
CREATE FUNCTION burrow_project_archive_chat() RETURNS trigger LANGUAGE plpgsql AS $chat$
BEGIN
 -- The backfill locks the authority row before writing its side projection.
 -- Delete it in this same row update, before a possible primary-key cascade.
 IF TG_OP='UPDATE' AND NOT OLD.archive_chat_projected THEN
  IF TG_TABLE_NAME='conversation_entries' THEN
   DELETE FROM conversation_live_chat_grandfathered WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id AND sequence=OLD.sequence;
  ELSE
   DELETE FROM conversation_archive_chat_grandfathered WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id
    AND source_store=OLD.source_store AND source_id=OLD.source_id AND ordinal=OLD.ordinal;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.archive_chat_projected AND NEW.entry::text IS NOT DISTINCT FROM OLD.entry::text
   AND NEW.search_projection IS NOT DISTINCT FROM OLD.search_projection THEN
  NEW.archive_chat_projected := true; NEW.archive_chat_visible := OLD.archive_chat_visible; NEW.archive_chat_at := OLD.archive_chat_at;
 ELSE
  SELECT p.visible,p.instant INTO NEW.archive_chat_visible,NEW.archive_chat_at
   FROM burrow_archive_chat_projection(NEW.entry,COALESCE(NEW.search_projection,burrow_json_member(NEW.entry,'content')::text,'')) p;
  NEW.archive_chat_projected := true;
 END IF;
 RETURN NEW;
END $chat$;
CREATE TRIGGER burrow_zz_archive_chat BEFORE INSERT OR UPDATE ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_archive_chat();
CREATE TRIGGER burrow_zz_archive_chat BEFORE INSERT OR UPDATE ON conversation_archive_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_archive_chat();
-- The same side tables serve *all* v81 pending rows, including rows whose
-- created_at is NULL. They contain no payload bytes. Parent row locks serialize
-- inserts with updates; FK actions remove projections on DELETE/identity change.
CREATE TABLE conversation_live_chat_grandfathered (
 agent_id text NOT NULL,session_id text NOT NULL,sequence bigint NOT NULL,
 visible boolean NOT NULL,instant timestamptz,
 PRIMARY KEY(agent_id,session_id,sequence),
 FOREIGN KEY(agent_id,session_id,sequence)
  REFERENCES conversation_entries(agent_id,session_id,sequence) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX conversation_live_grandfathered_chat_window ON conversation_live_chat_grandfathered(agent_id,instant,session_id) WHERE visible AND instant IS NOT NULL;
CREATE TABLE conversation_archive_chat_grandfathered (
 agent_id text NOT NULL,session_id text NOT NULL,source_store text NOT NULL,source_id text NOT NULL,ordinal bigint NOT NULL,
 visible boolean NOT NULL,instant timestamptz,
 PRIMARY KEY(agent_id,session_id,source_store,source_id,ordinal),
 FOREIGN KEY(agent_id,session_id,source_store,source_id,ordinal)
  REFERENCES conversation_archive_entries(agent_id,session_id,source_store,source_id,ordinal) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX conversation_archive_grandfathered_chat_window ON conversation_archive_chat_grandfathered(agent_id,instant,session_id) WHERE visible AND instant IS NOT NULL;

-- Durable exclusive high-water keys over the existing primary-key indexes.
-- Everything at or below each key is either in the side table, projected by a
-- normal writer, or has been deleted. New inserts are always projected. Do not
-- advance a key across a locked row; the worker retries with a lock timeout.
CREATE TABLE burrow_archive_chat_backfill (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 live_done boolean NOT NULL DEFAULT false, archive_done boolean NOT NULL DEFAULT false,
 live_agent text,live_session text,live_sequence bigint,
 archive_agent text,archive_session text,archive_store text,archive_source text,archive_ordinal bigint
);
INSERT INTO burrow_archive_chat_backfill(id,live_done,archive_done)
 SELECT true,NOT EXISTS(SELECT 1 FROM conversation_entries),
  NOT EXISTS(SELECT 1 FROM conversation_archive_entries);
-- Partial indexes are built on the original tables: PostgreSQL must inspect
-- existing heap tuples and can wait for ordinary DDL/table locks. No retained
-- entry bodies are parsed or rewritten during this migration.
CREATE INDEX conversation_live_archive_chat_window ON conversation_entries(agent_id,archive_chat_at,session_id)
 WHERE archive_chat_projected AND archive_chat_visible AND archive_chat_at IS NOT NULL;
CREATE INDEX conversation_archive_chat_window ON conversation_archive_entries(agent_id,archive_chat_at,session_id)
 WHERE archive_chat_projected AND archive_chat_visible AND archive_chat_at IS NOT NULL;

CREATE INDEX conversation_archive_entries_unknown_payload_idx ON conversation_archive_entries(agent_id,session_id,source_id,ordinal) WHERE has_payload_id IS NULL;
CREATE INDEX conversation_entries_unknown_payload_idx ON conversation_entries(agent_id,session_id,sequence) WHERE has_payload_id IS NULL;

-- A source-scoped transactional version: live rows, compact snapshots and reset
-- snapshots are independent. Statement
-- transition tables dedupe batches, so one append/copy is O(new sources), not
-- O(retained history), and rolled-back writes leave no observable version.
CREATE SEQUENCE burrow_archive_revision_seq AS bigint;
-- TRUNCATE has no row transition tables. Rotate a global scalar for this rare
-- operation; never reset it to zero, so a repopulated scope cannot revive a cursor.
CREATE TABLE conversation_archive_revision_epoch (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL);
INSERT INTO conversation_archive_revision_epoch(singleton,revision) VALUES(true,nextval('burrow_archive_revision_seq'));
CREATE FUNCTION burrow_archive_revision_truncate() RETURNS trigger LANGUAGE plpgsql AS $chat$
BEGIN
 UPDATE conversation_archive_revision_epoch SET revision=nextval('burrow_archive_revision_seq') WHERE singleton;
 IF TG_TABLE_NAME='conversation_entries' THEN DELETE FROM conversation_live_chat_grandfathered;
 ELSIF TG_TABLE_NAME IN ('conversation_archive_entries','conversation_archives') THEN DELETE FROM conversation_archive_chat_grandfathered;
 END IF; RETURN NULL;
END $chat$;
CREATE TRIGGER burrow_archive_live_truncate AFTER TRUNCATE ON conversation_entries FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_truncate();
CREATE TRIGGER burrow_archive_entry_truncate AFTER TRUNCATE ON conversation_archive_entries FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_truncate();
CREATE TRIGGER burrow_archive_catalog_truncate AFTER TRUNCATE ON conversation_archives FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_truncate();
CREATE TABLE conversation_archive_revisions (
 agent_id text NOT NULL,session_id text NOT NULL,scope text NOT NULL,source_id text NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('burrow_archive_revision_seq'),
 PRIMARY KEY(agent_id,session_id,scope,source_id)
);
CREATE FUNCTION burrow_bump_archive_revision(a text,s text,k text,i text) RETURNS void LANGUAGE sql AS $chat$
 INSERT INTO conversation_archive_revisions(agent_id,session_id,scope,source_id,revision)
 VALUES(a,s,k,i,nextval('burrow_archive_revision_seq'))
 ON CONFLICT(agent_id,session_id,scope,source_id) DO UPDATE SET revision=nextval('burrow_archive_revision_seq')
$chat$;
CREATE FUNCTION burrow_archive_revision_live() RETURNS trigger LANGUAGE plpgsql AS $chat$
DECLARE x record;
BEGIN
 FOR x IN EXECUTE CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT agent_id,session_id FROM new_rows ORDER BY agent_id,session_id'
 WHEN 'DELETE' THEN 'SELECT DISTINCT agent_id,session_id FROM old_rows ORDER BY agent_id,session_id'
 ELSE 'SELECT agent_id,session_id FROM new_rows UNION SELECT agent_id,session_id FROM old_rows ORDER BY agent_id,session_id' END LOOP
  PERFORM burrow_bump_archive_revision(x.agent_id,x.session_id,'live','');
 END LOOP; RETURN NULL;
END $chat$;
CREATE FUNCTION burrow_archive_revision_entry() RETURNS trigger LANGUAGE plpgsql AS $chat$
DECLARE x record;
BEGIN
 FOR x IN EXECUTE CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT agent_id,session_id,source_id FROM new_rows ORDER BY agent_id,session_id,source_id'
 WHEN 'DELETE' THEN 'SELECT DISTINCT agent_id,session_id,source_id FROM old_rows ORDER BY agent_id,session_id,source_id'
 ELSE 'SELECT agent_id,session_id,source_id FROM new_rows UNION SELECT agent_id,session_id,source_id FROM old_rows ORDER BY agent_id,session_id,source_id' END LOOP
  PERFORM burrow_bump_archive_revision(x.agent_id,x.session_id,'source',x.source_id);
 END LOOP; RETURN NULL;
END $chat$;
CREATE FUNCTION burrow_archive_revision_catalog() RETURNS trigger LANGUAGE plpgsql AS $chat$
DECLARE x record;
BEGIN
 FOR x IN EXECUTE CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT agent_id,session_id,archive_id,kind FROM new_rows ORDER BY agent_id,session_id,archive_id,kind'
 WHEN 'DELETE' THEN 'SELECT DISTINCT agent_id,session_id,archive_id,kind FROM old_rows ORDER BY agent_id,session_id,archive_id,kind'
 ELSE 'SELECT agent_id,session_id,archive_id,kind FROM new_rows UNION SELECT agent_id,session_id,archive_id,kind FROM old_rows ORDER BY agent_id,session_id,archive_id,kind' END LOOP
  PERFORM burrow_bump_archive_revision(x.agent_id,x.session_id,'source',x.archive_id);
 END LOOP; RETURN NULL;
END $chat$;
CREATE TRIGGER burrow_archive_live_insert AFTER INSERT ON conversation_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_live();
CREATE TRIGGER burrow_archive_live_update AFTER UPDATE ON conversation_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_live();
CREATE TRIGGER burrow_archive_live_delete AFTER DELETE ON conversation_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_live();
CREATE TRIGGER burrow_archive_entry_insert AFTER INSERT ON conversation_archive_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_entry();
CREATE TRIGGER burrow_archive_entry_update AFTER UPDATE ON conversation_archive_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_entry();
CREATE TRIGGER burrow_archive_entry_delete AFTER DELETE ON conversation_archive_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_entry();
CREATE TRIGGER burrow_archive_catalog_insert AFTER INSERT ON conversation_archives REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_catalog();
CREATE TRIGGER burrow_archive_catalog_update AFTER UPDATE ON conversation_archives REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_catalog();
CREATE TRIGGER burrow_archive_catalog_delete AFTER DELETE ON conversation_archives REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION burrow_archive_revision_catalog();
INSERT INTO conversation_archive_revisions(agent_id,session_id,scope,source_id)
 SELECT agent_id,session_id,'live','' FROM conversation_sessions
 UNION SELECT agent_id,session_id,'source',archive_id FROM conversation_archives
;
`;

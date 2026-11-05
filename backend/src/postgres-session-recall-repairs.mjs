import { POSTGRES_EVENT_OPERATOR_PROJECTION_SQL } from './postgres-event-operator-projection.mjs';
// Append-only v95: v93/v94 have published migration checksums. This replaces
// trigger wiring and adds a distinct, unambiguous eight-argument copy overload.
// No historical source scan or source row rewrite is performed.
export const POSTGRES_SESSION_RECALL_REPAIRS_SQL = String.raw`
-- Legacy source rows can have a grandfathered NULL storage clock. The derived
-- row must preserve it rather than requiring a fabricated timestamp.
ALTER TABLE conversation_recall_rows ALTER COLUMN created_at DROP NOT NULL;

CREATE FUNCTION burrow_recall_project_cached(agent text,session text,id text,identity_token text,payload json,
 store text,archive_kind text,source_ordinal bigint) RETURNS TABLE(
 haystack text,content_key text,grams text[],rank_weight int,role text,summary boolean,eligible boolean,
 ts_key text,entry_at timestamptz,ts_fallback text,logical_key text)
LANGUAGE plpgsql STABLE AS $recall$
DECLARE cached conversation_recall_rows%ROWTYPE;
BEGIN
 -- Reset copies source sequence into archive ordinal, even for duplicate/NULL
 -- payload IDs. Verify the exact lexical bytes before trusting the projection.
 IF store='archive' AND archive_kind='reset' THEN
  SELECT p.* INTO cached FROM conversation_entries e JOIN conversation_recall_rows p
   ON p.agent_id=e.agent_id AND p.session_id=e.session_id AND p.source_store='live'
    AND p.source_id=e.sequence::text AND p.ordinal=e.sequence
   WHERE e.agent_id=agent AND e.session_id=session AND e.sequence=source_ordinal
    AND e.entry::text=payload::text;
 END IF;
 IF cached.agent_id IS NOT NULL THEN
  RETURN QUERY SELECT cached.haystack,cached.content_key,cached.grams,cached.rank_weight,cached.role,cached.summary,cached.eligible,
   cached.ts_key,cached.entry_at,cached.ts_fallback,cached.logical_key;
 ELSE
  -- The published five-argument overload is still used by backfill and
  -- provides the existing identity-copy and parser fallback for non-resets.
  RETURN QUERY SELECT p.haystack,p.content_key,p.grams,p.rank_weight,p.role,p.summary,p.eligible,
   p.ts_key,p.entry_at,p.ts_fallback,p.logical_key
   FROM burrow_recall_project_cached(agent,session,id,identity_token,payload) p;
 END IF;
END $recall$;
CREATE OR REPLACE FUNCTION burrow_sync_recall_rows() RETURNS trigger LANGUAGE plpgsql AS $recall$
DECLARE live boolean := TG_TABLE_NAME='conversation_entries'; sid text; ord bigint; old_sid text; old_ord bigint; kind text; gen bigint; cached conversation_recall_rows%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF live THEN old_sid:=OLD.sequence::text; old_ord:=OLD.sequence; ELSE old_sid:=OLD.source_id; old_ord:=OLD.ordinal; END IF;
  IF TG_OP='UPDATE' AND NEW.entry::text IS NOT DISTINCT FROM OLD.entry::text THEN
   SELECT * INTO cached FROM conversation_recall_rows WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id
    AND source_store=CASE WHEN live THEN 'live' ELSE 'archive' END AND source_id=old_sid AND ordinal=old_ord;
  END IF;
  DELETE FROM conversation_recall_rows WHERE agent_id=OLD.agent_id AND session_id=OLD.session_id
   AND source_store=CASE WHEN live THEN 'live' ELSE 'archive' END AND source_id=old_sid AND ordinal=old_ord;
 END IF;
 IF live THEN sid:=NEW.sequence::text; ord:=NEW.sequence; ELSE sid:=NEW.source_id; ord:=NEW.ordinal; kind:=NEW.archive_kind; gen:=NEW.generation; END IF;
 IF cached.agent_id IS NOT NULL THEN
  cached.agent_id:=NEW.agent_id; cached.session_id:=NEW.session_id;
  cached.source_store:=CASE WHEN live THEN 'live' ELSE 'archive' END;
  cached.source_id:=sid; cached.ordinal:=ord; cached.entry_key:=NEW.entry_key;
  cached.archive_kind:=kind; cached.generation:=gen; cached.created_at:=NEW.created_at::timestamptz;
  INSERT INTO conversation_recall_rows SELECT cached.*;
  RETURN NULL;
 END IF;
 INSERT INTO conversation_recall_rows
  SELECT NEW.agent_id,NEW.session_id,CASE WHEN live THEN 'live' ELSE 'archive' END,sid,ord,
   NEW.entry_key,p.logical_key,kind,gen,NEW.created_at::timestamptz,
   p.haystack,p.content_key,p.grams,p.rank_weight,p.role,p.summary,p.eligible,p.ts_key,p.entry_at,p.ts_fallback
  FROM burrow_recall_project_cached(NEW.agent_id,NEW.session_id,NEW.entry_id,NEW.entry_key,NEW.entry,
    CASE WHEN live THEN 'live' ELSE 'archive' END,kind,ord) p
  ON CONFLICT DO NOTHING;
 RETURN NULL;
END $recall$;

-- Bulk reset deletion of derived keys uses a single statement, not 6k SPI
-- deletes. Drop only v93 recall row triggers; all other triggers are untouched.
DROP TRIGGER burrow_recall_rows ON conversation_entries;
DROP TRIGGER burrow_recall_rows ON conversation_archive_entries;
CREATE TRIGGER burrow_recall_rows AFTER INSERT OR UPDATE ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_sync_recall_rows();
CREATE TRIGGER burrow_recall_rows AFTER INSERT OR UPDATE ON conversation_archive_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_sync_recall_rows();
CREATE FUNCTION burrow_sync_recall_deletes() RETURNS trigger LANGUAGE plpgsql AS $recall$
BEGIN
 IF TG_TABLE_NAME='conversation_entries' THEN
  DELETE FROM conversation_recall_rows p USING removed e
   WHERE p.agent_id=e.agent_id AND p.session_id=e.session_id AND p.source_store='live'
     AND p.source_id=e.sequence::text AND p.ordinal=e.sequence;
 ELSE
  DELETE FROM conversation_recall_rows p USING removed e
   WHERE p.agent_id=e.agent_id AND p.session_id=e.session_id AND p.source_store='archive'
     AND p.source_id=e.source_id AND p.ordinal=e.ordinal;
 END IF;
 RETURN NULL;
END $recall$;
CREATE TRIGGER burrow_recall_rows_delete AFTER DELETE ON conversation_entries
 REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION burrow_sync_recall_deletes();
CREATE TRIGGER burrow_recall_rows_delete AFTER DELETE ON conversation_archive_entries
 REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION burrow_sync_recall_deletes();

-- The operator instant already travels with copied native rows. Preserve even
-- a completed NULL result; ordinary app inserts omit the marker and reparse.
${POSTGRES_EVENT_OPERATOR_PROJECTION_SQL}

-- Dream has no completed marker. Only a verified reset source occurrence may
-- transfer its computed instant, including known NULL. Updates and ordinary
-- inserts still use the published parser; do not reinterpret old source rows.
CREATE OR REPLACE FUNCTION burrow_project_dream_instant() RETURNS trigger LANGUAGE plpgsql AS $repair$
BEGIN
 IF TG_OP='INSERT' AND TG_TABLE_NAME='conversation_archive_entries' THEN
  IF NEW.source_store='archive' AND NEW.archive_kind='reset' THEN
   SELECT e.dream_at INTO NEW.dream_at FROM conversation_entries e
    WHERE e.agent_id=NEW.agent_id AND e.session_id=NEW.session_id AND e.sequence=NEW.ordinal
     AND e.entry::text=NEW.entry::text AND e.created_at IS NOT DISTINCT FROM NEW.created_at;
   IF FOUND THEN RETURN NEW; END IF;
  END IF;
 END IF;
 NEW.dream_at := burrow_dream_instant(NEW.entry,NEW.created_at::text);
 RETURN NEW;
END $repair$;
`;

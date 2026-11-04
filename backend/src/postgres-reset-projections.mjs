// Append-only: reuse completed chat projections when copying unchanged originals.
// No payload scans or rewrites; ordinary inserts and updates keep v82 semantics.
export const POSTGRES_RESET_PROJECTIONS_SQL = `
CREATE OR REPLACE FUNCTION burrow_project_archive_chat() RETURNS trigger LANGUAGE plpgsql AS $chat$
BEGIN
 -- Original occurrence copies may carry a completed projection, including
 -- a known NULL instant. New payloads omit the marker and are still projected.
 IF TG_OP='INSERT' AND NEW.archive_chat_projected THEN RETURN NEW; END IF;
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
`;

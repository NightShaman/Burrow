// Append-only: authoritative occurrence copies may supply complete projections.
// Ordinary app INSERTs omit the markers and still project their new payloads.
export const POSTGRES_COMPACTION_PROJECTIONS_SQL = String.raw`
CREATE OR REPLACE FUNCTION burrow_project_native_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tokens json[];
BEGIN
 IF TG_OP = 'INSERT' AND NEW.has_payload_id IS NOT NULL
 AND NEW.has_compression_summary IS NOT NULL AND NEW.search_projection IS NOT NULL
 AND (NEW.entry_key IS NOT NULL OR
      (TG_TABLE_NAME = 'conversation_archive_entries' AND NEW.entry_id IS NULL AND NOT NEW.has_payload_id)) THEN
  -- search_grams NULL is a complete conservative fallback, not missing data.
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF OLD.has_payload_id IS NOT NULL AND NEW.entry::text IS NOT DISTINCT FROM OLD.entry::text THEN
   NEW.has_payload_id := OLD.has_payload_id;
   NEW.has_compression_summary := OLD.has_compression_summary;
   NEW.search_projection := OLD.search_projection;
   NEW.search_grams := OLD.search_grams;
   IF TG_TABLE_NAME = 'conversation_entries' THEN
    IF OLD.has_payload_id THEN NEW.entry_key := OLD.entry_key;
    ELSE NEW.entry_key := to_json(NEW.entry_id)::text; END IF;
   ELSE NEW.entry_key := OLD.entry_key; END IF;
   RETURN NEW;
  END IF;
 END IF;
 tokens := burrow_json_metadata(NEW.entry);
 NEW.has_payload_id := tokens[1] IS NOT NULL;
 NEW.entry_key := tokens[1]::text;
 IF TG_TABLE_NAME = 'conversation_entries' OR NEW.entry_id IS NOT NULL THEN
  NEW.entry_key := COALESCE(NEW.entry_key,to_json(NEW.entry_id)::text);
 END IF;
 NEW.search_projection := COALESCE(tokens[5]::text,'');
 NEW.has_compression_summary := tokens[7] IS NOT NULL;
 NEW.search_grams := burrow_entry_search_grams(NEW.entry);
 RETURN NEW;
END $$;
-- v48's bounded execution adapter already installs this marker; direct schema
-- fixtures use the published v48 SQL without that adapter. Support both paths.
-- If absent, v48 completed projection synchronously: grandfather those rows
-- with a constant default (no payload scan or table rewrite). Existing adapter
-- columns retain their pending/complete markers. Future ordinary INSERTs project.
ALTER TABLE conversation_entries ADD COLUMN IF NOT EXISTS operator_projected boolean NOT NULL DEFAULT true;
ALTER TABLE conversation_archive_entries ADD COLUMN IF NOT EXISTS operator_projected boolean NOT NULL DEFAULT true;
ALTER TABLE conversation_entries ALTER COLUMN operator_projected SET DEFAULT false;
ALTER TABLE conversation_archive_entries ALTER COLUMN operator_projected SET DEFAULT false;
CREATE OR REPLACE FUNCTION burrow_project_operator_instant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' AND NEW.operator_projected THEN RETURN NEW; END IF;
 SELECT at,fallback INTO NEW.operator_at,NEW.operator_ts_fallback FROM burrow_operator_projection(NEW.entry);
 NEW.operator_projected := true;
 RETURN NEW;
END $$;
`;

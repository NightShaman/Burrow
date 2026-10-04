// Unknown legacy dates remain candidates: JS eligibility is authoritative.
export const POSTGRES_DREAM_WINDOW_SQL = `
CREATE FUNCTION burrow_dream_instant(payload json, stored text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE token json; value text;
BEGIN
 token := COALESCE(NULLIF(burrow_json_member(payload,'timestamp')::text,'null')::json,
   NULLIF(burrow_json_member(payload,'ts')::text,'null')::json,
   NULLIF(burrow_json_member(payload,'at')::text,'null')::json,
   NULLIF(burrow_json_member(payload,'createdAt')::text,'null')::json);
 value := CASE WHEN token IS NULL THEN stored ELSE token #>> '{}' END;
 -- JS parses bare dates as UTC; ambiguous offset-free date-times bypass SQL.
 IF value ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN value := value || 'T00:00:00Z';
 ELSIF value !~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN RETURN NULL; END IF;
 RETURN burrow_legacy_instant(value);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
ALTER TABLE conversation_entries ADD COLUMN dream_at timestamptz;
ALTER TABLE conversation_archive_entries ADD COLUMN dream_at timestamptz;
CREATE FUNCTION burrow_project_dream_instant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.dream_at := burrow_dream_instant(NEW.entry,NEW.created_at::text); RETURN NEW; END $$;
CREATE TRIGGER burrow_dream_instant BEFORE INSERT OR UPDATE OF entry,created_at ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_dream_instant();
CREATE TRIGGER burrow_dream_instant BEFORE INSERT OR UPDATE OF entry,created_at ON conversation_archive_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_dream_instant();
-- NOT VALID required-instant checks still reject updates of grandfathered NULLs.
-- Leave those historical rows as unknown candidates; do not mutate provenance.
UPDATE conversation_entries SET dream_at=burrow_dream_instant(entry,created_at::text) WHERE created_at IS NOT NULL;
UPDATE conversation_archive_entries SET dream_at=burrow_dream_instant(entry,created_at::text) WHERE created_at IS NOT NULL;
CREATE INDEX conversation_live_dream_window ON conversation_entries(agent_id,dream_at,session_id);
CREATE INDEX conversation_archive_dream_window ON conversation_archive_entries(agent_id,dream_at,session_id);
`;

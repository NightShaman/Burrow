// Append-only projection on native occurrence tables, never the compatibility view.
// ts is the operator clock; storage/import/archive dates are not substitutes.
export const POSTGRES_OPERATOR_INSTANT_SQL = `
CREATE FUNCTION burrow_operator_projection(payload json) RETURNS TABLE(at timestamptz, fallback text)
LANGUAGE plpgsql STABLE AS $$
DECLARE token json; value text; metadata json;
BEGIN
 IF burrow_history_key(burrow_json_member(payload,'type')::text) IS DISTINCT FROM burrow_history_text('message')
 OR burrow_history_key(burrow_json_member(payload,'role')::text) IS DISTINCT FROM burrow_history_text('user') THEN RETURN; END IF;
 metadata := burrow_json_member(payload,'metadata');
 IF burrow_history_key(burrow_json_member(metadata,'source')::text) = burrow_history_text('scheduled') THEN RETURN; END IF;
 -- Compare decoded UTF-16 keys without decoding arbitrary NUL/surrogate strings.
 IF starts_with(burrow_history_key(burrow_json_member(payload,'runId')::text),burrow_history_text('scheduled-')) THEN RETURN; END IF;
 token := burrow_json_member(payload,'ts');
 IF token IS NULL THEN RETURN; END IF;
 fallback := token::text;
 IF json_typeof(token) = 'null' THEN at := '1970-01-01T00:00:00Z'::timestamptz; fallback := NULL;
 ELSIF json_typeof(token) = 'number' THEN
  IF abs(token::text::numeric) <= 8640000000000000 THEN
   BEGIN
    at := '1970-01-01T00:00:00Z'::timestamptz + trunc(token::text::numeric) * interval '1 millisecond'; fallback := NULL;
   EXCEPTION WHEN datetime_field_overflow OR numeric_value_out_of_range THEN at := NULL;
   END;
  ELSE fallback := NULL; END IF;
 ELSIF json_typeof(token) = 'string' THEN
  BEGIN value := token #>> '{}'; EXCEPTION WHEN OTHERS THEN value := NULL; END;
  IF value ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN value := value || 'T00:00:00Z'; END IF;
  -- Only canonical, explicit-zone instants take the fast path. Legacy date
  -- strings retain ECMAScript parsing in the small scalar-only fallback.
  IF value ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$' THEN
   at := burrow_legacy_instant(value);
   IF at IS NOT NULL THEN fallback := NULL; END IF;
  END IF;
 END IF;
 RETURN NEXT;
END $$;
ALTER TABLE conversation_entries ADD COLUMN operator_at timestamptz;
ALTER TABLE conversation_entries ADD COLUMN operator_ts_fallback text;
ALTER TABLE conversation_archive_entries ADD COLUMN operator_at timestamptz;
ALTER TABLE conversation_archive_entries ADD COLUMN operator_ts_fallback text;
CREATE FUNCTION burrow_project_operator_instant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT at,fallback INTO NEW.operator_at,NEW.operator_ts_fallback FROM burrow_operator_projection(NEW.entry);
 RETURN NEW;
END $$;
CREATE TRIGGER burrow_operator_instant BEFORE INSERT OR UPDATE OF entry ON conversation_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_operator_instant();
CREATE TRIGGER burrow_operator_instant BEFORE INSERT OR UPDATE OF entry ON conversation_archive_entries
 FOR EACH ROW EXECUTE FUNCTION burrow_project_operator_instant();
-- Transactional migration holds out writers while temporarily suspending only
-- grandfathered required-instant checks. Restore the exact NOT VALID contract
-- after projection backfill; payload and provenance remain untouched.
LOCK TABLE conversation_entries,conversation_archive_entries IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE burrow_operator_checks ON COMMIT DROP AS
 SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE conrelid IN ('conversation_entries'::regclass,'conversation_archive_entries'::regclass)
 AND contype='c' AND NOT convalidated AND conname LIKE '%required_instant';
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT * FROM burrow_operator_checks LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.relation,c.conname);
 END LOOP;
END $$;
DO $$ DECLARE r record; p record; BEGIN
 FOR r IN SELECT agent_id,session_id,sequence,entry FROM conversation_entries LOOP
  SELECT * INTO p FROM burrow_operator_projection(r.entry);
  UPDATE conversation_entries SET operator_at=p.at,operator_ts_fallback=p.fallback
   WHERE agent_id=r.agent_id AND session_id=r.session_id AND sequence=r.sequence;
 END LOOP;
 FOR r IN SELECT agent_id,session_id,source_id,ordinal,entry FROM conversation_archive_entries LOOP
  SELECT * INTO p FROM burrow_operator_projection(r.entry);
  UPDATE conversation_archive_entries SET operator_at=p.at,operator_ts_fallback=p.fallback
   WHERE agent_id=r.agent_id AND session_id=r.session_id AND source_id=r.source_id AND ordinal=r.ordinal;
 END LOOP;
END $$;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT * FROM burrow_operator_checks LOOP
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',c.relation,c.conname,c.definition);
 END LOOP;
END $$;
CREATE INDEX conversation_live_operator_latest ON conversation_entries(agent_id,operator_at DESC) WHERE operator_at IS NOT NULL;
CREATE INDEX conversation_archive_operator_latest ON conversation_archive_entries(agent_id,operator_at DESC) WHERE operator_at IS NOT NULL;
CREATE INDEX conversation_live_operator_fallback ON conversation_entries(agent_id) WHERE operator_ts_fallback IS NOT NULL;
CREATE INDEX conversation_archive_operator_fallback ON conversation_archive_entries(agent_id) WHERE operator_ts_fallback IS NOT NULL;
`;

export const POSTGRES_DREAM_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_state_envelopes (
 key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('ledger','preload','scope_review')),
 metadata JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS dream_ledger_entries (
 key TEXT NOT NULL REFERENCES dream_state_envelopes(key) ON DELETE CASCADE,
 position BIGINT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(key,position));
CREATE TABLE IF NOT EXISTS dream_preload_entries (
 key TEXT NOT NULL REFERENCES dream_state_envelopes(key) ON DELETE CASCADE,
 position BIGINT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(key,position));
CREATE TABLE IF NOT EXISTS dream_scope_review_entries (
 key TEXT NOT NULL REFERENCES dream_state_envelopes(key) ON DELETE CASCADE,
 position BIGINT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(key,position));
DO $$ DECLARE r RECORD; k TEXT; field TEXT; BEGIN
 FOR r IN SELECT * FROM working_memory_meta WHERE starts_with(key,'dream-ledger:') OR starts_with(key,'dream-preload:') OR starts_with(key,'dream-scope-review:') LOOP
 k := CASE WHEN starts_with(r.key,'dream-ledger:') THEN 'ledger' WHEN starts_with(r.key,'dream-preload:') THEN 'preload' ELSE 'scope_review' END;
 field := CASE WHEN k='ledger' THEN 'entries' ELSE 'items' END;
 IF jsonb_typeof(r.value_json) <> 'object' OR (r.value_json ? field AND jsonb_typeof(r.value_json->field) <> 'array') THEN
 RAISE EXCEPTION 'invalid dream envelope: %', r.key;
 END IF;
 INSERT INTO dream_state_envelopes VALUES(r.key,k,r.value_json-field,r.updated_at);
 EXECUTE format('INSERT INTO dream_%s_entries(key,position,payload) SELECT $1,ordinality,value FROM jsonb_array_elements($2) WITH ORDINALITY',k) USING r.key,coalesce(r.value_json->field,'[]'::jsonb);
 END LOOP;
 DELETE FROM working_memory_meta WHERE starts_with(key,'dream-ledger:') OR starts_with(key,'dream-preload:') OR starts_with(key,'dream-scope-review:');
END $$;
`;

// Successor migration: generated identities are never reused on queue replacement.
export const POSTGRES_DREAM_SCOPE_IDENTITY_SQL = `
ALTER TABLE dream_scope_review_entries ADD COLUMN entry_id BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX dream_scope_review_entry_identity ON dream_scope_review_entries(entry_id);
`;

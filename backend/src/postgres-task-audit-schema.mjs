export const POSTGRES_TASK_AUDIT_SCHEMA_SQL = `
CREATE FUNCTION burrow_task_audit_instant(value text, fallback timestamptz) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE AS $task_audit$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN fallback; END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN fallback;
END $task_audit$;
CREATE TABLE IF NOT EXISTS task_board_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_board_tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('operator','agent','system','unknown')),
  actor_id TEXT,
  actor_name TEXT,
  changes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  session_id TEXT,
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS task_board_task_events_history_idx ON task_board_task_events(task_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS task_board_task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_board_tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  content BYTEA NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('operator','agent','system','unknown')),
  actor_id TEXT,
  actor_name TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS task_board_task_attachments_task_idx ON task_board_task_attachments(task_id,created_at,id);
INSERT INTO task_board_task_events(id,task_id,action,actor_type,actor_id,actor_name,changes_json,details_json,created_at)
SELECT 'legacy-created-' || id,id,'created',
 CASE WHEN NULLIF(metadata_json->'createdBy'->>'agentId','') IS NULL THEN 'unknown' ELSE 'agent' END,
 NULLIF(metadata_json->'createdBy'->>'agentId',''),NULL,'{}'::jsonb,
 jsonb_build_object('migrated',true),created_at
FROM task_board_tasks
ON CONFLICT(id) DO NOTHING;
INSERT INTO task_board_task_events(id,task_id,action,actor_type,actor_id,actor_name,changes_json,details_json,created_at)
SELECT 'legacy-edited-' || t.id || '-' || lpad(e.ordinality::text,6,'0'),t.id,'updated',
 CASE WHEN NULLIF(e.value->>'agentId','') IS NULL THEN 'unknown' ELSE 'agent' END,
 NULLIF(e.value->>'agentId',''),NULL,
 jsonb_build_object('fields',COALESCE(e.value->'fields','[]'::jsonb)),
 jsonb_build_object('migrated',true),burrow_task_audit_instant(e.value->>'at',t.updated_at)
FROM task_board_tasks t
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.metadata_json->'editedBy')='array' THEN t.metadata_json->'editedBy' ELSE '[]'::jsonb END) WITH ORDINALITY e(value,ordinality)
ON CONFLICT(id) DO NOTHING;
DROP FUNCTION burrow_task_audit_instant(text,timestamptz);
`;

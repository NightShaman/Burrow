// Forge owns this metadata-only retained projection. Conversation/task archives
// have different identities and cascade policies and must not own Forge runs.
export const POSTGRES_FORGE_ARCHIVE_SQL = `
CREATE TABLE forge_archive (
 id TEXT PRIMARY KEY, record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX forge_archive_created ON forge_archive(created_at DESC,id DESC);
CREATE FUNCTION burrow_forge_archive_record(job jsonb, agent text) RETURNS jsonb
LANGUAGE SQL IMMUTABLE AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object(
 'id',job->>'id','jobId',job->>'id','connectionId',job->>'connectionId',
 'modelId',job->>'modelId','kind',job->>'kind','mode',job->>'mode',
 'prompt',job->>'prompt','status',job->>'status','createdAt',job->>'createdAt',
 'updatedAt',job->>'updatedAt','agentId',COALESCE(job->>'agentId',NULLIF(agent,'__operator__')),
 'error',job->>'error','calls',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'connectionId',c->>'connectionId','modelId',c->>'modelId','startedAt',c->>'startedAt',
   'completedAt',c->>'completedAt','status',c->>'status')))
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(job->'calls')='array' THEN job->'calls' ELSE '[]'::jsonb END) c),'[]'::jsonb),
 'outcome',jsonb_build_object('status',job->>'status','error',job->>'error',
 'artifactCount',jsonb_array_length(COALESCE(job->'artifacts','[]'::jsonb)))));
$$;
CREATE FUNCTION burrow_forge_archive_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
   IF OLD.status NOT IN ('succeeded','failed','interrupted') OR OLD.status IS NULL THEN
     RAISE EXCEPTION 'forge_job_active';
   END IF;
   UPDATE forge_archive SET record=record || jsonb_build_object('deletedAt',CURRENT_TIMESTAMP),
     updated_at=CURRENT_TIMESTAMP WHERE id=OLD.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'forge_archive_missing'; END IF;
   RETURN OLD;
 END IF;
 INSERT INTO forge_archive(id,record,created_at,updated_at)
 VALUES(NEW.id,burrow_forge_archive_record(NEW.record,NEW.agent_id),NEW.created_at,NEW.updated_at)
 ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,updated_at=EXCLUDED.updated_at;
 RETURN NEW;
END $$;
INSERT INTO forge_archive(id,record,created_at,updated_at)
 SELECT id,burrow_forge_archive_record(record,agent_id),created_at,updated_at FROM forge_jobs;
CREATE TRIGGER forge_archive_write AFTER INSERT OR UPDATE ON forge_jobs
 FOR EACH ROW EXECUTE FUNCTION burrow_forge_archive_write();
CREATE TRIGGER forge_archive_delete BEFORE DELETE ON forge_jobs
 FOR EACH ROW EXECUTE FUNCTION burrow_forge_archive_write();
-- Claims intentionally outlive jobs: deletion must never enable paid replay.
ALTER TABLE forge_idempotency_claims DROP CONSTRAINT forge_idempotency_claims_first_job_id_fkey;
`;

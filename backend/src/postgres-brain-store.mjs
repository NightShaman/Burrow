import { randomUUID } from 'node:crypto';

export const POSTGRES_BRAIN_SCHEMA_SQL = `
CREATE TABLE brain_memories (
 agent_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 source_refs JSON NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
 operator_owned BOOLEAN NOT NULL DEFAULT FALSE, deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(agent_id,id)
);
CREATE INDEX brain_memories_active ON brain_memories(agent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
`;
const fail = code => { throw new Error(`brain_${code}`); };
function scope(agentId) { if (typeof agentId !== 'string' || !agentId.trim()) fail('agent_required'); }
function fields(input) {
  if (typeof input.title !== 'string' || !input.title.trim()) fail('title_required');
  if (typeof input.content !== 'string' || !input.content.trim()) fail('content_required');
  if (input.sourceRefs !== undefined && (!Array.isArray(input.sourceRefs) || input.sourceRefs.some(x => typeof x !== 'string'))) fail('invalid_source_refs');
}
function record(r) { return r ? { id:r.id, agentId:r.agent_id, title:r.title, content:r.content, sourceRefs:r.source_refs, revision:r.revision, operatorOwned:r.operator_owned, createdAt:r.created_at, updatedAt:r.updated_at, deletedAt:r.deleted_at, origin:r.origin || 'explicit_saved_memory', legacyStatus:r.legacy_status || null, legacySnapshot:r.legacy_snapshot || null, provenance:r.origin || 'explicit_saved_memory', evidenceDisclosure:'Saved memory is not verification of current runtime truth; referenced evidence may no longer be retained.' } : null; }
export class PostgresBrainStore {
 constructor({pool}) { this.pool=pool; }
 record(row) { return record(row); }
 async search(input) { scope(input.agentId); if(typeof input.query !== 'string' && input.query !== undefined) fail('invalid_query'); return this.embeddings ? this.embeddings.search(input,this) : this.list(input); }
 // Default page is 50; callers may request any positive safe integer page size.
 // Immutable IDs provide a stable keyset; concurrent inserts are not a snapshot.
 async list({agentId,query='',limit=50,cursor=null}={}) {
  scope(agentId); if (typeof query !== 'string') fail('invalid_query');
  const n=Number(limit); if (!Number.isSafeInteger(n) || n < 1) fail('invalid_limit');
  let after='';
  if (cursor !== null && cursor !== '') {
   try {
    const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(c.v!==1 || c.agentId!==agentId || c.query!==query || typeof c.id!=='string' || !c.id) fail('invalid_cursor');
    after=c.id;
   } catch { fail('invalid_cursor'); }
  }
  const rows=(await this.pool.query(`SELECT * FROM brain_memories WHERE agent_id=$1 AND deleted_at IS NULL AND ($2='' OR strpos(lower(title || E'\\n' || content),lower($2))>0) AND id COLLATE "C">$4 COLLATE "C" ORDER BY id COLLATE "C" LIMIT $3::bigint + 1`,[agentId,query,n,after])).rows;
  const items=rows.slice(0,n).map(record);
  return {items,nextCursor:rows.length>n ? Buffer.from(JSON.stringify({v:1,agentId,query,id:items.at(-1).id})).toString('base64url') : null};
 }
 async get({agentId,id}) { scope(agentId); return record((await this.pool.query('SELECT * FROM brain_memories WHERE agent_id=$1 AND id=$2 AND deleted_at IS NULL',[agentId,id])).rows[0]); }
 async create(input,{operator=false}={}) {
  scope(input.agentId); fields(input);
  // IDs are allocated here; a deleted identity can never be resurrected by a save.
  return record((await this.pool.query('INSERT INTO brain_memories(agent_id,id,title,content,source_refs,operator_owned) VALUES($1,$2,$3,$4,$5::json,$6) RETURNING *',[input.agentId,randomUUID(),input.title,input.content,JSON.stringify(input.sourceRefs || []),operator])).rows[0]);
 }
 async update(input,{operator=false}={}) { fields(input); return this.mutate(input,operator,false); }
 async remove(input,{operator=false}={}) { return this.mutate(input,operator,true); }
 async mutate(input,operator,remove) {
  scope(input.agentId); if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) fail('revision_required');
  const result=await this.pool.query(`UPDATE brain_memories SET revision=revision+1, updated_at=now(), operator_owned=operator_owned OR $4,
   title=CASE WHEN $5 THEN title ELSE $6 END, content=CASE WHEN $5 THEN content ELSE $7 END,
   source_refs=CASE WHEN $5 THEN source_refs ELSE $8::json END, deleted_at=CASE WHEN $5 THEN now() ELSE NULL END
   WHERE agent_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL AND ($4 OR NOT operator_owned) RETURNING *`,[input.agentId,input.id,input.expectedRevision,operator,remove,input.title || '',input.content || '',JSON.stringify(input.sourceRefs || [])]);
  if (!result.rows.length) fail('revision_conflict_or_operator_authority'); return record(result.rows[0]);
 }
}

// Repeat-safe by original identity, not mutable fingerprints or claim text.
// DO NOTHING protects operator edits and tombstones. Legacy tables remain intact.
export const POSTGRES_BRAIN_LEGACY_IMPORT_SQL = `
INSERT INTO brain_legacy_albdruck(legacy_id,scope,snapshot)
SELECT k.id,k.scope,jsonb_build_object('knowledge',to_jsonb(k),
 'evidence',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.evidence_key) FROM albdruck_evidence e WHERE e.knowledge_id=k.id),'[]'::jsonb),
 'revisions',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM albdruck_revisions r WHERE r.knowledge_id=k.id),'[]'::jsonb))
FROM albdruck_knowledge k ON CONFLICT(legacy_id) DO NOTHING;
INSERT INTO brain_memories(agent_id,id,title,content,source_refs,operator_owned,origin,legacy_status,legacy_snapshot,deleted_at,created_at,updated_at)
SELECT CASE WHEN a.scope='global' THEN 'hatchet' ELSE substring(a.scope FROM 7) END,'legacy-albdruck:' || a.legacy_id,
 coalesce(a.snapshot->'knowledge'->'document'->>'claim','Legacy Albdruck knowledge'),
 (a.snapshot->'knowledge'->'document')::text,
 coalesce((SELECT json_agg((e->'source_ref')::text) FROM jsonb_array_elements(a.snapshot->'evidence') e),'[]'::json),
 EXISTS (SELECT 1 FROM jsonb_array_elements(a.snapshot->'revisions') r WHERE r->>'operation' IN ('correct','delete')),
 'migrated_albdruck',a.snapshot->'knowledge'->>'state',a.snapshot,
 CASE WHEN a.snapshot->'knowledge'->>'state' <> 'active' THEN (a.snapshot->'knowledge'->>'updated_at')::timestamptz ELSE NULL END,
 (a.snapshot->'knowledge'->>'created_at')::timestamptz,(a.snapshot->'knowledge'->>'updated_at')::timestamptz
FROM brain_legacy_albdruck a WHERE a.scope='global' OR (starts_with(a.scope,'agent:') AND length(a.scope)>6)
ON CONFLICT(agent_id,id) DO NOTHING;
`;

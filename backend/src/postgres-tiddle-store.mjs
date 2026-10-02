// Native envelopes preserve unknown fields and empty collections; entry rows are
// independently appendable and retain their original JSON and ordering.
export const POSTGRES_TIDDLE_SCHEMA_SQL = `
CREATE TABLE tiddle_envelopes (key TEXT PRIMARY KEY,value_json JSONB NOT NULL,updated_at TEXT NOT NULL,next_run_at TEXT);
CREATE INDEX tiddle_due_idx ON tiddle_envelopes(next_run_at,key) WHERE key LIKE 'tiddle-pass:%';
CREATE TABLE tiddle_entries (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,key TEXT NOT NULL REFERENCES tiddle_envelopes(key) ON DELETE CASCADE,position BIGINT NOT NULL,value_json JSONB NOT NULL,entry_at TEXT,ref TEXT);
CREATE INDEX tiddle_entries_order_idx ON tiddle_entries(key,position,id);
CREATE INDEX tiddle_entries_retention_idx ON tiddle_entries(key,entry_at);
INSERT INTO tiddle_envelopes(key,value_json,updated_at,next_run_at)
SELECT key,CASE WHEN key LIKE 'tiddle-history:%' THEN value_json::jsonb-'entries' WHEN key LIKE 'tiddle-residue:%' THEN value_json::jsonb-'items' ELSE value_json::jsonb END,updated_at,value_json::jsonb->>'nextRunAt'
FROM settings_meta WHERE key ~ '^tiddle-(history|residue|pass|pass-scope|pass-receipt|synthesis):';
INSERT INTO tiddle_entries(key,position,value_json,entry_at,ref)
SELECT m.key,e.ordinality,e.value,e.value->>'at',e.value->>'ref' FROM settings_meta m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN m.key LIKE 'tiddle-history:%' THEN m.value_json::jsonb->'entries' ELSE m.value_json::jsonb->'items' END) WITH ORDINALITY e(value,ordinality)
WHERE m.key ~ '^tiddle-(history|residue):';
DELETE FROM settings_meta WHERE key ~ '^tiddle-(history|residue|pass|pass-scope|pass-receipt|synthesis):';`;
export const isTiddleIdentity = value => value && typeof value === 'object' && value.kind?.startsWith('tiddle-');
const identity = ({agentId, project = '', kind, scope = ''}) => [agentId,project,kind,scope];
const collection = ({kind}) => kind === 'tiddle-history' ? 'entries' : kind === 'tiddle-residue' ? 'items' : null;
export async function readTiddle(client,key) {
 const {rows} = await client.query('SELECT envelope_id,value_json FROM tiddle_envelopes WHERE agent_id=$1 AND project=$2 AND kind=$3 AND scope=$4',identity(key));
 if (!rows.length) return null;
 const field=collection(key); if (!field) return rows[0].value_json;
 const entries=await client.query('SELECT value_json FROM tiddle_entries WHERE envelope_id=$1 ORDER BY position,id',[rows[0].envelope_id]);
 return {...rows[0].value_json,[field]:entries.rows.map(r=>r.value_json)};
}
export async function writeTiddle(client,key,value,at) {
 if(collection(key)) throw new Error('tiddle_collection_requires_append');
 await client.query('INSERT INTO tiddle_envelopes(agent_id,project,kind,scope,value_json,updated_at,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(agent_id,project,kind,scope) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at,next_run_at=EXCLUDED.next_run_at',[...identity(key),value,at,value.nextRunAt||null]);
}
export async function appendTiddle(client,key,item,envelope,at,cutoff) {
 const {rows}=await client.query('INSERT INTO tiddle_envelopes(agent_id,project,kind,scope,value_json,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(agent_id,project,kind,scope) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING envelope_id,value_json',[...identity(key),envelope,at]);
 const id=rows[0].envelope_id;
 await client.query('UPDATE tiddle_envelopes SET value_json=$2::json WHERE envelope_id=$1',[id,JSON.stringify({...rows[0].value_json,...envelope})]);
 await client.query('DELETE FROM tiddle_entries WHERE envelope_id=$1 AND (entry_at < $2 OR ($3::text IS NOT NULL AND ref=$3))',[id,cutoff,key.kind==='tiddle-residue'?item.ref:null]);
 await client.query('INSERT INTO tiddle_entries(envelope_id,position,value_json,entry_at,ref) SELECT $1,COALESCE(min(position),0)-1,$2,$3,$4 FROM tiddle_entries WHERE envelope_id=$1',[id,item,item.at||null,item.ref||null]);
}
export async function tiddleRows(client,{agentId=null,kind}) {
 const {rows}=await client.query(`SELECT e.agent_id,e.project,e.kind,e.scope,e.updated_at,e.value_json,
 coalesce((SELECT json_agg(t.value_json ORDER BY t.position,t.id) FROM tiddle_entries t WHERE t.envelope_id=e.envelope_id),'[]'::json) AS entries
 FROM tiddle_envelopes e WHERE e.kind=$1 AND ($2::text IS NULL OR e.agent_id=$2) ORDER BY e.updated_at DESC,e.agent_id,e.scope`,[kind,agentId]);
 return rows.map(({entries,...r})=>({...r,value_json:JSON.stringify(collection(r) ? {...r.value_json,[collection(r)]:entries} : r.value_json)}));
}

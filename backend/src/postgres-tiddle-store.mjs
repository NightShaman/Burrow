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
export const isTiddleKey = key => /^tiddle-(history|residue|pass|pass-scope|pass-receipt|synthesis):/.test(key);
const collection = key => key.startsWith('tiddle-history:') ? 'entries' : key.startsWith('tiddle-residue:') ? 'items' : null;
export async function readTiddle(client,key) {
 const {rows} = await client.query('SELECT value_json FROM tiddle_envelopes WHERE key=$1',[key]);
 if (!rows.length) return null;
 const field=collection(key); if (!field) return rows[0].value_json;
 const entries=await client.query('SELECT value_json FROM tiddle_entries WHERE key=$1 ORDER BY position,id',[key]);
 return {...rows[0].value_json,[field]:entries.rows.map(r=>r.value_json)};
}
export async function writeTiddle(client,key,value,at) {
 const field=collection(key); if(field) throw new Error('tiddle_collection_requires_append');
 await client.query('INSERT INTO tiddle_envelopes(key,value_json,updated_at,next_run_at) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET value_json=burrow_json_merge(tiddle_envelopes.value_json,EXCLUDED.value_json),updated_at=EXCLUDED.updated_at,next_run_at=EXCLUDED.next_run_at',[key,value,at,value.nextRunAt||null]);
}
export async function appendTiddle(client,key,item,envelope,at,cutoff) {
 await client.query('INSERT INTO tiddle_envelopes(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=burrow_json_merge(tiddle_envelopes.value_json,EXCLUDED.value_json),updated_at=EXCLUDED.updated_at',[key,envelope,at]);
 await client.query('DELETE FROM tiddle_entries WHERE key=$1 AND (entry_at < $2 OR ($3::text IS NOT NULL AND ref=$3))',[key,cutoff,key.startsWith('tiddle-residue:')?item.ref:null]);
 await client.query('INSERT INTO tiddle_entries(key,position,value_json,entry_at,ref) SELECT $1,COALESCE(min(position),0)-1,$2,$3,$4 FROM tiddle_entries WHERE key=$1',[key,item,item.at||null,item.ref||null]);
}
export async function tiddleRows(client,prefix) {
 const {rows}=await client.query('SELECT key,updated_at FROM tiddle_envelopes WHERE starts_with(key,$1) ORDER BY updated_at DESC,key',[prefix]);
 return Promise.all(rows.map(async r=>({...r,value_json:JSON.stringify(await readTiddle(client,r.key))})));
}

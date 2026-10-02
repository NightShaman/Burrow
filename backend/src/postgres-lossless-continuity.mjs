import { createHash } from 'node:crypto';

// Compatibility execution for pending adopted migrations. Their checksum-locked
// SQL remains unchanged; legacy payloads are moved using JavaScript JSON instead
// of jsonb, within the runner's existing transaction and advisory lock.
export const LOSSLESS_CONTINUITY_SQL = `
ALTER TABLE rolling_continuity_cards
 ALTER COLUMN card_json TYPE json USING card_json::json,
 ALTER COLUMN legacy_card_json TYPE json USING legacy_card_json::json,
 ALTER COLUMN legacy_envelope_version TYPE json USING legacy_envelope_version::json,
 ALTER COLUMN legacy_envelope_updated_at TYPE json USING legacy_envelope_updated_at::json,
 ALTER COLUMN legacy_envelope_agent_id TYPE json USING legacy_envelope_agent_id::json,
 ALTER COLUMN legacy_envelope_project TYPE json USING legacy_envelope_project::json;
ALTER TABLE rolling_continuity_envelopes
 ALTER COLUMN version TYPE json USING version::json,
 ALTER COLUMN envelope_updated_at TYPE json USING envelope_updated_at::json,
 ALTER COLUMN envelope_agent_id TYPE json USING envelope_agent_id::json,
 ALTER COLUMN envelope_project TYPE json USING envelope_project::json,
 ALTER COLUMN extra_metadata TYPE json USING extra_metadata::json;
ALTER TABLE tiddle_envelopes ALTER COLUMN value_json TYPE json USING value_json::json;
ALTER TABLE tiddle_entries ALTER COLUMN value_json TYPE json USING value_json::json;
CREATE FUNCTION burrow_json_merge(left_value json,right_value json) RETURNS json LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(json_object_agg(key,value),'{}'::json) FROM (
 SELECT DISTINCT ON (key) key,value FROM (
 SELECT key,value,0 AS priority FROM json_each(left_value)
 UNION ALL SELECT key,value,1 FROM json_each(right_value)
 ) members ORDER BY key,priority DESC) merged
$$;`;

export async function applyLegacyContinuity(client, migration) {
 const rolling = migration.version === 18;
 const sources = [];
 for (const table of rolling ? ['settings_meta','working_memory_meta'] : ['settings_meta']) {
  const predicate = rolling ? "starts_with(key,'rolling-continuity:')" : "key ~ '^tiddle-(history|residue|pass|pass-scope|pass-receipt|synthesis):'";
  const {rows} = await client.query(`DELETE FROM ${table} WHERE ${predicate} RETURNING key,value_json,updated_at`);
  sources.push(...rows.map(r=>({...r,origin:table,value:typeof r.value_json==='string'?JSON.parse(r.value_json):r.value_json})));
 }
 // Execute the immutable migration's DDL prefix, not its jsonb backfill.
 // The original payloads never pass through jsonb before version 27 converts
 // the newly-created native columns to lossless json.
 const boundary = rolling ? '-- Refuse destructive migration' : 'INSERT INTO tiddle_envelopes(key,value_json,updated_at,next_run_at)';
 const position = migration.sql.indexOf(boundary);
 if (position < 0) throw new Error(`unsupported legacy continuity migration ${migration.version}`);
 await client.query(migration.sql.slice(0, position));
 if (rolling) {
  for (const table of ['rolling_continuity_cards','rolling_continuity_envelopes']) {
   const {rows}=await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND data_type='jsonb'",[table]);
   for (const r of rows) await client.query(`ALTER TABLE ${table} ALTER COLUMN ${r.column_name} TYPE json USING ${r.column_name}::json`);
  }
  const occupied=new Set();
  const reserved=new Set();
  for (const r of sources) for (const c of Array.isArray(r.value?.cards) ? r.value.cards : []) {
   const rest=r.key.slice('rolling-continuity:'.length), split=rest.indexOf(':');
   const agent=c?.agentId||r.value.agentId||rest.slice(0,split), scope=c?.project||r.value.project||rest.slice(split+1);
   if (c?.id) reserved.add(JSON.stringify([agent,scope,c.id]));
  }
  for (const r of sources) {
   const e=r.value;
   if (!e || typeof e!=='object' || !Array.isArray(e.cards) || e.cards.some(c=>!c || typeof c!=='object'||Array.isArray(c))) throw Error(`invalid rolling continuity envelope: ${r.key}`);
   const {cards,version,updatedAt,agentId,project,...extra}=e;
   await client.query('INSERT INTO rolling_continuity_envelopes VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.origin,r.key,...[version,updatedAt,agentId,project,extra].map(v=>JSON.stringify(v)??null),r.updated_at]);
   for (let i=0;i<cards.length;i++) {
    const c=cards[i], rest=r.key.slice(19), split=rest.indexOf(':');
    const agent=c.agentId||agentId||rest.slice(0,split), scope=c.project||project||rest.slice(split+1);
    const original=c.id||`legacy:${createHash('md5').update(r.origin+r.key+String(i+1)+JSON.stringify(c)).digest('hex')}`;
    let id=original,n=0; while(occupied.has(JSON.stringify([agent,scope,id])) || (id !== original && reserved.has(JSON.stringify([agent,scope,id])))) id=`legacy-migration:${n++}:${original}`;
    occupied.add(JSON.stringify([agent,scope,id]));
    await client.query('INSERT INTO rolling_continuity_cards VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[agent,scope,id,JSON.stringify({...c,id,agentId:agent,project:scope}),r.updated_at,r.origin,r.key,JSON.stringify(c),...[version,updatedAt,agentId,project].map(v=>JSON.stringify(v)??null)]);
   }
  }
 } else {
  await client.query('ALTER TABLE tiddle_envelopes ALTER COLUMN value_json TYPE json USING value_json::json; ALTER TABLE tiddle_entries ALTER COLUMN value_json TYPE json USING value_json::json');
  for(const r of sources) {
   if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) throw Error(`invalid tiddle envelope: ${r.key}`);
   const e={...r.value},field=r.key.startsWith('tiddle-history:')?'entries':r.key.startsWith('tiddle-residue:')?'items':null;
   const entries=field?e[field]:[]; if(field) delete e[field];
   await client.query('INSERT INTO tiddle_envelopes VALUES($1,$2,$3,$4)',[r.key,JSON.stringify(e),r.updated_at,e.nextRunAt||null]);
   if(field && !Array.isArray(entries)) throw Error(`invalid tiddle collection: ${r.key}`);
   for(let i=0;i<entries.length;i++) await client.query('INSERT INTO tiddle_entries(key,position,value_json,entry_at,ref) VALUES($1,$2,$3,$4,$5)',[r.key,i+1,JSON.stringify(entries[i]),entries[i]?.at||null,entries[i]?.ref||null]);
  }
 }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withPostgresTransaction } from './postgres-foundation.mjs';

const SESSION_NAME = /^session\.jsonl$/;
const COMPACTED_NAME = /^session\.compacted\..+\.jsonl$/;
const RESET_NAME = /^session\.reset\..+\.jsonl$/;
const id = (value, name) => { const v = String(value ?? '').trim(); if (!v) throw new Error(`${name}_required`); return v; };
const jsonObject = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`); return value; };

async function jsonFile(file, label, required = true) {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (!text.trim()) throw new Error(`empty_${label}`);
    return jsonObject(JSON.parse(text), label);
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    if (error.code === 'ENOENT') throw new Error(`missing_${label}`);
    if (error instanceof SyntaxError) throw new Error(`invalid_${label}`);
    throw error;
  }
}
async function jsonl(file, label) {
  let text;
  text = await fs.readFile(file, 'utf8');
  const rows = [];
  // A final newline is conventional, but every non-empty physical line is authoritative.
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(jsonObject(JSON.parse(line), `${label}_line_${index + 1}`)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(`invalid_jsonl:${label}:${index + 1}`); throw error; }
  }
  return rows;
}
async function readSession(rootDir, sessionId) {
  const directory = path.join(rootDir, 'sessions', sessionId);
  const metadata = await jsonFile(path.join(directory, 'session.meta.json'), 'session_metadata');
  const continuity = await jsonFile(path.join(directory, 'continuity-head.json'), 'continuity_head', false);
  const interrupted = await jsonFile(path.join(directory, 'interrupted-run.json'), 'interrupted_run', false);
  const recoveryQueue = await jsonFile(path.join(directory, 'recovery-queue.json'), 'recovery_queue', false);
  let readEvidence = null;
  try { readEvidence = JSON.parse(await fs.readFile(path.join(directory,'read-evidence.json'),'utf8')); if (!Array.isArray(readEvidence)) throw new Error('invalid_read_evidence'); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  let runEvidence = null;
  try { runEvidence = await jsonl(path.join(directory,'run-evidence.jsonl'),'run_evidence'); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  const items = await fs.readdir(directory, {withFileTypes:true});
  if(items.some(x=>!x.isFile())) throw new Error(`unsupported_session_entry:${sessionId}`);
  const names = items.map(x=>x.name);
  const active = names.find(x => SESSION_NAME.test(x));
  if (!active) throw new Error(`missing_active_transcript:${sessionId}`);
  const entries = await jsonl(path.join(directory, active), `${sessionId}/session.jsonl`);
  const archives = [];
  for (const name of names.filter(x => COMPACTED_NAME.test(x) || RESET_NAME.test(x)).sort()) {
    const archiveEntries = await jsonl(path.join(directory, name), `${sessionId}/${name}`);
    const sidecar = RESET_NAME.test(name) ? await jsonFile(path.join(directory, `${name.replace(/\.jsonl$/, '')}.archive.json`), `${name}_metadata`, false) : null;
    archives.push({ name, entries: archiveEntries, metadata: sidecar, kind: RESET_NAME.test(name) ? 'reset' : 'compacted' });
  }
  // Unknown files are not silently interpreted as transcript data.
  const allowed = new Set(['session.meta.json', 'continuity-head.json', 'interrupted-run.json', 'recovery-queue.json', 'read-evidence.json', 'run-evidence.jsonl', ...archives.filter(a=>a.kind==='reset' && a.metadata).map(a=>a.name.replace(/\.jsonl$/,'.archive.json')), ...names.filter(x => SESSION_NAME.test(x) || COMPACTED_NAME.test(x) || RESET_NAME.test(x)).filter(Boolean)]);
  const unknown = names.filter(x => !allowed.has(x));
  if (unknown.length) throw new Error(`unsupported_session_files:${sessionId}:${unknown.join(',')}`);
  return { sessionId, metadata: { ...metadata, ...(continuity ? { continuityHead: continuity } : {}), ...(interrupted ? { interruptedRun: interrupted } : {}), ...(recoveryQueue ? {recoveryQueue} : {}), ...(readEvidence ? {readEvidence} : {}), ...(runEvidence ? {runEvidence} : {}) }, entries, archives };
}

/** Import the explicitly supplied agent's filesystem sessions into empty PostgreSQL conversation tables. */
export async function importConversationSessions(pool, { agentId: rawAgentId, rootDir: rawRootDir } = {}) {
  if (!pool?.connect) throw new Error('postgres_pool_required');
  const agentId = id(rawAgentId, 'agentId'); const rootDir = id(rawRootDir, 'rootDir');
  const base = path.join(rootDir, 'sessions');
  const dirs = await fs.readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') throw new Error('missing_sessions_directory'); throw error; });
  if (dirs.some(x=>!x.isDirectory())) throw new Error('unsupported_sessions_entry');
  const sessions = [];
  for (const item of dirs.filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.name || item.name === '.' || item.name === '..' || item.name.includes(path.sep)) throw new Error('invalid_session_directory');
    sessions.push(await readSession(rootDir, item.name));
  }
  return withPostgresTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversation-import:${agentId}`]);
    for (const table of ['conversation_sessions', 'conversation_entries', 'conversation_archives']) {
      await client.query(`LOCK TABLE ${table} IN EXCLUSIVE MODE`);
      if ((await client.query(`SELECT 1 FROM ${table} WHERE agent_id=$1 LIMIT 1`, [agentId])).rowCount) throw new Error(`target_not_empty:${table}`);
    }
    const now = new Date().toISOString(); let entriesImported = 0; let archivesImported = 0;
    for (const session of sessions) {
      const created = session.metadata.createdAt || now; const updated = session.metadata.updatedAt || created;
      await client.query('INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5)', [agentId, session.sessionId, JSON.stringify(session.metadata), created, updated]);
      for (const entry of session.entries) {
        const entryId = id(entry.id, 'entry_id');
        await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::jsonb,$5)', [agentId, session.sessionId, entryId, JSON.stringify(entry), entry.ts || created]);
        entriesImported++;
      }
      for (let n = 0; n < session.archives.length; n++) {
        const archive = session.archives[n];
        await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [agentId, session.sessionId, `${session.sessionId}.${archive.name.replace(/^session\./,'').replace(/\.jsonl$/,'')}`, n, archive.kind, JSON.stringify(archive.entries), JSON.stringify(archive.metadata || {}), archive.entries[0]?.ts || created]);
        archivesImported++;
      }
    }
    for (const session of sessions) {
      const entries = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence',[agentId,session.sessionId]);
      if(!isDeepStrictEqual(entries.rows.map(r=>r.entry),session.entries)) throw new Error('import_verification_failed:entries');
      const archives = await client.query('SELECT entries,metadata,kind FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 ORDER BY generation',[agentId,session.sessionId]);
      if(!isDeepStrictEqual(archives.rows,session.archives.map(a=>({entries:a.entries,metadata:a.metadata||{},kind:a.kind})))) throw new Error('import_verification_failed:archives');
    }
    const check = await client.query('SELECT session_id,metadata FROM conversation_sessions WHERE agent_id=$1 ORDER BY session_id', [agentId]);
    if (check.rowCount !== sessions.length || sessions.some(s => !isDeepStrictEqual(check.rows.find(r=>r.session_id===s.sessionId)?.metadata,s.metadata))) throw new Error('import_verification_failed:session_metadata');
    return { sessionsImported: sessions.length, entriesImported, archivesImported };
  });
}
export const importPostgresConversations = importConversationSessions;
export default importConversationSessions;

import { archiveReadQuery, withArchiveRead } from './postgres-archive-read.mjs';
import { readArchiveTranscriptPage } from './postgres-archive-page.mjs';
import { archivePayloadKeySQL, archiveTruthyPayloadSQL } from './postgres-archive-lexical.mjs';
import { exportSessionRawEvidence } from './session-evidence-export.mjs';
import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { resolveAlbdruckConfig } from './config.mjs';
import { matchesQuery } from './session-search.mjs';
import { text, required, limitValue, rowEntry, proofRunKey } from './postgres-session-values.mjs';

// These are bounded index probes with cold scalar coercion branches. PostgreSQL
// otherwise JIT-compiles every (mostly unexecuted) branch based on conservative
// JSON-function costs; compilation can dwarf the millisecond candidate read.
// Transaction-local only: never change a shared pooled connection's defaults.
export function sessionReadQuery(pool, sql, values, { signal, deadline } = {}) {
  if (deadline !== undefined) return archiveReadQuery(pool, sql, values, { signal, deadline });
  return signal ? withPostgresTransaction(pool, client => client.query(sql, values), { signal }) : pool.query(sql, values);
}

// Reset listing counts are advisory metadata unless tied to the exact source
// revisions used by that listing statement. Keep the bounded cache per pool;
// new processes reconstruct on first use, and SQL edits cannot leave it stale.
const resetListingCountsByPool = new WeakMap();
const RESET_LISTING_COUNT_CACHE_LIMIT = 512;

// Canonical occurrence precedence: live, generation, source ID, earliest archive ordinal.
function originalNewerSQL(row = 'r', newer = 'newer') {
  return `(${newer}.source_store>${row}.source_store OR
    (${newer}.source_store=${row}.source_store AND
      CASE WHEN ${row}.source_store='live' THEN ${newer}.ordinal>${row}.ordinal ELSE
        ${newer}.generation>${row}.generation OR (${newer}.generation=${row}.generation AND
          (${newer}.source_id>${row}.source_id OR (${newer}.source_id=${row}.source_id AND ${newer}.ordinal<${row}.ordinal))) END))`;
}

// Archive discovery uses catalog rows plus time-indexed native occurrences. The
// generation window and winner probes mirror transcript reconstruction; a stale
// snapshot's timestamp/visibility must not create a ghost conversation day.
function archiveRowsSQL({ occurrences = true } = {}) {
  return `archive_rows AS (
    SELECT s.agent_id,s.session_id AS id,s.session_id,NULL::text AS source_session_id,
      false AS archive_snapshot,s.metadata,s.created_at,s.updated_at,
      ${occurrences ? `COALESCE((s.metadata->>'resetGeneration')::bigint,
        (SELECT max(r.generation)+1 FROM conversation_archives r
          WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)` : '0::bigint'} AS min_generation,
      NULL::bigint AS max_generation
    FROM conversation_sessions s WHERE s.agent_id=$1
      AND NULLIF(s.metadata->'contextIsolation'->>'historySessionId','') IS NULL
      AND ($2::boolean OR COALESCE((s.metadata->>'archived')::boolean,false)=false)
    UNION ALL
    SELECT a.agent_id,a.archive_id,a.session_id,COALESCE(NULLIF(a.metadata->>'sourceSessionId',''),a.session_id),
      true,a.metadata,a.created_at,a.created_at,
      ${occurrences ? `COALESCE((a.metadata->>'resetGeneration')::bigint,
        (SELECT max(r.generation)+1 FROM conversation_archives r
          WHERE r.agent_id=a.agent_id AND r.session_id=a.session_id AND r.kind='reset' AND r.generation<a.generation),0)` : '0::bigint'},
      a.generation
    FROM conversation_archives a WHERE a.agent_id=$1 AND a.kind='reset'
      AND NULLIF(a.metadata->'contextIsolation'->>'historySessionId','') IS NULL
  )`;
}

function archiveOccurrenceDaysSQL({ start, end, timezone }) {
  const branch = live => `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      e.archive_chat_at AS occurrence_at
      FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'} e
      WHERE e.agent_id=$1 AND e.archive_chat_projected AND e.archive_chat_visible
        AND e.archive_chat_at>=${start}::timestamptz AND e.archive_chat_at<${end}::timestamptz`;
  const grandfathered = live => `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      g.instant AS occurrence_at
      FROM ${live ? 'conversation_live_chat_grandfathered' : 'conversation_archive_chat_grandfathered'} g
      JOIN ${live ? 'conversation_entries' : 'conversation_archive_entries'} e ON e.agent_id=g.agent_id AND e.session_id=g.session_id
        AND ${live ? 'e.sequence=g.sequence' : 'e.source_store=g.source_store AND e.source_id=g.source_id AND e.ordinal=g.ordinal'}
      WHERE g.agent_id=$1 AND NOT e.archive_chat_projected AND g.visible
        AND g.instant>=${start}::timestamptz AND g.instant<${end}::timestamptz`;
  // Only the not-yet-checkpointed portion needs a lexical parse. Completed
  // side projections (including invisible/undated ones) are excluded by key.
  // The state, original and side table are all read under one MVCC snapshot.
  const pending = live => {
    const table = live ? 'conversation_entries' : 'conversation_archive_entries';
    const side = live ? 'conversation_live_chat_grandfathered' : 'conversation_archive_chat_grandfathered';
    const keys = live ? ['agent_id','session_id','sequence'] : ['agent_id','session_id','source_store','source_id','ordinal'];
    const checkpoint = live ? ['live_agent','live_session','live_sequence'] : ['archive_agent','archive_session','archive_store','archive_source','archive_ordinal'];
    return `SELECT e.agent_id,e.session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
      ${live ? 'e.sequence::text' : 'e.source_id'} AS source_id,${live ? 'e.sequence' : 'e.ordinal'} AS ordinal,
      e.entry_key,e.has_payload_id,e.entry_id,CASE WHEN e.has_payload_id IS NULL THEN e.entry END AS entry,
      ${live ? 'NULL::bigint' : 'e.generation'} AS generation,${live ? 'NULL::text' : 'e.archive_kind'} AS archive_kind,
      p.instant AS occurrence_at
      FROM (SELECT e.* FROM (SELECT * FROM burrow_archive_chat_backfill state
          WHERE state.id AND NOT state.${live ? 'live_done' : 'archive_done'} OFFSET 0) state
        CROSS JOIN LATERAL (SELECT * FROM ${table} e WHERE e.agent_id=$1 AND NOT e.archive_chat_projected
          AND (e.agent_id>state.${checkpoint[0]} OR (e.agent_id=state.${checkpoint[0]}
            AND (${keys.slice(1).map(key => `e.${key}`).join(',')})>(${checkpoint.slice(1).map(key => `state.${key}`).join(',')}))
            OR (state.${checkpoint[0]} IS NULL AND (e.agent_id,e.session_id)>=($1,'')))
          AND NOT EXISTS (SELECT 1 FROM ${side} g WHERE ${keys.map(key => `g.${key}=e.${key}`).join(' AND ')}) OFFSET 0) e OFFSET 0) e
      CROSS JOIN LATERAL burrow_archive_chat_projection(e.entry,
        COALESCE(e.search_projection,burrow_json_member(e.entry,'content')::text,'')) p
      WHERE p.visible AND p.instant>=${start}::timestamptz AND p.instant<${end}::timestamptz`;
  };
  // Separate indexed probes keep ordinary string-ID candidates on the logical
  // identity index. Only non-string/falsey identity cases need scalar coercion;
  // an absent relational ID never deduplicates unrelated legacy occurrences.
  const identities = [
    `c.payload_key IS NOT NULL AND c.payload_key<>'' AND n.has_payload_id
      AND burrow_history_key(n.entry_key)=c.payload_key`,
    `c.payload_key IS NOT NULL AND n.has_payload_id = true
      AND burrow_history_key(n.entry_key) IS NULL AND ${archivePayloadKeySQL('n')}=c.payload_key`,
    // A v81-grandfathered NULL marker can have a non-null relational entry_key
    // that is NOT the payload ID. Always parse that cold branch independently.
    `c.payload_key IS NOT NULL AND n.has_payload_id IS NULL
      AND ${archivePayloadKeySQL('n')}=c.payload_key`,
    `c.payload_key IS NULL AND NULLIF(c.entry_id,'') IS NOT NULL
      AND n.entry_id<>'' AND n.entry_id=c.entry_id AND NOT ${archiveTruthyPayloadSQL('n')}`,
  ];
  const probes = identities.flatMap(identity => [
    `NOT EXISTS (SELECT 1 FROM conversation_entries n
      WHERE NOT d.archive_snapshot AND n.agent_id=c.agent_id AND n.session_id=c.session_id
        AND ${identity} AND (c.source_store='archive' OR n.sequence<c.ordinal) OFFSET 0)`,
    `NOT EXISTS (SELECT 1 FROM conversation_archive_entries n
      WHERE c.source_store='archive' AND n.agent_id=c.agent_id AND n.session_id=c.session_id
        AND ${identity}
        AND ((d.archive_snapshot AND n.source_id=d.id)
          OR (n.archive_kind='compacted' AND n.generation>=d.min_generation
            AND (d.max_generation IS NULL OR n.generation<=d.max_generation)))
        AND ((d.archive_snapshot AND n.source_id=d.id AND c.source_id<>d.id)
          OR (n.source_id=c.source_id AND n.ordinal<c.ordinal)
          OR ((NOT d.archive_snapshot OR c.source_id<>d.id)
            AND (n.generation>c.generation OR (n.generation=c.generation AND n.source_id>c.source_id)))) OFFSET 0)`,
  ]);
  return `occurrence_windows AS MATERIALIZED (${[branch(true), branch(false), grandfathered(true), grandfathered(false), pending(true), pending(false)].map(sql => `(${sql})`).join(' UNION ALL ')}),
    occurrence_candidates AS MATERIALIZED (
      SELECT e.agent_id,e.session_id,e.source_store,e.source_id,e.ordinal,e.entry_id,e.generation,e.archive_kind,
        to_char(e.occurrence_at AT TIME ZONE ${timezone},'YYYY-MM-DD') AS day,
        ${archivePayloadKeySQL('e')} AS payload_key FROM occurrence_windows e),
    matched_days AS (
      SELECT DISTINCT d.agent_id,d.id,c.day FROM occurrence_candidates c
      JOIN archive_rows d ON d.agent_id=c.agent_id AND d.session_id=c.session_id
        AND ((NOT d.archive_snapshot AND c.source_store='live')
          OR (c.source_store='archive' AND ((d.archive_snapshot AND c.source_id=d.id)
            OR (c.archive_kind='compacted' AND c.generation>=d.min_generation
              AND (d.max_generation IS NULL OR c.generation<=d.max_generation)))))
      WHERE ${probes.join('\n        AND ')}
    )`;
}

// Preserve first transcript position while later snapshots replace payloads.
// Relational occurrence IDs keep equal-content id-less messages distinct.
function mergeTranscriptSnapshots(snapshots) {
  const entries = []; const positions = new Map();
  for (const snapshot of snapshots) {
    const seen = new Set();
    for (const occurrence of snapshot) {
      const entry = occurrence.entry;
      const identity = entry?.id ? `payload:${entry.id}` : occurrence.occurrence ? `occurrence:${occurrence.occurrence}` : null;
      if (!identity) { entries.push(entry); continue; }
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (positions.has(identity)) entries[positions.get(identity)] = entry;
      else { positions.set(identity, entries.length); entries.push(entry); }
    }
  }
  return entries;
}

/** Archive/history/Dream read authority. No write callbacks or facade reference.
 * Owns capability state and read orchestration over the same normalized pool;
 * existing Archive helpers retain their pool-scoped admission/budget boundary.
 * Active append/transition transactions remain solely in PostgresSessionStore.
 */
export class PostgresSessionReadStore {
  constructor({ pool } = {}) {
    if (!pool?.query) throw new Error('session_postgres_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.archiveDateProjection = null;
    this.archiveNativeCatalogTime = null;
  }
  async hasArchiveDateProjection(client = this.pool) {
    if (this.archiveDateProjection !== null) return this.archiveDateProjection;
    const { rows } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='conversation_entries' AND column_name='dream_at') AS available,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='conversation_sessions' AND column_name='updated_at' AND udt_name='timestamptz') AS native_catalog_time`);
    this.archiveNativeCatalogTime = rows[0]?.native_catalog_time === true;
    return this.archiveDateProjection = rows[0]?.available === true;
  }

  async history({ agentId, scope = 'agent', query, cursor = '', signal, budgetMs = resolveAlbdruckConfig().historyBudgetMs, pageSize = Math.min(50, resolveAlbdruckConfig().maxPageSize) } = {}) {
    if (!['agent', 'global'].includes(scope) || (scope === 'agent' && (typeof agentId !== 'string' || !agentId.trim()))) throw new Error('albdruck_scope_invalid');
    if (typeof query !== 'string' || !query.trim()) throw new Error('albdruck_query_required');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > resolveAlbdruckConfig().maxPageSize) throw new Error('albdruck_page_size_invalid');
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new Error('history_budget_invalid');
    const deadline = performance.now() + budgetMs;
    const binding = JSON.stringify([scope, scope === 'agent' ? agentId : null, query.trim()]);
    let after = null;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.v !== 1 || value.binding !== binding || !Array.isArray(value.key) || value.key.length !== 3 || value.key.some(x => typeof x !== 'string')) throw new Error();
        after = value.key;
      } catch { throw new Error('albdruck_cursor_invalid'); }
    } else if (typeof cursor !== 'string') throw new Error('albdruck_cursor_invalid');
    signal?.throwIfAborted();
    const originals = [];
    const sortKey = value => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, '0')).join('');
    const consider = row => {
      const entry = row.entry;
      if (entry?.type !== 'message' || entry.metadata?.compressionSummary || !['user','assistant','agent'].includes(entry.role) || typeof entry.content !== 'string') return;
      const entryId = entry.id || (row.entry_key ? JSON.parse(row.entry_key) : null);
      if (typeof entryId !== 'string' || !entryId || !matchesQuery(entry, query.trim())) return;
      originals.push({ key: [row.agent_id, row.session_id, entryId], item: {
        agentId: row.agent_id, sessionId: row.session_id, entryId,
        timestamp: entry.timestamp ?? entry.ts ?? row.created_at, role: entry.role, content: entry.content,
        sourceRef: { kind: 'conversation_entry', agentId: row.agent_id, sessionId: row.session_id, entryId },
        provenance: row.source_store === 'live' ? { store: 'live', reset: false } :
          { store: 'archive', reset: row.archive_kind === 'reset', archiveId: row.source_id,
            kind: row.archive_kind, generation: Number(row.generation), archivedAt: row.created_at },
      } });
    };
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    // OR is intentionally broader than the two-term coverage rule; exact phrase
    // and cross-field matches must not be lost. Final matchesQuery removes noise.
    const grams = terms.map(term => [...new Set(Array.from({ length: term.length - 2 }, (_, i) => term.slice(i, i + 3)))]);
    const candidate = grams.length ? `AND (search_grams IS NULL OR ${grams.map((_, i) => `search_grams @> $${i + 5}::text[]`).join(' OR ')})` : '';
    // One repeatable-read snapshot keeps reset/compaction from hiding a turn during scanning.
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      // Disconnecting the dedicated transaction socket cancels active server work
      // without requiring a second pool connection (which may itself be exhausted).
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; abort(); }, Math.max(1, deadline - performance.now()));
      timer.unref?.();
      try {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SELECT set_config('lock_timeout',$1,true)", [String(Math.min(budgetMs, resolveAlbdruckConfig().historyLockTimeoutMs))]);
        let position = after?.map(sortKey) || null;
        for (;;) {
          signal?.throwIfAborted();
          const remaining = Math.floor(deadline - performance.now());
          if (remaining < 1) throw new Error('history_query_budget_exceeded');
          await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]);
          const branch = store => `SELECT r.agent_id,r.session_id,'${store}'::text AS source_store,
            ${store === 'live' ? "r.sequence::text AS source_id,r.sequence AS ordinal,r.entry_key,r.entry,r.created_at,NULL::text AS archive_kind,NULL::bigint AS generation" : "r.source_id,r.ordinal,r.entry_key,r.entry,r.created_at,r.archive_kind,r.generation"}
            FROM ${store === 'live' ? 'conversation_entries' : 'conversation_archive_entries'} r
            WHERE ($1::text IS NULL OR agent_id=$1)
            AND ($2::text IS NULL OR
              (burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C") > ($2,$3,$4))
            AND burrow_history_key(entry_key) IS NOT NULL
            ${candidate}
            AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
              WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key)
              AND (newer.source_store>'${store}' OR
                (newer.source_store='${store}' AND
                  (CASE WHEN '${store}'='live' THEN newer.ordinal>${store === 'live' ? 'r.sequence' : 'r.ordinal'} ELSE
                    newer.generation>${store === 'live' ? 'NULL::bigint' : 'r.generation'} OR (newer.generation=${store === 'live' ? 'NULL::bigint' : 'r.generation'} AND
                      (newer.source_id>${store === 'live' ? 'r.sequence::text' : 'r.source_id'} OR (newer.source_id=${store === 'live' ? 'r.sequence::text' : 'r.source_id'} AND newer.ordinal<${store === 'live' ? 'r.sequence' : 'r.ordinal'}))) END))))
            ORDER BY burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C" LIMIT 256`;
          const order = `burrow_history_text(agent_id) COLLATE "C",burrow_history_text(session_id) COLLATE "C",burrow_history_key(entry_key) COLLATE "C"`;
          const { rows } = await client.query(`SELECT * FROM ((${branch('live')}) UNION ALL (${branch('archive')})) candidates ORDER BY ${order} LIMIT 256`,
          [scope === 'agent' ? agentId : null, ...(position || [null,null,null]), ...grams]);
          for (const row of rows) {
            signal?.throwIfAborted();
            consider(row);
            if (originals.length > pageSize) break;
          }
          if (originals.length > pageSize || rows.length < 256) break;
          const last = rows.at(-1);
          position = [last.agent_id,last.session_id,JSON.parse(last.entry_key)].map(sortKey);
        }
        const ordered = originals;
        const page = ordered.slice(0,pageSize);
        return { items: page.map(x => x.item), nextCursor: ordered.length > pageSize ? Buffer.from(JSON.stringify({ v: 1, binding, key: page.at(-1).key })).toString('base64url') : null };
      } catch (error) {
        signal?.throwIfAborted();
        if (expired || error?.code === '57014') throw new Error('history_query_budget_exceeded', { cause: error });
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }, { deadline, signal });
  }

  async dreamTimeline({ agentId, since, until, signal } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const entries = []; const seen = new Map();
        const branch = live => `SELECT agent_id,session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
            ${live ? 'sequence::text' : 'source_id'} AS source_id,${live ? 'sequence' : 'ordinal'} AS ordinal,entry,created_at,entry_key,${live ? 'NULL::bigint' : 'generation'} AS generation
            FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'}
            WHERE agent_id=$1 AND (dream_at BETWEEN $2::timestamptz AND $3::timestamptz OR dream_at IS NULL)`;
        await client.query(`DECLARE dream_timeline NO SCROLL CURSOR FOR
          SELECT r.* FROM ((${branch(true)}) UNION ALL (${branch(false)})) r
          ORDER BY session_id,source_store DESC,
            CASE WHEN source_store='live' THEN ordinal END ASC,
            generation DESC NULLS LAST,source_id DESC,ordinal ASC`,
          [required(agentId,'agentId'),since,until]);
        for (;;) {
          signal?.throwIfAborted();
          const { rows } = await client.query('FETCH FORWARD 256 FROM dream_timeline');
          for (const row of rows) {
            signal?.throwIfAborted();
            let ids = seen.get(row.session_id);
            if (!ids) { ids = new Set(); seen.set(row.session_id, ids); }
            if (row.entry?.id && ids.has(String(row.entry.id))) continue;
            if (row.entry?.id) ids.add(String(row.entry.id));
            entries.push({ ...row.entry, __sessionId: row.session_id, __storedAt: row.created_at });
          }
          if (rows.length < 256) break;
        }
        await client.query('CLOSE dream_timeline');
        // Legacy addEntries used the first truthy ID per session, even when
        // subsequent payloads differed. Id-less occurrences remain separate.
        // JS date parsing matches Dream eligibility for unknown legacy dates.
        const instant = entry => Date.parse(entry.timestamp ?? entry.ts ?? entry.at ?? entry.createdAt ?? entry.__storedAt);
        return entries.sort((a, b) => {
          const left = instant(a), right = instant(b);
          return (Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity) || 0;
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    }, { signal });
  }

  async dreamWindow({ agentId, since, until, signal } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      signal?.throwIfAborted();
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const abort = () => { void client.end?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // OFFSET 0 keeps the existence check parameterized by each candidate.
        // Without this fence PostgreSQL can decorrelate it into a merge anti-join,
        // sorting the entire retained authority again for every 256-row page.
        // The authority is deliberately NOT time-filtered: an out-of-window
        // occurrence can still supersede an in-window original.
        const entries = []; let after = null;
        for (;;) {
          signal?.throwIfAborted();
          const branch = live => `SELECT agent_id,session_id,'${live ? 'live' : 'archive'}'::text AS source_store,
            ${live ? 'sequence::text' : 'source_id'} AS source_id,${live ? 'sequence' : 'ordinal'} AS ordinal,entry,created_at,entry_key,${live ? 'NULL::bigint' : 'generation'} AS generation
            FROM ${live ? 'conversation_entries' : 'conversation_archive_entries'}
            WHERE agent_id=$1 AND (dream_at BETWEEN $2::timestamptz AND $3::timestamptz OR dream_at IS NULL)`;
          const { rows } = await client.query(`SELECT r.* FROM ((${branch(true)}) UNION ALL (${branch(false)})) r
            WHERE ($4::text IS NULL OR (session_id,source_store,source_id,ordinal)>($4,$5,$6,$7::bigint))
            AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
              WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
              AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND ${originalNewerSQL()} OFFSET 0)
            ORDER BY session_id,source_store,source_id,ordinal LIMIT 256`,
            [required(agentId,'agentId'),since,until,...(after || [null,null,null,null])]);
          for (const row of rows) entries.push({ ...row.entry, __sessionId: row.session_id,
            __storedAt: row.created_at });
          if (rows.length < 256) break;
          const last = rows.at(-1); after = [last.session_id,last.source_store,last.source_id,String(last.ordinal)];
        }
        return entries;
      } finally { signal?.removeEventListener('abort', abort); }
    });
  }

  async listOriginalEntriesById({ agentId: rawAgentId, sessionId: rawSessionId, entryIds, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    if (!Array.isArray(entryIds) || entryIds.some(id => typeof id !== 'string')) throw new TypeError('entry_ids_invalid');
    signal?.throwIfAborted();
    const ids = [...new Set(entryIds)];
    if (!ids.length) return [];
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const entries = [];
      for (let offset = 0; offset < ids.length; offset += 256) {
        signal?.throwIfAborted();
        const { rows } = await client.query(`SELECT winner.entry,winner.ordinal,winner.created_at,winner.source_store,winner.source_id
          FROM unnest($3::text[]) AS requested(entry_key)
          CROSS JOIN LATERAL (SELECT entry,ordinal,created_at,source_store,source_id
            FROM conversation_original_rows
            WHERE agent_id=$1 AND session_id=$2 AND burrow_history_key(entry_key)=burrow_history_key(requested.entry_key)
            ORDER BY CASE WHEN source_store='live' THEN 0 ELSE 1 END,
              CASE WHEN source_store='live' THEN ordinal END DESC,generation DESC NULLS LAST,source_id DESC,ordinal LIMIT 1) winner`,
        [agentId, sessionId, ids.slice(offset, offset + 256).map(id => JSON.stringify(id))]);
        for (const row of rows) entries.push({ entry: row.entry, ordinal: BigInt(row.ordinal), createdAt: row.created_at, store: row.source_store, sourceId: row.source_id });
      }
      signal?.throwIfAborted();
      return entries.sort((a,b) => String(a.entry.timestamp ?? a.entry.ts ?? a.createdAt).localeCompare(String(b.entry.timestamp ?? b.entry.ts ?? b.createdAt)) || (a.store === b.store ? (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : (a.sourceId < b.sourceId ? 1 : a.sourceId > b.sourceId ? -1 : 0)) : a.store === 'archive' ? -1 : 1)).map(row => row.entry);
    }, { signal });
  }

  async listOriginalEntries({ agentId: rawAgentId, sessionId: rawSessionId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const entries = []; const seen = new Set(); let position = null;
      for (;;) {
        signal?.throwIfAborted();
        const { rows } = await client.query(`SELECT source_store,source_id,ordinal,entry,created_at
          FROM conversation_original_rows r WHERE agent_id=$1 AND session_id=$2
          AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
            WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
            AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND ${originalNewerSQL()})
          AND ($3::text IS NULL OR
            (source_store,source_id,-ordinal)<($3::text,$4::text,-$5::bigint))
          ORDER BY source_store DESC,source_id DESC,ordinal ASC LIMIT 256`,
        [agentId, sessionId, ...(position || [null, null, null])]);
        // source_store DESC puts live before archive. Within a snapshot retain
        // the earliest duplicate occurrence, as resolveOriginal does.
        for (const row of rows) {
          const entry = row.entry;
          if (entry?.id && seen.has(entry.id)) continue;
          if (entry?.id) seen.add(entry.id);
          entries.push({ entry, ordinal: BigInt(row.ordinal), createdAt: row.created_at, store: row.source_store });
        }
        if (rows.length < 256) break;
        const last = rows.at(-1);
        position = [last.source_store, last.source_id, String(last.ordinal)];
      }
      return entries.sort((a,b) => String(a.entry.timestamp ?? a.entry.ts ?? a.createdAt).localeCompare(String(b.entry.timestamp ?? b.entry.ts ?? b.createdAt)) || (a.store === b.store ? (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0) : a.store === 'archive' ? -1 : 1)).map(row => row.entry);
    }, { signal });
  }

  async resolveOriginal({ agentId, sessionId, entryId }, client = this.pool) {
    // Compare lossless UTF-16 logical keys, including NUL and lone surrogates.
    const { rows } = await client.query(`SELECT entry FROM conversation_original_rows
      WHERE agent_id=$1 AND session_id=$2 AND burrow_history_key(entry_key)=burrow_history_key($3)
      ORDER BY CASE WHEN source_store='live' THEN 0 ELSE 1 END,CASE WHEN source_store='live' THEN ordinal END DESC,generation DESC NULLS LAST,source_id DESC,ordinal LIMIT 1`,
    [agentId, sessionId, JSON.stringify(entryId)]);
    return rows[0]?.entry || null;
  }

  async searchEvidencePage({ agentId, sessionId, query = '', includeResetHistory = false, after = null, limit = 256, signal, deadline } = {}) {
    // Automatic terse-continuation recall deliberately uses null for no filter.
    query = query ?? '';
    if (typeof query !== 'string') throw new TypeError('query must be a string or null');
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter(t => t.length >= 3) || [])];
    const grams = terms.map(t => [...new Set(Array.from({ length: t.length - 2 }, (_, i) => t.slice(i,i+3)))]);
    const candidate = grams.length ? `AND (r.has_compression_summary OR r.search_grams IS NULL OR ${grams.map((_,i) => `r.search_grams @> $${i+7}::text[]`).join(' OR ')})` : '';
    const { rows } = await sessionReadQuery(this.pool, `SELECT r.*, (r.archive_kind='reset' OR r.generation <= COALESCE((SELECT max(a.generation) FROM conversation_archives a WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1) OR (s.metadata->>'resetAt' IS NOT NULL AND r.created_at::timestamptz<=burrow_legacy_instant(s.metadata->>'resetAt'))) AS reset_archive FROM conversation_original_rows r
      JOIN conversation_sessions s USING(agent_id,session_id)
      WHERE r.agent_id=$1 AND r.session_id=$2
      AND ($3::text IS NULL OR (r.source_store,r.source_id,r.ordinal)>($3,$4,$5::bigint))
      AND (${includeResetHistory ? 'true' : 'false'} OR r.source_store='live' OR (r.archive_kind <> 'reset'
        AND r.generation > COALESCE((SELECT max(a.generation) FROM conversation_archives a
          WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1)
        AND (burrow_legacy_instant(s.metadata->>'resetAt') IS NULL OR r.created_at::timestamptz>burrow_legacy_instant(s.metadata->>'resetAt'))))
      AND NOT EXISTS (SELECT 1 FROM conversation_original_rows newer
        WHERE newer.agent_id=r.agent_id AND newer.session_id=r.session_id
        AND burrow_history_key(newer.entry_key)=burrow_history_key(r.entry_key) AND r.has_payload_id
        AND ${originalNewerSQL()})
      ${candidate}
      ORDER BY r.source_store,r.source_id,r.ordinal LIMIT $6`,
      [required(agentId,'agentId'),required(sessionId,'sessionId'),...(after || [null,null,null]),limit,...grams], { signal, deadline });
    const last = rows.at(-1);
    return { rows, next: rows.length === limit ? [last.source_store,last.source_id,String(last.ordinal)] : null };
  }

  async lastOperatorMessageAt({ agentId: rawAgentId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Adapter-installed v48 can be queried before its durable worker finishes.
      // Only scalar clocks leave PostgreSQL, not historical message bodies.
      const pendingSchema = (await client.query("SELECT to_regclass('burrow_operator_backfill') AS relation")).rows[0]?.relation;
      // Native typed indexes answer the normal hot path in one scalar query.
      // All retained generations count, including reset archives; no canonical
      // identity reconciliation or storage-time substitution is appropriate here.
      const { rows } = await client.query(`SELECT max(at) AS at FROM (
        SELECT max(operator_at) AS at FROM conversation_entries WHERE agent_id=$1 AND operator_at IS NOT NULL
        UNION ALL
        SELECT max(operator_at) AS at FROM conversation_archive_entries WHERE agent_id=$1 AND operator_at IS NOT NULL
      ) latest`, [agentId]);
      let newest = rows[0]?.at == null ? null : new Date(rows[0].at);
      // Only ambiguous legacy timestamps need JS Date semantics. Transfer the
      // scalar, never retained prose/payloads, and bound each batch.
      for (const [table, key] of [['conversation_entries','session_id,sequence'], ['conversation_archive_entries','session_id,source_id,ordinal']]) {
        let after = null;
        for (;;) {
          const archive = table === 'conversation_archive_entries';
          const { rows: legacy } = await client.query(`SELECT ${key},operator_ts_fallback AS ts FROM ${table}
            WHERE agent_id=$1 AND operator_ts_fallback IS NOT NULL
            AND ($2::text IS NULL OR (${key})>${archive ? '($2,$3,$4::bigint)' : '($2,$3::bigint)'})
            ORDER BY ${key} LIMIT 256`, [agentId,...(after || (archive ? [null,null,null] : [null,null]))]);
          for (const row of legacy) {
            const at = new Date(JSON.parse(row.ts));
            if (Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
          }
          if (legacy.length < 256) break;
          const last = legacy.at(-1);
          after = archive ? [last.session_id,last.source_id,String(last.ordinal)] : [last.session_id,String(last.sequence)];
        }
      }
      if (pendingSchema) {
        for (const [table,key] of [['conversation_entries','session_id,sequence'],['conversation_archive_entries','session_id,source_id,ordinal']]) {
          const archive = table === 'conversation_archive_entries';
          let after = null;
          for (;;) {
            const { rows: pending } = await client.query(`SELECT ${key},p.at,p.fallback AS ts FROM ${table} t
              LEFT JOIN LATERAL burrow_operator_projection(t.entry) p ON true
              WHERE agent_id=$1 AND NOT operator_projected
              AND ($2::text IS NULL OR (${key})>${archive ? '($2,$3,$4::bigint)' : '($2,$3::bigint)'})
              ORDER BY ${key} LIMIT 256`,[agentId,...(after || (archive ? [null,null,null] : [null,null]))]);
            for (const row of pending) {
              const at = row.at != null ? new Date(row.at) : row.ts != null ? new Date(JSON.parse(row.ts)) : null;
              if (at && Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
            }
            if (pending.length < 256) break;
            const last = pending.at(-1);
            after = archive ? [last.session_id,last.source_id,String(last.ordinal)] : [last.session_id,String(last.sequence)];
          }
        }
      }
      return newest?.toISOString() || null;
    }, { signal });
  }

  async exportRawEvidence({ agentId, sessionId } = {}) {
    return exportSessionRawEvidence({ pool: this.pool, agentId: required(agentId, 'agentId'), sessionId: required(sessionId, 'sessionId') });
  }

  async exportTranscript({ agentId, sessionId } = {}) {
    const result = await this.pool.query(`
      SELECT s.metadata,s.created_at,s.updated_at,
        COALESCE((SELECT json_agg((SELECT COALESCE(json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.ordinal),'[]'::json) FROM conversation_archive_entries e WHERE e.agent_id=a.agent_id AND e.session_id=a.session_id AND e.source_id=a.archive_id) ORDER BY a.generation,a.archive_id)
          FROM conversation_archives a WHERE a.agent_id=s.agent_id AND a.session_id=s.session_id
          AND a.kind='compacted' AND a.generation >= COALESCE(
            (s.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)), '[]'::json) AS history,
        COALESCE((SELECT json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.sequence) FROM conversation_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.session_id), '[]'::json) AS entries
      FROM conversation_sessions s WHERE s.agent_id=$1 AND s.session_id=$2`,
    [required(agentId, 'agentId'), required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    const entries = mergeTranscriptSnapshots([...row.history, row.entries]);
    return { schemaVersion: '1', session: { id: sessionId, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } }, entries };
  }

  async readArchiveTranscriptPage(args = {}) {
    return readArchiveTranscriptPage(this.pool, args);
  }

  async exportArchiveTranscript({ agentId, sessionId = null, archiveId } = {}) {
    const result = await this.pool.query(`WITH target AS (
      SELECT * FROM conversation_archives WHERE agent_id=$1 AND archive_id=$2
        AND kind='reset' AND ($3::text IS NULL OR session_id=$3)
      ORDER BY created_at DESC,session_id DESC LIMIT 1
    ) SELECT t.archive_id,t.session_id,t.generation,t.metadata,t.created_at,
      COALESCE((SELECT json_agg((SELECT COALESCE(json_agg(
          json_build_object('occurrence',e.entry_id,'entry',e.entry) ORDER BY e.ordinal),'[]'::json)
        FROM conversation_archive_entries e WHERE e.agent_id=a.agent_id
          AND e.session_id=a.session_id AND e.source_id=a.archive_id)
        ORDER BY a.generation,a.archive_id)
        FROM conversation_archives a WHERE a.agent_id=t.agent_id AND a.session_id=t.session_id
          AND a.kind='compacted' AND a.generation<=t.generation
          AND a.generation>=COALESCE((t.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=t.agent_id AND r.session_id=t.session_id
                AND r.kind='reset' AND r.generation<t.generation),0)), '[]'::json) AS history,
      COALESCE((SELECT json_agg(json_build_object('occurrence',e.entry_id,'entry',e.entry)
        ORDER BY e.ordinal) FROM conversation_archive_entries e
        WHERE e.agent_id=t.agent_id AND e.session_id=t.session_id AND e.source_id=t.archive_id),
        '[]'::json) AS entries FROM target t`,
    [required(agentId, 'agentId'), required(archiveId, 'archiveId'), sessionId == null ? null : required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    const entries = mergeTranscriptSnapshots([...row.history, row.entries]);
    return { schemaVersion: '1', archiveId: row.archive_id, sourceSessionId: row.metadata?.sourceSessionId || row.session_id,
      generation: Number(row.generation), createdAt: row.created_at,
      session: { id: row.archive_id, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.created_at, archivedAt: row.created_at, chatTurnCount: null } }, entries };
  }

  async listArchiveRunDirectory({ agentId: rawAgentId, sessionId: rawSessionId = null, limit = 100, boundary = null, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = rawSessionId == null ? null : required(rawSessionId, 'sessionId');
    const size = limitValue(limit);
    if (boundary && (typeof boundary.t !== 'string' || typeof boundary.i !== 'string')) throw new Error('archive_cursor_invalid');
    const { rows } = await readQuery(`SELECT r.agent_id,r.session_id,r.run_id,r.started_at,r.completed_at,r.last_activity_at,r.sort_timestamp,evidence.item AS evidence
      FROM conversation_archive_runs r LEFT JOIN conversation_sessions s ON s.agent_id=r.agent_id AND s.session_id=r.session_id
      LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(COALESCE(s.metadata->'runEvidence','[]'::jsonb)) item WHERE item->>'runId'=r.run_id LIMIT 1) evidence ON true
      WHERE r.agent_id=$1 AND ($2::text IS NULL OR r.session_id=$2)
      AND ($2::text IS NOT NULL OR NULLIF(s.metadata->'contextIsolation'->>'historySessionId','') IS NULL)
      AND ($3::text IS NULL OR (r.sort_timestamp,r.agent_id || ':' || r.run_id)<($3,$4))
      ORDER BY r.sort_timestamp DESC,r.agent_id || ':' || r.run_id DESC LIMIT $5`,
    [agentId, sessionId, boundary?.t || null, boundary?.i || null, size + 1]);
    const hasMore = rows.length > size;
    return { rows: (hasMore ? rows.slice(0, size) : rows).map(row => ({
      agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
      startedAt: row.started_at?.toISOString?.() || row.started_at || null,
      completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
      lastActivityAt: row.last_activity_at?.toISOString?.() || row.last_activity_at || null,
      sortTimestamp: row.sort_timestamp, evidence: row.evidence || null,
    })), hasMore };
  }

  async readArchiveRunSources({ agentId: rawAgentId, runs = [], signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const requested = (Array.isArray(runs) ? runs : []).filter(item => item?.sessionId && item?.runId);
    if (!requested.length) return [];
    const keys = requested.map(item => proofRunKey({ runId: item.runId }));
    const sessions = requested.map(item => String(item.sessionId));
    // A run can straddle any number of compactions and a reset. Fetch only the
    // exact requested (session, run) pairs through the existing run indexes;
    // both stores are read in one statement so compaction cannot hide a row.
    // Do not reserialize the JSON originals or select just the newest snapshot.
    const { rows } = await readQuery(`WITH requested AS MATERIALIZED (
      SELECT DISTINCT session_id,run_key FROM unnest($2::text[],$3::text[]) AS r(session_id,run_key)
      WHERE run_key IS NOT NULL
    ), occurrences AS (
      SELECT e.session_id,e.run_key,e.entry_id,e.entry,e.sequence::text AS sequence,
        1 AS priority,NULL::bigint AS generation,NULL::text AS source_id
      FROM conversation_entries e JOIN requested r USING(session_id,run_key)
      WHERE e.agent_id=$1 AND e.session_id=ANY($2::text[]) AND e.run_key=ANY($3::text[])
      UNION ALL
      SELECT e.session_id,e.run_key,e.entry_id,e.entry,e.ordinal::text AS sequence,
        0 AS priority,e.generation,e.source_id
      FROM conversation_archive_entries e JOIN requested r USING(session_id,run_key)
      WHERE e.agent_id=$1 AND e.session_id=ANY($2::text[]) AND e.run_key=ANY($3::text[])
    ) SELECT * FROM occurrences
      ORDER BY session_id,run_key,priority,generation ASC NULLS FIRST,source_id ASC,sequence::bigint`, [agentId,sessions,keys]);
    const grouped = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.session_id,row.run_key]);
      let group = grouped.get(key);
      if (!group) { group = { snapshots: [], source: null }; grouped.set(key,group); }
      // Within an archive the earliest duplicate wins; newer generations and
      // source IDs replace it. Live originals take precedence, with a later live
      // sequence winning if legacy payload IDs collide. Id-less retained copies
      // use their relational entry_id; equal-content distinct rows stay distinct.
      const source = row.source_id === null ? `live:${row.sequence}` : `archive:${row.source_id}`;
      if (source !== group.source) { group.snapshots.push([]); group.source = source; }
      group.snapshots.at(-1).push({ entry: rowEntry(row), occurrence: row.entry_id });
    }
    const metadataRows = await readQuery('SELECT session_id,metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=ANY($2::text[])', [agentId,[...new Set(sessions)]]);
    const metadata = new Map(metadataRows.rows.map(row => [row.session_id,row.metadata]));
    return requested.map((item,index) => {
      const group = grouped.get(JSON.stringify([sessions[index],keys[index]]));
      const entries = mergeTranscriptSnapshots(group?.snapshots || []).sort((left,right) => {
        const at = String(left.ts || '').localeCompare(String(right.ts || ''));
        if (at) return at;
        const a = BigInt(left.sequence), b = BigInt(right.sequence);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const evidence = (Array.isArray(metadata.get(sessions[index])?.runEvidence) ? metadata.get(sessions[index]).runEvidence : []).find(value => value?.runId===item.runId) || null;
      return { sessionId:sessions[index],runId:item.runId,entries,evidence };
    });
  }

  async readArchiveRunSource({ agentId: rawAgentId, sessionId: rawSessionId = null, runId: rawRunId, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const runId = required(rawRunId, 'runId');
    const sessionId = rawSessionId == null ? null : required(rawSessionId, 'sessionId');
    const key = JSON.stringify(runId);
    const located = await readQuery(`SELECT session_id FROM conversation_archive_runs
      WHERE agent_id=$1 AND run_key=encode(convert_to($2,'UTF8'),'hex') AND ($3::text IS NULL OR session_id=$3)
      ORDER BY sort_timestamp DESC,session_id DESC LIMIT 1`, [agentId, key, sessionId]);
    const sid = located.rows[0]?.session_id;
    if (!sid) return null;
    const [source] = await this.readArchiveRunSources({ agentId, runs: [{ sessionId: sid, runId }], signal, deadline });
    return { sessionId: sid, entries: source.entries, evidence: source.evidence };
  }

  async listArchiveSessions({ agentId: rawAgentId, includeArchived = true, query = '', date = null, month = null, timezone = 'UTC', limit = 100, boundary = null, signal, deadline } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const size = limitValue(limit);
    const search = text(query).trim().toLowerCase();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('archive_date_invalid');
    if (month && !/^\d{4}-\d{2}$/.test(String(month))) throw new Error('archive_month_invalid');
    if (boundary && (typeof boundary.t !== 'string' || typeof boundary.i !== 'string'
      || (boundary.t !== '' && (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(boundary.t)
        || !Number.isFinite(Date.parse(boundary.t.replace(/([+-]\d{2})$/, '$1:00'))))))) throw new Error('archive_cursor_invalid');
    const windowKey = date || (month ? `${month}-01` : null);
    const windowStart = windowKey ? new Date(`${windowKey}T00:00:00Z`) : null;
    const windowEnd = windowStart ? new Date(windowStart) : null;
    if (windowStart) windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    if (windowEnd) date ? windowEnd.setUTCDate(windowEnd.getUTCDate() + 2) : windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 1, 2);
    return withArchiveRead(this.pool, async client => {
    await this.hasArchiveDateProjection(client);
    const sortTime = this.archiveNativeCatalogTime ? 'updated_at' : 'burrow_legacy_instant(updated_at::text)';
    const days = windowKey ? archiveOccurrenceDaysSQL({ start: '$10', end: '$11', timezone: '$6' }) : null;
    let countCache = resetListingCountsByPool.get(this.pool);
    if (!countCache) { countCache = new Map(); resetListingCountsByPool.set(this.pool, countCache); }
    const cacheArg = days ? '$12' : '$10';
    const { rows } = await client.query( `WITH ${archiveRowsSQL()}${days ? `, ${days}` : ''}, bounded AS (
      SELECT *,agent_id || ':' || id AS identity,
        COALESCE(to_char(${sortTime} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS sort_timestamp FROM archive_rows
      WHERE ($3::text='' OR lower(concat_ws(' ',id,session_id,source_session_id,metadata->>'archiveTitle',metadata->>'title',metadata->>'name',metadata->>'summary',metadata->>'archiveSummary')) LIKE '%' || $3 || '%')
      AND (($4::text IS NULL AND $5::text IS NULL)
        OR (($4::text IS NULL OR to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $6,'YYYY-MM-DD')=$4)
          AND ($5::text IS NULL OR to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $6,'YYYY-MM')=$5))
        ${days ? `OR EXISTS (SELECT 1 FROM matched_days m WHERE m.agent_id=archive_rows.agent_id AND m.id=archive_rows.id
          AND ($4::text IS NULL OR m.day=$4) AND ($5::text IS NULL OR left(m.day,7)=$5))` : ''})
      AND ($7::text IS NULL
        OR ($7::text='' AND ${sortTime} IS NULL AND (agent_id || ':' || id) COLLATE "C"<$8::text COLLATE "C")
        OR ($7::text<>'' AND (${sortTime} IS NULL OR (${sortTime},(agent_id || ':' || id) COLLATE "C")<(NULLIF($7::text,'')::timestamptz,$8::text COLLATE "C"))))
      ORDER BY ${sortTime} DESC NULLS LAST,(agent_id || ':' || id) COLLATE "C" DESC LIMIT $9
    ), reset_versions AS MATERIALIZED (
      -- Include the exact effective window and each contributing source version.
      -- The epoch handles TRUNCATE; changing a prior reset changes min_generation.
      SELECT b.agent_id,b.session_id,b.id,
        jsonb_build_array(b.agent_id,b.session_id,b.id,b.min_generation,b.max_generation,
          (SELECT revision FROM conversation_archive_revision_epoch WHERE singleton),
          (SELECT revision FROM conversation_archive_revisions r WHERE r.agent_id=b.agent_id
            AND r.session_id=b.session_id AND r.scope='source' AND r.source_id=b.id),
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(a.archive_id,a.generation,r.revision)
                ORDER BY a.generation,a.archive_id),'[]'::jsonb)
           FROM conversation_archives a LEFT JOIN conversation_archive_revisions r
             ON r.agent_id=a.agent_id AND r.session_id=a.session_id AND r.scope='source' AND r.source_id=a.archive_id
           WHERE a.agent_id=b.agent_id AND a.session_id=b.session_id AND a.kind='compacted'
             AND a.generation>=b.min_generation AND a.generation<=b.max_generation))::text AS cache_key
      FROM bounded b WHERE b.archive_snapshot
    ), cached_counts AS MATERIALIZED (
      SELECT v.*,cache.turn_count FROM reset_versions v
      LEFT JOIN jsonb_to_recordset(${cacheArg}::jsonb) AS cache(cache_key text,turn_count bigint)
        ON cache.cache_key=v.cache_key
    ), missing AS MATERIALIZED (
      SELECT b.*,v.cache_key FROM bounded b JOIN cached_counts v USING(agent_id,session_id,id)
      WHERE v.turn_count IS NULL
    ), counts AS MATERIALIZED (
      SELECT missing.agent_id,missing.session_id,missing.id,
        (SELECT count(DISTINCT identity COLLATE "C") FROM (
        SELECT COALESCE(
          'p:' || ${archivePayloadKeySQL('e')},
          'o:' || NULLIF(e.entry_id,''),
          'r:' || json_build_array('archive',e.source_store,e.source_id,e.ordinal::text)::text) AS identity
        FROM conversation_archives a JOIN conversation_archive_entries e
          ON e.agent_id=a.agent_id AND e.session_id=a.session_id AND e.source_id=a.archive_id
        WHERE a.agent_id=missing.agent_id AND a.session_id=missing.session_id
          AND ((a.archive_id=missing.id AND a.kind='reset') OR
            (a.kind='compacted' AND a.generation>=missing.min_generation AND a.generation<=missing.max_generation))
      ) occurrences) AS turn_count FROM missing
    ) SELECT bounded.agent_id,bounded.session_id,bounded.id,bounded.source_session_id,
      bounded.archive_snapshot,bounded.created_at,bounded.updated_at,bounded.identity,bounded.sort_timestamp,
      cached_counts.cache_key,
      CASE WHEN archive_snapshot THEN COALESCE(cached_counts.turn_count,counts.turn_count)
      WHEN bounded.metadata->>'turnCount' ~ '^[0-9]+$' THEN (bounded.metadata->>'turnCount')::bigint ELSE 0 END AS turn_count,
      (bounded.metadata - 'runEvidence') AS projected_metadata
      FROM bounded LEFT JOIN counts ON counts.agent_id=bounded.agent_id AND counts.session_id=bounded.session_id AND counts.id=bounded.id
        LEFT JOIN cached_counts ON cached_counts.agent_id=bounded.agent_id AND cached_counts.session_id=bounded.session_id AND cached_counts.id=bounded.id
      ORDER BY ${sortTime} DESC NULLS LAST,identity COLLATE "C" DESC`,
    [...[agentId, Boolean(includeArchived), search, date, month, timezone, boundary?.t ?? null, boundary?.i ?? null, size + 1, windowStart?.toISOString() || null, windowEnd?.toISOString() || null].slice(0, days ? 11 : 9),
      JSON.stringify([...countCache].map(([cache_key, turn_count]) => ({ cache_key, turn_count })))]);
    for (const row of rows) if (row.archive_snapshot && row.cache_key && row.turn_count != null && !countCache.has(row.cache_key)) {
      if (countCache.size >= RESET_LISTING_COUNT_CACHE_LIMIT) countCache.delete(countCache.keys().next().value);
      countCache.set(row.cache_key, Number(row.turn_count));
    }
    const hasMore = rows.length > size;
    return { rows: (hasMore ? rows.slice(0, size) : rows).map(row => ({
      id: row.id, sessionId: row.id, sourceSessionId: row.source_session_id,
      archiveSnapshot: row.archive_snapshot ? 'reset' : null, metadata: row.archive_snapshot
        ? { ...row.projected_metadata, archiveTranscriptTurnCount: Number(row.turn_count), archivedAt: row.created_at, chatTurnCount: null } : row.projected_metadata,
      ...(date ? { matchedDate: String(date) } : {}),
      turnCount: Number(row.turn_count), createdAt: row.created_at, updatedAt: row.updated_at,
      // Exact UTC microseconds survive pg/JS Date's millisecond normalization.
      // Empty sorts strictly after known clocks and is a real cursor position.
      sortTimestamp: row.sort_timestamp, identity: row.identity,
    })), hasMore };
    }, { signal, deadline });
  }

  async listArchiveCalendarDates({ agentId: rawAgentId, month, timezone = 'UTC', signal, deadline } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const safeStart = new Date(monthStart); safeStart.setUTCDate(safeStart.getUTCDate() - 1);
    const safeEnd = new Date(monthStart); safeEnd.setUTCMonth(safeEnd.getUTCMonth() + 1, 2);
    return withArchiveRead(this.pool, async client => {
    const days = archiveOccurrenceDaysSQL({ start: '$4', end: '$5', timezone: '$3' });
    const { rows } = await client.query( `WITH ${archiveRowsSQL()}, ${days}
      SELECT DISTINCT day FROM (
        SELECT to_char(burrow_legacy_instant(updated_at::text) AT TIME ZONE $3,'YYYY-MM-DD') AS day
          FROM archive_rows WHERE burrow_legacy_instant(updated_at::text)>=$4::timestamptz AND burrow_legacy_instant(updated_at::text)<$5::timestamptz
        UNION ALL SELECT day FROM matched_days
      ) archive_days WHERE day LIKE $6 || '-%' ORDER BY day`,
    [agentId, true, timezone, safeStart.toISOString(), safeEnd.toISOString(), month]);
    return rows.map(row => row.day);
    }, { signal, deadline });
  }

  async listArchives({ agentId: rawAgentId, sessionId: rawSessionId, limit = 100, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const params = [agentId]; let where = 'agent_id=$1';
    if (rawSessionId != null) { params.push(required(rawSessionId, 'sessionId')); where += ` AND session_id=$${params.length}`; }
    if (rawSessionId == null) where += ` AND NULLIF(metadata->'contextIsolation'->>'historySessionId','') IS NULL`;
    const unbounded = limit === null;
    if (!unbounded) params.push(limitValue(limit));
    const result = await readQuery(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE ${where} ORDER BY generation DESC, created_at DESC, archive_id DESC${unbounded ? '' : ` LIMIT $${params.length}`}`, params);
    return result.rows.map((row) => ({ archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at }));
  }

  async readArchiveById({ agentId: rawAgentId, archiveId, kind = null, signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const id = required(archiveId, 'archiveId');
    const result = await readQuery(`SELECT archive_id,session_id,generation,kind,
      COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e
        WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id
        AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at
      FROM conversation_archives WHERE agent_id=$1 AND archive_id=$2 AND ($3::text IS NULL OR kind=$3)
      ORDER BY created_at DESC,session_id DESC LIMIT 1`, [agentId, id, kind]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }

  async readArchive({ agentId: rawAgentId, sessionId: rawSessionId, archiveId } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const id = required(archiveId, 'archiveId');
    const result = await this.pool.query(`SELECT archive_id,session_id,generation,kind,COALESCE((SELECT json_agg(e.entry ORDER BY e.ordinal) FROM conversation_archive_entries e WHERE e.agent_id=conversation_archives.agent_id AND e.session_id=conversation_archives.session_id AND e.source_id=conversation_archives.archive_id),'[]'::json) AS entries,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3`, [agentId, sid, id]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isChatMessage } from './session-entry.mjs';
import { archiveOccurrenceTokenSQL, archivePayloadKeySQL, archiveTruthyPayloadSQL, archiveVisibleMessageSQL } from './postgres-archive-lexical.mjs';
import { withArchiveRead } from './postgres-archive-read.mjs';

const required = (value, name) => {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
};

// Same accepted interval syntax and microsecond rounding as the existing
// Archive detail projection. PostgreSQL does the actual instant comparison.
function validInstant(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2})(?::?(\d{2}))?))?$/.exec(value);
  if (!match || match[1].startsWith('0000')) return false;
  const midnight = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== match[1]) return false;
  const hour = Number(match[2] || 0), minute = Number(match[3] || 0), second = Number(match[4] || 0);
  const offsetHour = Number(match[8] || 0), offsetMinute = Number(match[9] || 0);
  if (hour > 24 || minute > 59 || second > 60 || offsetHour > 15 || offsetMinute > 59) return false;
  const fraction = Number(`0.${match[5] || '0'}`) * 1e6;
  let micros = Math.floor(fraction);
  if (fraction - micros > 0.5 || (fraction - micros === 0.5 && micros % 2 === 1)) micros++;
  const seconds = (hour * 60 + minute) * 60 + second;
  return seconds <= 86400 && (seconds !== 86400 || micros === 0);
}

function pageSize(value) {
  // Match the HTTP boundary's boundedInteger, including numeric strings.
  const number = Number(value === undefined ? 100 : value);
  return Number.isFinite(number) ? Math.max(1, Math.min(500, Math.floor(number))) : 100;
}

const mac = (secret, body) => createHmac('sha256', secret).update(body).digest();
function makeCursor(secret, scope, revision, position) {
  const body = Buffer.from(JSON.stringify({ v: 1, scope: mac(secret, JSON.stringify(scope)).toString('base64url'), revision, position })).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}
function parseCursor(secret, before, scope) {
  if (!before) return null;
  try {
    if (typeof before !== 'string' || before.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(before)) throw Error();
    const [body, signature] = before.split('.');
    const expected = mac(secret, body), actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const position = parsed.position;
    const integer = value => typeof value === 'string' && /^-?\d{1,19}$/.test(value) && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
    if (parsed.v !== 1 || parsed.scope !== mac(secret, JSON.stringify(scope)).toString('base64url') || typeof parsed.revision !== 'string'
      || !position || !['terminal', 'archive'].includes(position.kind) || !integer(position.ordinal)
      || (position.kind === 'archive' && (typeof position.source !== 'string' || !integer(position.generation)))) throw Error();
    return parsed;
  } catch { throw new Error('archive_cursor_invalid'); }
}

// Both exports select snapshot windows from the archive catalog, not the copies'
// denormalized generation/kind fields. Later reset/live data must never alter an
// older reset. $1..$5 are agent, source session, terminal archive (or NULL),
// minimum generation, and maximum generation (or NULL for a live transcript).
const compactWindow = `a.agent_id=$1 AND a.session_id=$2 AND a.kind='compacted'
  AND a.generation >= $4::bigint AND ($5::bigint IS NULL OR a.generation <= $5::bigint)`;

const targetSQL = `WITH target AS (
  SELECT a.agent_id,a.session_id,a.archive_id,a.generation,a.metadata,a.created_at,json_build_array(a.xmin::text,a.ctid::text)::text AS revision
  FROM conversation_archives a WHERE a.agent_id=$1 AND a.archive_id=$2 AND a.kind='reset'
  ORDER BY a.created_at DESC,a.session_id DESC LIMIT 1
), selected AS (
  SELECT true AS reset,t.session_id AS source,t.archive_id,t.generation,t.metadata,t.created_at,t.created_at AS updated_at,t.revision,
    COALESCE((t.metadata->>'resetGeneration')::bigint,
      (SELECT max(r.generation)+1 FROM conversation_archives r WHERE r.agent_id=t.agent_id
        AND r.session_id=t.session_id AND r.kind='reset' AND r.generation<t.generation),0) AS min_generation
  FROM target t
  UNION ALL
  SELECT false,s.session_id,NULL::text,NULL::bigint,s.metadata,s.created_at,s.updated_at,json_build_array(s.xmin::text,s.ctid::text)::text,
    COALESCE((s.metadata->>'resetGeneration')::bigint,
      (SELECT max(r.generation)+1 FROM conversation_archives r WHERE r.agent_id=s.agent_id
        AND r.session_id=s.session_id AND r.kind='reset'),0)
  FROM conversation_sessions s WHERE s.agent_id=$1 AND s.session_id=$2 AND NOT EXISTS(SELECT 1 FROM target)
) SELECT * FROM selected`;

// Only row coordinates and PostgreSQL row versions enter the digest, never
// retained prose. A row insert/update/delete, snapshot-window edit, or change
// of a catalog generation changes this scalar revision. Two independently
// seeded 64-bit hashes accumulated without overflow plus cardinality avoid building an unbounded
// string_agg or crossing the SQL/Node boundary with history. Read under the
// same repeatable-read transaction as the subsequent pages.
const revisionSQL = `SELECT count(*)::text AS n,
  COALESCE(sum(hashtextextended(stamp,0)::numeric),0)::text AS h1,
  COALESCE(sum(hashtextextended(stamp,1)::numeric),0)::text AS h2
 FROM (
  SELECT json_build_array('catalog',a.archive_id,a.generation::text,a.xmin::text,a.ctid::text)::text AS stamp
    FROM conversation_archives a WHERE ${compactWindow}
  UNION ALL
  SELECT json_build_array('archived',e.source_store,e.source_id,e.ordinal::text,e.xmin::text,e.ctid::text)::text
    FROM conversation_archive_entries e JOIN conversation_archives a
      ON a.agent_id=e.agent_id AND a.session_id=e.session_id AND a.archive_id=e.source_id
    WHERE ${compactWindow}
  UNION ALL
  SELECT json_build_array('reset',e.source_store,e.source_id,e.ordinal::text,e.xmin::text,e.ctid::text)::text
    FROM conversation_archive_entries e WHERE $3::text IS NOT NULL AND e.agent_id=$1 AND e.session_id=$2 AND e.source_id=$3
  UNION ALL
  SELECT json_build_array('live',e.sequence::text,e.xmin::text,e.ctid::text)::text
    FROM conversation_entries e WHERE $3::text IS NULL AND e.agent_id=$1 AND e.session_id=$2
 ) versions`;

// A logical occurrence without a payload or relational ID is its own position.
// Keys use lossless UTF-16 encoding for payload IDs, and disjoint prefixes for
// payload/relational/anonymous identity just like mergeTranscriptSnapshots.
const identity = alias => `COALESCE('p:' || ${archivePayloadKeySQL(alias)},
  'o:' || NULLIF(${alias}.entry_id,''), 'r:' || ${alias}.row_identity)`;
const countSQL = `SELECT count(DISTINCT identity COLLATE "C")::text AS count FROM (
  SELECT ${identity('e')} AS identity FROM (
    SELECT e.entry_key,e.entry,e.has_payload_id,e.entry_id,
      json_build_array('archive',e.source_store,e.source_id,e.ordinal::text)::text AS row_identity
    FROM conversation_archive_entries e JOIN conversation_archives a
      ON a.agent_id=e.agent_id AND a.session_id=e.session_id AND a.archive_id=e.source_id
    WHERE ${compactWindow} OR (a.agent_id=$1 AND a.session_id=$2 AND a.archive_id=$3 AND a.kind='reset')
    UNION ALL
    SELECT e.entry_key,e.entry,e.has_payload_id,e.entry_id,
      json_build_array('live',e.sequence::text)::text
    FROM conversation_entries e WHERE $3::text IS NULL AND e.agent_id=$1 AND e.session_id=$2
  ) e
) identities`;

// Indexed probes for ordinary string IDs and relational IDs. Scalar-coercion
// fallback handles non-string IDs, falsey IDs, and grandfathered projections.
// A truthy [] has payload identity "", which is distinct from a falsey id.
function identityBranches(candidate, other, anonymous) {
  return [
    `${candidate}.payload_key IS NOT NULL AND ${candidate}.payload_key<>'' AND ${other}.has_payload_id
      AND burrow_history_key(${other}.entry_key)=${candidate}.payload_key AND ${archiveTruthyPayloadSQL(other)}`,
    `${candidate}.payload_key IS NOT NULL AND ${other}.has_payload_id IS DISTINCT FROM false
      AND burrow_history_key(${other}.entry_key) IS NULL AND ${archivePayloadKeySQL(other)}=${candidate}.payload_key`,
    `${candidate}.payload_key IS NOT NULL AND ${other}.has_payload_id IS NULL
      AND burrow_history_key(${other}.entry_key) IS NOT NULL AND ${archivePayloadKeySQL(other)}=${candidate}.payload_key`,
    `${candidate}.payload_key IS NULL AND NULLIF(${candidate}.entry_id,'') IS NOT NULL
      AND ${other}.entry_id<>'' AND ${other}.entry_id=${candidate}.entry_id AND NOT ${archiveTruthyPayloadSQL(other)}`,
    `${candidate}.payload_key IS NULL AND NULLIF(${candidate}.entry_id,'') IS NULL AND ${anonymous}`,
  ];
}

// Work one ordered snapshot at a time. The source/ordinal keyset is exclusive;
// neither OFFSET nor an array of retained transcript bodies is used. A row is
// emitted only at its *first* occurrence; the correlated winner is the first
// duplicate within the latest snapshot. Visibility/date apply to that winner.
function snapshotPageSQL(kind) {
  const live = kind === 'live', terminal = kind !== 'compact';
  const table = live ? 'conversation_entries' : 'conversation_archive_entries';
  const ordinal = live ? 'e.sequence' : 'e.ordinal';
  const whereSource = live ? '' : 'AND e.source_id=$6';
  const candidatePosition = terminal ? 'true' : `(a.generation<$7::bigint OR
    (a.generation=$7::bigint AND (a.archive_id<$6 OR (a.archive_id=$6 AND n.ordinal<c.ordinal))))`;
  const archiveProbe = `FROM conversation_archive_entries n
    JOIN conversation_archives a ON a.agent_id=n.agent_id AND a.session_id=n.session_id AND a.archive_id=n.source_id`;
  const priorArchive = identityBranches('c', 'n', 'false').slice(0, -1).map(match => `NOT EXISTS (SELECT 1 ${archiveProbe}
    WHERE ${compactWindow} AND ${candidatePosition} AND ${match} OFFSET 0)`).join(' AND ');
  const priorTerminal = !terminal ? 'true' : identityBranches('c', 'n', 'false').slice(0, -1).map(match => {
    const from = live ? 'FROM conversation_entries n' : 'FROM conversation_archive_entries n';
    const position = live ? 'n.sequence<c.ordinal' : 'n.source_id=$3 AND n.ordinal<c.ordinal';
    return `NOT EXISTS (SELECT 1 ${from} WHERE n.agent_id=$1 AND n.session_id=$2 AND ${position} AND ${match} OFFSET 0)`;
  }).join(' AND ');
  const archiveAnonymous = live ? 'false' : `(n.source_store=c.source_store AND n.source_id=c.source_id AND n.ordinal=c.ordinal)`;
  const liveAnonymous = live ? 'n.sequence=c.ordinal' : 'false';
  const winnerLive = identityBranches('c','n',liveAnonymous).map(match => `
    (SELECT 'live'::text AS store,'live'::text AS source_store,n.sequence::text AS source_id,
      n.sequence AS ordinal,n.entry,n.search_projection,2 AS rank,NULL::bigint AS generation
     FROM conversation_entries n WHERE $3::text IS NULL AND n.agent_id=$1 AND n.session_id=$2
       AND ${match} ORDER BY n.sequence LIMIT 1)`);
  const winnerArchive = identityBranches('c','n',archiveAnonymous).map(match => `
    (SELECT 'archive'::text AS store,n.source_store,n.source_id,n.ordinal,n.entry,n.search_projection,
      CASE WHEN a.archive_id=$3 THEN 2 ELSE 1 END AS rank,a.generation
     ${archiveProbe}
     WHERE (${compactWindow} OR (a.agent_id=$1 AND a.session_id=$2 AND a.archive_id=$3 AND a.kind='reset'))
       AND ${match}
     ORDER BY rank DESC,a.generation DESC,n.source_id DESC,n.ordinal LIMIT 1)`);
  const token = archiveOccurrenceTokenSQL('f');
  return `WITH candidates AS (
    SELECT e.entry,e.entry_id,e.entry_key,e.has_payload_id,${ordinal} AS ordinal,
      ${live ? "'live'::text AS source_store,e.sequence::text AS source_id" : 'e.source_store,e.source_id'},
      ${archivePayloadKeySQL('e')} AS payload_key
    FROM ${table} e WHERE e.agent_id=$1 AND e.session_id=$2 ${whereSource}
      AND $6::text IS NOT DISTINCT FROM $6::text AND $7::bigint IS NOT DISTINCT FROM $7::bigint
      AND ($8::bigint IS NULL OR ${ordinal}<$8::bigint)
  ) SELECT c.ordinal::text AS ordinal,w.store,w.source_store,w.source_id,w.ordinal::text AS winner_ordinal
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT choices.* FROM (
        ${[...winnerLive,...winnerArchive].join(' UNION ALL ')}
      ) choices ORDER BY rank DESC,generation DESC,CASE WHEN rank=1 THEN source_id END DESC,ordinal LIMIT 1
    ) w
    CROSS JOIN LATERAL (SELECT burrow_archive_fields(w.entry) AS fields,
      COALESCE(w.search_projection,burrow_json_member(w.entry,'content')::text,'') AS search_projection OFFSET 0) f
    WHERE ${priorArchive} AND ${priorTerminal}
      AND ${archiveVisibleMessageSQL('f')}
      AND (($9::text IS NULL AND $10::text IS NULL) OR (
        json_typeof((${token})::json)='string'
        AND ($9::text IS NULL OR burrow_archive_instant((${token})::json)>=$9::timestamptz)
        AND ($10::text IS NULL OR burrow_archive_instant((${token})::json)<=$10::timestamptz)))
    ORDER BY c.ordinal DESC LIMIT $11`;
}

const livePageSQL = snapshotPageSQL('live');
const resetPageSQL = snapshotPageSQL('reset');
const compactPageSQL = snapshotPageSQL('compact');
const nextSourceSQL = `SELECT a.archive_id,a.generation::text FROM conversation_archives a
 WHERE ${compactWindow} AND $3::text IS NOT DISTINCT FROM $3::text AND ($6::bigint IS NULL OR
    a.generation<$6::bigint OR (a.generation=$6::bigint AND a.archive_id<$7))
 ORDER BY a.generation DESC,a.archive_id DESC LIMIT 1`;

const hydrationSQL = `SELECT requested.position,e.entry FROM
  unnest($3::integer[],$4::text[],$5::text[],$6::bigint[]) requested(position,source_store,source_id,ordinal)
  JOIN conversation_archive_entries e ON e.agent_id=$1 AND e.session_id=$2 AND e.source_store=requested.source_store
    AND e.source_id=requested.source_id AND e.ordinal=requested.ordinal
 UNION ALL
 SELECT requested.position,e.entry FROM
  unnest($3::integer[],$4::text[],$5::text[],$6::bigint[]) requested(position,source_store,source_id,ordinal)
  JOIN conversation_entries e ON e.agent_id=$1 AND e.session_id=$2 AND requested.source_store='live'
    AND e.sequence=requested.ordinal
 ORDER BY position`;

export async function readArchiveTranscriptPage(pool, {
  agentId: rawAgentId, sessionId: rawSessionId, limit, before = null, from = null, to = null,
  signal, deadline, cursorSecret,
} = {}) {
  const agentId = required(rawAgentId, 'agentId'), sessionId = required(rawSessionId, 'sessionId');
  if ((from && !validInstant(from)) || (to && !validInstant(to))) throw new Error('archive_date_invalid');
  if (!(typeof cursorSecret === 'string' && cursorSecret.length || Buffer.isBuffer(cursorSecret) && cursorSecret.length)) throw new Error('archive_cursor_secret_required');
  const scope = [agentId, sessionId, from, to];
  const cursor = parseCursor(cursorSecret, before, scope), size = pageSize(limit);
  return withArchiveRead(pool, async client => {
    const target = (await client.query(targetSQL, [agentId, sessionId])).rows[0];
    if (!target) return null;
    const params = [agentId, target.source, target.reset ? target.archive_id : null,
      String(target.min_generation), target.reset ? String(target.generation) : null];
    const version = (await client.query(revisionSQL, params)).rows[0];
    const revision = mac(cursorSecret, JSON.stringify([target.reset, target.source, target.archive_id, String(target.generation),
      String(target.min_generation), target.revision, version.n, version.h1, version.h2])).toString('base64url');
    if (cursor && cursor.revision !== revision) throw new Error('archive_cursor_invalid');
    // Live detail historically advertises the metadata tail count (or page
    // length), whereas resets advertise the complete reconstructed count.
    const count = target.reset ? Number((await client.query(countSQL, params)).rows[0].count) : null;
    const found = [];
    let snapshot = cursor?.position?.kind === 'archive'
      ? { kind: 'compact', source: cursor.position.source, generation: cursor.position.generation, before: cursor.position.ordinal }
      : { kind: target.reset ? 'reset' : 'live', source: target.archive_id, generation: null, before: cursor?.position?.ordinal ?? null };
    // PostgreSQL resolves a bare date's timestamptz using the borrowed
    // connection's TimeZone. Archive interval semantics instead define it as
    // midnight UTC. Only normalize query binds: the cursor scope above must
    // remain tied to the original spelling supplied by the caller.
    const utcBind = value => value ? (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value) : null;
    const lower = utcBind(from), upper = utcBind(to);
    while (snapshot && found.length <= size) {
      signal?.throwIfAborted();
      const query = snapshot.kind === 'live' ? livePageSQL : snapshot.kind === 'reset' ? resetPageSQL : compactPageSQL;
      const result = await client.query(query, [...params, snapshot.source, snapshot.generation, snapshot.before, lower, upper, size + 1 - found.length]);
      for (const row of result.rows) found.push({ ...row, position: snapshot.kind === 'compact'
        ? { kind: 'archive', source: snapshot.source, generation: snapshot.generation, ordinal: row.ordinal }
        : { kind: 'terminal', ordinal: row.ordinal } });
      if (found.length > size) break;
      const previous = snapshot.kind === 'compact' ? snapshot : null;
      const next = (await client.query(nextSourceSQL, [...params, previous?.generation ?? null, previous?.source ?? null])).rows[0];
      snapshot = next ? { kind: 'compact', source: next.archive_id, generation: next.generation, before: null } : null;
    }
    const selected = found.slice(0, size);
    const payloads = selected.length ? (await client.query(hydrationSQL, [agentId, target.source,
      selected.map((_, index) => index), selected.map(row => row.source_store),
      selected.map(row => row.source_id), selected.map(row => row.winner_ordinal)])).rows : [];
    if (payloads.length !== selected.length) throw new Error('archive_snapshot_invalid');
    // SQL has to decide eligibility before LIMIT; never silently return a row
    // that the canonical predicate would reject if legacy projections drift.
    if (payloads.some(row => !isChatMessage(row.entry))) throw new Error('archive_projection_invalid');
    const entries = payloads.map(row => row.entry).reverse();
    const hasMore = found.length > size;
    const metadata = { ...target.metadata, createdAt: target.created_at, updatedAt: target.updated_at };
    const sourceSessionId = target.reset ? target.metadata?.sourceSessionId || target.source : target.source;
    return { entries, hasMore, nextCursor: hasMore ? makeCursor(cursorSecret, scope, revision, selected.at(-1).position) : null,
      historyStatus: 'complete', metadata, turnCount: target.reset ? count : metadata.turnCount ?? entries.length, archiveSnapshot: target.reset ? 'reset' : null,
      sourceSessionId, createdAt: target.created_at, updatedAt: target.updated_at,
      summary: target.reset ? target.metadata?.summary : metadata.summary,
      summaryStatus: target.metadata?.summaryStatus, title: target.metadata?.archiveTitle };
  }, { signal, deadline });
}

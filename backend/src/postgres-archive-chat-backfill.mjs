import { withPostgresTransaction } from './postgres-foundation.mjs';

// Existing PK indexes provide a durable ordered walk without adding a large
// index of all legacy rows during migration. The row-locked singleton serializes
// workers from different processes. Each batch locks at most batchSize originals
// (never UPDATEs them), inserts projections, and advances its checkpoint in the
// same transaction. No SKIP LOCKED: skipping a key would make the durable
// checkpoint incomplete. A contended row times out, rolls back, and is retried.
// The ordered window visits at most batchSize keys even if most are new rows.
const SOURCES = {
  live: {
    table: 'conversation_entries', side: 'conversation_live_chat_grandfathered',
    keys: ['agent_id', 'session_id', 'sequence'],
    state: ['live_agent', 'live_session', 'live_sequence'], done: 'live_done',
  },
  archive: {
    table: 'conversation_archive_entries', side: 'conversation_archive_chat_grandfathered',
    keys: ['agent_id', 'session_id', 'source_store', 'source_id', 'ordinal'],
    state: ['archive_agent', 'archive_session', 'archive_store', 'archive_source', 'archive_ordinal'], done: 'archive_done',
  },
};

async function projectBatch(client, source, state, batchSize) {
  const { table, side, keys, done } = source;
  const after = source.state.map(key => state[key]);
  const hasCursor = after[0] !== null;
  const tuple = keys.map(key => `e.${key}`).join(',');
  const parameters = hasCursor ? after.map((_, index) => `$${index + 2}`).join(',') : '';
  const values = hasCursor ? [batchSize, ...after] : [batchSize];
  const { rows } = await client.query(`WITH key_window AS MATERIALIZED (
    SELECT ${tuple},e.archive_chat_projected FROM ${table} e
    ${hasCursor ? `WHERE (${tuple})>(${parameters})` : ''}
    ORDER BY ${tuple} LIMIT $1
  ), batch AS MATERIALIZED (
    SELECT ${tuple},e.entry,e.search_projection FROM ${table} e JOIN key_window w
      ON ${keys.map(key => `e.${key}=w.${key}`).join(' AND ')}
    WHERE NOT w.archive_chat_projected AND NOT e.archive_chat_projected ORDER BY ${tuple} FOR UPDATE OF e
  ), inserted AS (
    INSERT INTO ${side}(${keys.join(',')},visible,instant)
    SELECT ${keys.map(key => `b.${key}`).join(',')},p.visible,p.instant
    FROM batch b CROSS JOIN LATERAL burrow_archive_chat_projection(b.entry,
      COALESCE(b.search_projection,burrow_json_member(b.entry,'content')::text,'')) p
    ON CONFLICT (${keys.join(',')}) DO UPDATE SET visible=EXCLUDED.visible,instant=EXCLUDED.instant
    RETURNING 1
  ) SELECT (SELECT count(*)::int FROM inserted) AS updated,
      (SELECT count(*)::int FROM key_window) AS visited,
      ${keys.map(key => `(SELECT w.${key} FROM key_window w ORDER BY ${keys.map(k => `w.${k} DESC`).join(',')} LIMIT 1) AS ${key}`).join(',')}`,
  values);
  const row = rows[0];
  // An EOF under this transaction's snapshot is final: inserts after migration
  // are projected before they become visible, and row updates cannot create a
  // new pending value. Authority deletion/cascades cannot create one either.
  if (row.visited < batchSize) {
    await client.query(`UPDATE burrow_archive_chat_backfill SET ${done}=true WHERE id`);
    return { updated: row.updated, done: true };
  }
  await client.query(`UPDATE burrow_archive_chat_backfill SET ${source.state.map((key, i) => `${key}=$${i + 1}`).join(',')}
    WHERE id`, keys.map(key => row[key]));
  return { updated: row.updated, done: false };
}

/** One bounded, restartable transaction; safe alongside ordinary updates/reset. */
export async function backfillArchiveChatBatch(pool, { batchSize = 256, signal } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error('invalid archive chat batch size');
  return withPostgresTransaction(pool, async client => {
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'; SET LOCAL jit=off");
    if (!(await client.query("SELECT to_regclass('burrow_archive_chat_backfill') AS relation")).rows[0].relation) return { completed: true, updated: 0 };
    const state = (await client.query('SELECT * FROM burrow_archive_chat_backfill WHERE id FOR UPDATE')).rows[0];
    if (state.live_done && state.archive_done) return { completed: true, updated: 0 };
    const name = state.live_done ? 'archive' : 'live';
    const result = await projectBatch(client, SOURCES[name], state, batchSize);
    return { completed: result.done && (name === 'archive' || state.archive_done), updated: result.updated };
  }, { signal });
}

/** Start after migrations; close before closing the shared pool. No user config. */
export function startArchiveChatBackfill(pool, { batchSize = 256, delayMs = 100,
  onError = error => console.error('archive chat backfill retry', { code: error.code || 'operation_failed' }) } = {}) {
  let stopped = false, timer, running = Promise.resolve();
  const controller = new AbortController();
  const schedule = () => {
    timer = setTimeout(() => {
      running = backfillArchiveChatBatch(pool, { batchSize, signal: controller.signal }).then(result => {
        if (!stopped && !result.completed) schedule();
      }).catch(error => { if (!stopped) { onError(error); schedule(); } });
    }, delayMs);
    timer.unref?.();
  };
  schedule();
  return { async close() { stopped = true; clearTimeout(timer); controller.abort(new Error('archive_chat_backfill_stopped')); await running; } };
}

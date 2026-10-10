import { POSTGRES_OPERATOR_INSTANT_SQL } from './postgres-operator-instant.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

// Execution adapter only: the published v48 SQL and its ledger checksum stay frozen.
export async function applyOperatorInstantMigration(client) {
  const start = POSTGRES_OPERATOR_INSTANT_SQL.indexOf('-- Transactional migration');
  const end = POSTGRES_OPERATOR_INSTANT_SQL.indexOf('CREATE INDEX conversation_live_operator_latest');
  if (start < 0 || end < start) throw new Error('unsupported operator instant migration');
  await client.query(POSTGRES_OPERATOR_INSTANT_SQL.slice(0,start) + POSTGRES_OPERATOR_INSTANT_SQL.slice(end));
  await client.query(`
    CREATE TABLE burrow_operator_backfill (id boolean PRIMARY KEY DEFAULT true CHECK(id), completed boolean NOT NULL DEFAULT false);
    INSERT INTO burrow_operator_backfill DEFAULT VALUES;
    ALTER TABLE conversation_entries ADD COLUMN operator_projected boolean NOT NULL DEFAULT false;
    ALTER TABLE conversation_archive_entries ADD COLUMN operator_projected boolean NOT NULL DEFAULT false;
    CREATE OR REPLACE FUNCTION burrow_project_operator_instant() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      SELECT at,fallback INTO NEW.operator_at,NEW.operator_ts_fallback FROM burrow_operator_projection(NEW.entry);
      NEW.operator_projected := true;
      RETURN NEW;
    END $$;
    CREATE INDEX conversation_live_operator_pending ON conversation_entries(agent_id) WHERE NOT operator_projected;
    CREATE INDEX conversation_archive_operator_pending ON conversation_archive_entries(agent_id) WHERE NOT operator_projected;
  `);
}

// 256 bounds writer-exclusion work per transaction, not the total history processed.
export async function backfillOperatorInstantsBatch(pool, { batchSize = 256 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('invalid operator batch size');
  return withPostgresTransaction(pool, async client => {
    if (!(await client.query("SELECT to_regclass('burrow_operator_backfill') AS relation")).rows[0].relation) return { completed: true, updated: 0 };
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'");
    const state = (await client.query('SELECT completed FROM burrow_operator_backfill WHERE id FOR UPDATE')).rows[0];
    if (state.completed) return { completed: true, updated: 0 };
    const hasPending = (await client.query(`SELECT EXISTS(SELECT 1 FROM conversation_entries WHERE NOT operator_projected)
      OR EXISTS(SELECT 1 FROM conversation_archive_entries WHERE NOT operator_projected) AS pending`)).rows[0].pending;
    if (!hasPending) {
      await client.query('UPDATE burrow_operator_backfill SET completed=true WHERE id');
      return { completed: true, updated: 0 };
    }
    // NOT VALID checks still apply to UPDATE. Suspend them only under writer
    // exclusion, in this bounded transaction; rollback restores them on failure.
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'");
    await client.query('LOCK TABLE conversation_entries,conversation_archive_entries IN ACCESS EXCLUSIVE MODE');
    const { rows: checks } = await client.query(`SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid IN ('conversation_entries'::regclass,'conversation_archive_entries'::regclass)
      AND contype='c' AND NOT convalidated AND conname LIKE '%required_instant'`);
    const quote = s => '"' + s.replaceAll('"','""') + '"';
    for (const c of checks) await client.query(`ALTER TABLE ${c.relation} DROP CONSTRAINT ${quote(c.conname)}`);
    let updated = 0;
    for (const table of ['conversation_entries','conversation_archive_entries']) {
      const result = await client.query(`WITH batch AS (
        SELECT ctid,entry FROM ${table} WHERE NOT operator_projected LIMIT $1
      ) UPDATE ${table} t SET operator_at=p.at,operator_ts_fallback=p.fallback,operator_projected=true
        FROM batch b LEFT JOIN LATERAL burrow_operator_projection(b.entry) p ON true WHERE t.ctid=b.ctid`, [batchSize]);
      updated += result.rowCount;
    }
    for (const c of checks) await client.query(`ALTER TABLE ${c.relation} ADD CONSTRAINT ${quote(c.conname)} ${c.definition}`);
    const completed = !(await client.query(`SELECT EXISTS(SELECT 1 FROM conversation_entries WHERE NOT operator_projected)
      OR EXISTS(SELECT 1 FROM conversation_archive_entries WHERE NOT operator_projected) AS pending`)).rows[0].pending;
    if (completed) await client.query('UPDATE burrow_operator_backfill SET completed=true WHERE id');
    return { completed, updated };
  });
}

export function startOperatorInstantBackfill(pool, { batchSize = 256, delayMs = 100, onError = error => console.error('operator instant backfill retry', { code: error.code || 'operation_failed' }) } = {}) {
  let stopped = false, timer, running = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      running = backfillOperatorInstantsBatch(pool, { batchSize }).then(result => {
        if (!stopped && !result.completed) schedule();
      }).catch(error => { onError(error); if (!stopped) schedule(); });
    }, delayMs);
    timer.unref?.();
  };
  schedule();
  return { async close() { stopped = true; clearTimeout(timer); await running; } };
}

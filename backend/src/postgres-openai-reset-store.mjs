import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

const outcomes = new Set(['consumed', 'retryable', 'unavailable', 'unknown']);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const timestamp = value => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError('reset_credit_expiry_invalid');
  return new Date(ms).toISOString();
};
// Persist only bounded machine-readable diagnostics, never raw provider bodies,
// bearer tokens, URLs, or exception objects.
const diagnostic = value => {
  if (value == null) return null;
  // Provider result codes or snake-case application error identifiers only.
  // Opaque strings (including compact tokens), URLs and freeform errors are redacted.
  return typeof value === 'string' && /^(?:reset|nothing_to_reset|no_credit|already_redeemed|[a-z][a-z0-9]{0,31}(?:_[a-z][a-z0-9]{0,31}){1,5})$/.test(value)
    ? value : 'redacted';
};
const now = clock => {
  const ms = Number(clock());
  if (!Number.isFinite(ms)) throw new TypeError('reset_credit_clock_invalid');
  return ms;
};

/** Durable, account-scoped reset fence. Claim commits before any provider POST. */
export function createPostgresOpenAiResetStore(pool, { clock = Date.now, retryDelayMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new TypeError('reset_credit_retry_delay_invalid');
  const database = normalizePostgresPool(pool);
  const checkIdentity = (...values) => {
    if (!values.every(identifier)) throw new TypeError('reset_credit_identity_invalid');
  };
  const lock = async (client, account) => {
    // Namespace is stable across processes/pools; hashed collisions merely serialize more.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 98173))', [account]);
  };
  return {
    async pending(account) {
      checkIdentity(account);
      const { rows } = await database.query(`
        SELECT credit_id AS "creditId", request_id AS "requestId", expires_at AS "expiresAt"
        FROM openai_reset_credit_claims WHERE account_key=$1 AND outcome='unknown'
        ORDER BY claimed_at, credit_id`, [account]);
      return rows.map(row => ({ creditId: row.creditId, requestId: row.requestId,
        expiresAt: row.expiresAt == null ? null : new Date(row.expiresAt).toISOString() }));
    },
    async retryCredit(account) {
      checkIdentity(account);
      const { rows } = await database.query(`SELECT credit_id AS "creditId", expires_at AS "expiresAt"
        FROM openai_reset_credit_claims WHERE account_key=$1 AND outcome='retryable'
        AND expires_at > $2 ORDER BY claimed_at,credit_id LIMIT 1`, [account, new Date(now(clock)).toISOString()]);
      return rows[0] ? { creditId: rows[0].creditId, expiresAt: new Date(rows[0].expiresAt).toISOString() } : null;
    },
    async claim({ account, creditId, requestId, expiresAt = null }) {
      checkIdentity(account, creditId, requestId);
      const expiry = timestamp(expiresAt);
      return withPostgresTransaction(database, async client => {
        await lock(client, account);
        const instant = now(clock);
        // Any unknown outcome on this account fences *every* other credit.
        if ((await client.query("SELECT 1 FROM openai_reset_credit_claims WHERE account_key=$1 AND outcome='unknown' LIMIT 1", [account])).rowCount) return false;
        // A still-live retry candidate pins automatic work to its original
        // identity even if a newly observed credit sorts ahead of it.
        if ((await client.query(`SELECT 1 FROM openai_reset_credit_claims WHERE account_key=$1
          AND outcome='retryable' AND expires_at > $3 AND credit_id<>$2 LIMIT 1`,
          [account, creditId, new Date(instant).toISOString()])).rowCount) return false;
        if ((await client.query('SELECT 1 FROM openai_reset_credit_attempts WHERE account_key=$1 AND request_id=$2', [account, requestId])).rowCount) return false;
        const { rows } = await client.query('SELECT outcome, expires_at, retry_at FROM openai_reset_credit_claims WHERE account_key=$1 AND credit_id=$2', [account, creditId]);
        const previous = rows[0];
        if (previous) {
          if (previous.outcome !== 'retryable') return false;
          const pinned = previous.expires_at == null ? null : new Date(previous.expires_at).toISOString();
          if (pinned !== expiry || (previous.retry_at && Date.parse(previous.retry_at) > instant)) return false;
        }
        if (expiry && Date.parse(expiry) <= instant) return false;
        if (previous) {
          await client.query(`UPDATE openai_reset_credit_claims
            SET request_id=$3, claimed_at=$4, outcome='unknown', retry_at=NULL, code=NULL, http_status=NULL, error=NULL
            WHERE account_key=$1 AND credit_id=$2`, [account, creditId, requestId, new Date(instant).toISOString()]);
        } else {
          await client.query(`INSERT INTO openai_reset_credit_claims
            (account_key,credit_id,request_id,claimed_at,expires_at,outcome)
            VALUES($1,$2,$3,$4,$5,'unknown')`, [account, creditId, requestId, new Date(instant).toISOString(), expiry]);
        }
        await client.query(`INSERT INTO openai_reset_credit_attempts
          (account_key,credit_id,request_id,claimed_at,expires_at,outcome)
          VALUES($1,$2,$3,$4,$5,'unknown')`, [account, creditId, requestId, new Date(instant).toISOString(), expiry]);
        return true;
      });
    },
    async settle({ account, creditId, requestId, outcome, code = null, httpStatus = null, error = null }) {
      checkIdentity(account, creditId, requestId);
      if (!outcomes.has(outcome)) throw new TypeError('reset_credit_outcome_invalid');
      if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new TypeError('reset_credit_http_status_invalid');
      return withPostgresTransaction(database, async client => {
        await lock(client, account);
        const { rows } = await client.query(`SELECT request_id, outcome FROM openai_reset_credit_claims
          WHERE account_key=$1 AND credit_id=$2`, [account, creditId]);
        if (rows[0]?.request_id !== requestId || rows[0]?.outcome !== 'unknown') throw new Error('reset_credit_current_ownership_required');
        const instant = now(clock);
        const settledAt = new Date(instant).toISOString();
        const retryAt = outcome === 'retryable' ? new Date(instant + retryDelayMs).toISOString() : null;
        const values = [account, creditId, requestId, outcome, settledAt, retryAt, diagnostic(code), httpStatus, diagnostic(error)];
        const receipt = await client.query(`UPDATE openai_reset_credit_attempts
          SET outcome=$4, settled_at=$5, retry_at=$6, code=$7, http_status=$8, error=$9
          WHERE account_key=$1 AND credit_id=$2 AND request_id=$3 AND outcome='unknown'`, values);
        if (receipt.rowCount !== 1) throw new Error('reset_credit_current_ownership_required');
        await client.query(`UPDATE openai_reset_credit_claims SET outcome=$4, retry_at=$5, code=$6, http_status=$7, error=$8
          WHERE account_key=$1 AND credit_id=$2 AND request_id=$3`,
        [account, creditId, requestId, outcome, retryAt, diagnostic(code), httpStatus, diagnostic(error)]);
      });
    },
  };
}

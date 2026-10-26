import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { sealSettingsSecret, openSettingsSecret } from './settings-secret.mjs';
import { normalizeCompletionEventSettingsPatch } from './completion-event-settings.mjs';

const AAD = 'burrow-completion-event-settings-v1|github|signing-secret';
export const POSTGRES_COMPLETION_EVENT_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS completion_event_settings (
  id TEXT PRIMARY KEY CHECK (id='github'),
  delivery_url TEXT NOT NULL DEFAULT '',
  ciphertext BYTEA, nonce BYTEA, auth_tag BYTEA,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT completion_event_secret_complete CHECK (
    (ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
    OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
  )
);`;

// The credential uses the same managed settings key and encryption mechanism as
// other application credentials. No environment variable or deployment owns it.
export class PostgresCompletionEventSettingsStore {
  constructor({ pool, key, encryptionKey, clock = () => new Date().toISOString() } = {}) {
    this.pool = normalizePostgresPool(pool);
    this.key = key || encryptionKey || settingsKeyFromEnvironment();
    this.clock = clock;
    if (!Buffer.isBuffer(this.key) || this.key.length !== 32) throw new Error('settings_encryption_key_invalid');
  }
  async read() {
    const { rows } = await this.pool.query("SELECT * FROM completion_event_settings WHERE id='github'");
    const row = rows[0];
    let secret = null, secretUnavailable = false;
    if (row?.ciphertext) {
      try { secret = openSettingsSecret(this.key, AAD, row); }
      catch { secretUnavailable = true; }
    }
    return { deliveryUrl: row?.delivery_url ?? '', secretConfigured: Boolean(row?.ciphertext), secret, secretUnavailable };
  }
  async write(body) {
    const patch = normalizeCompletionEventSettingsPatch(body);
    await withPostgresTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['completion-event-settings:github']);
      const { rows } = await client.query("SELECT * FROM completion_event_settings WHERE id='github' FOR UPDATE");
      const prior = rows[0];
      let sealed = prior ?? {};
      if (patch.clearSecret) sealed = {};
      else if (patch.secret !== undefined) {
        const value = sealSettingsSecret(this.key, AAD, patch.secret);
        sealed = { ciphertext: value.ciphertext, nonce: value.nonce, auth_tag: value.authTag };
      }
      await client.query(`INSERT INTO completion_event_settings(id,delivery_url,ciphertext,nonce,auth_tag,updated_at)
        VALUES('github',$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET
        delivery_url=EXCLUDED.delivery_url,ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,
        auth_tag=EXCLUDED.auth_tag,updated_at=EXCLUDED.updated_at`,
      [patch.deliveryUrl ?? prior?.delivery_url ?? '', sealed.ciphertext ?? null, sealed.nonce ?? null, sealed.auth_tag ?? null, this.clock()]);
    });
  }
}

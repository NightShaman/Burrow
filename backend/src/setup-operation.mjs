import { withPostgresTransaction, postgresTransactionContext } from './postgres-foundation.mjs';
import { PostgresAgentRegistryStore } from './postgres-agent-registry.mjs';
import { PostgresAgentProfileStore } from './postgres-agent-profile-store.mjs';
import { PostgresModelSettingsStore } from './postgres-model-settings-store.mjs';
import { PostgresDreamSettingsStore } from './postgres-dream-settings-store.mjs';
import { PostgresSessionStore } from './postgres-session-store.mjs';
import { PostgresSetupStateStore } from './postgres-setup-state-store.mjs';
import { createHash } from 'node:crypto';

// All durable stages share one connection. A lost response can be replayed;
// a failed stage leaves no partial identity, agent or completion writes.
export async function completeSetupOperation({ pool, encryptionKey, body, afterStage = async () => {} }) {
  const operationId = String(body?.operationId || '').trim();
  if (!operationId || operationId.length > 200) throw new Error('setup_operation_id_required');
  const { operationId: ignored, ...input } = body;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
  return withPostgresTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['setup-state:default']);
    const key = `setup-operation:${operationId}`;
    const prior = await client.query('SELECT value_json FROM settings_meta WHERE key=$1', [key]);
    if (prior.rows[0]) {
      const value = typeof prior.rows[0].value_json === 'string' ? JSON.parse(prior.rows[0].value_json) : prior.rows[0].value_json;
      if (value.fingerprint !== fingerprint) throw new Error('setup_operation_conflict');
      return value.result;
    }
    const common = { pool: postgresTransactionContext(client), bootstrapSampleIdentities: false };
    const models = new PostgresModelSettingsStore({ ...common, key: encryptionKey });
    await models.saveIdentity({ ...input.operator, kind: 'operator', id: 'default' }); await afterStage('operator');
    const agent = await new PostgresAgentRegistryStore(common).create(input.agent); await afterStage('agent');
    await models.saveIdentity({ ...input.agentIdentity, kind: 'agent', id: agent.id, name: input.agent.name }); await afterStage('identity');
    await new PostgresAgentProfileStore(common).replace(agent.id, input.documents); await afterStage('profiles');
    if (input.modelSelection) await models.saveModelSelection({ ...input.modelSelection, agentId: agent.id }); await afterStage('model');
    await new PostgresDreamSettingsStore(common).save(agent.id, { enabled: true });
    await new PostgresSessionStore(common).updateMetadata({ agentId: agent.id, sessionId: 'default', update: value => value }); await afterStage('defaults');
    const setup = await new PostgresSetupStateStore(common).completeSetup();
    if (!setup.ok) throw new Error(setup.error); await afterStage('completion');
    const result = { ok: true, agent, setup, operationId };
    await client.query('INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3)', [key, JSON.stringify({ fingerprint, result }), new Date().toISOString()]);
    return result;
  });
}

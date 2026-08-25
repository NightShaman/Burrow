import { randomUUID } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath, withSettingsTransaction } from './settings-database.mjs';

const now = () => new Date().toISOString();
const text = (value) => String(value ?? '').trim();
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'terminated']);

function required(value, name) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function bindingKey(input = {}) {
  return {
    adapterId: required(input.adapterId ?? input.adapter_id, 'adapter_id'),
    agentId: required(input.agentId ?? input.agent_id, 'agent_id'),
    sessionId: required(input.sessionId ?? input.session_id, 'session_id'),
    adapterGeneration: required(input.adapterGeneration ?? input.adapter_generation, 'adapter_generation'),
  };
}

function sessionRecord(row) {
  if (!row) return null;
  return { id: row.id, adapterId: row.adapter_id, agentId: row.agent_id, sessionId: row.session_id,
    adapterGeneration: row.adapter_generation, nativeThreadId: row.native_thread_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at };
}
function runRecord(row) {
  if (!row) return null;
  return { runId: row.run_id, sessionBindingId: row.session_binding_id, nativeTurnId: row.native_turn_id,
    state: row.state, lastSequence: row.last_sequence, createdAt: row.created_at,
    updatedAt: row.updated_at, terminalAt: row.terminal_at };
}
function activeTurnRecord(row) {
  if (!row) return null;
  return { sessionBindingId: row.session_binding_id, runId: row.run_id, nativeTurnId: row.native_turn_id,
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** SQLite persistence for adapter-native runtime continuity only. */
export class RuntimeBindingStore {
  constructor({ databasePath, clock = now } = {}) {
    this.db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
    this.clock = clock;
  }
  close() { this.db.close(); }

  getSessionBinding(input = {}) {
    const key = bindingKey(input);
    return sessionRecord(this.db.prepare(`SELECT * FROM runtime_session_bindings
      WHERE adapter_id=? AND agent_id=? AND session_id=? AND adapter_generation=?`).get(key.adapterId, key.agentId, key.sessionId, key.adapterGeneration));
  }

  upsertSessionBinding(input = {}) {
    const key = bindingKey(input); const timestamp = this.clock();
    const nativeThreadId = input.nativeThreadId ?? input.native_thread_id;
    const state = text(input.state) || 'active';
    return withSettingsTransaction(this.db, () => {
      const current = this.getSessionBinding(key);
      if (current) {
        this.db.prepare(`UPDATE runtime_session_bindings SET native_thread_id=COALESCE(?,native_thread_id),state=?,updated_at=?,closed_at=NULL WHERE id=?`)
          .run(nativeThreadId === null ? null : text(nativeThreadId) || null, state, timestamp, current.id);
        return this.getSessionBinding(key);
      }
      const id = text(input.id) || randomUUID();
      this.db.prepare(`INSERT INTO runtime_session_bindings (id,adapter_id,agent_id,session_id,adapter_generation,native_thread_id,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, key.adapterId, key.agentId, key.sessionId, key.adapterGeneration, nativeThreadId == null ? null : text(nativeThreadId) || null, state, timestamp, timestamp);
      return this.getSessionBinding(key);
    });
  }

  closeSessionBinding(input = {}) { return this.#endSessionBinding(input, 'closed'); }
  detachSessionBinding(input = {}) { return this.#endSessionBinding(input, 'detached'); }
  #endSessionBinding(input, defaultState) {
    const key = input.sessionBindingId ? null : bindingKey(input);
    const id = input.sessionBindingId ? required(input.sessionBindingId, 'session_binding_id') : this.getSessionBinding(key)?.id;
    if (!id) return null;
    const timestamp = this.clock(); const state = text(input.state) || defaultState;
    this.db.prepare('UPDATE runtime_session_bindings SET state=?,updated_at=?,closed_at=? WHERE id=?').run(state, timestamp, timestamp, id);
    return sessionRecord(this.db.prepare('SELECT * FROM runtime_session_bindings WHERE id=?').get(id));
  }

  startRunBinding(input = {}) {
    const runId = required(input.runId ?? input.run_id, 'run_id');
    const sessionBindingId = input.sessionBindingId ? required(input.sessionBindingId, 'session_binding_id') : this.getSessionBinding(bindingKey(input))?.id;
    if (!sessionBindingId) throw new Error('session_binding_not_found');
    const timestamp = this.clock(); const nativeTurnId = input.nativeTurnId ?? input.native_turn_id;
    const state = text(input.state) || 'active';
    return withSettingsTransaction(this.db, () => {
      const current = this.getRunBinding({ runId });
      if (current) return current;
      this.db.prepare(`INSERT INTO runtime_run_bindings (run_id,session_binding_id,native_turn_id,state,last_sequence,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(runId, sessionBindingId, nativeTurnId == null ? null : text(nativeTurnId) || null, state, 0, timestamp, timestamp);
      return this.getRunBinding({ runId });
    });
  }
  getRunBinding({ runId, run_id } = {}) { return runRecord(this.db.prepare('SELECT * FROM runtime_run_bindings WHERE run_id=?').get(required(runId ?? run_id, 'run_id'))); }

  updateRunBinding({ runId, run_id, state, nativeTurnId, native_turn_id } = {}) {
    const id = required(runId ?? run_id, 'run_id'); const current = this.getRunBinding({ runId: id });
    if (!current) return null;
    const nextState = state === undefined ? current.state : required(state, 'state');
    const nextTurn = nativeTurnId === undefined && native_turn_id === undefined ? current.nativeTurnId : (nativeTurnId ?? native_turn_id);
    const timestamp = this.clock();
    this.db.prepare('UPDATE runtime_run_bindings SET native_turn_id=?,state=?,updated_at=? WHERE run_id=?').run(nextTurn == null ? null : text(nextTurn) || null, nextState, timestamp, id);
    return this.getRunBinding({ runId: id });
  }
  terminalRunBinding(input = {}) {
    const state = required(input.state, 'state');
    if (!terminalStates.has(state)) throw new Error('run_state_not_terminal');
    const runId = required(input.runId ?? input.run_id, 'run_id'); const current = this.getRunBinding({ runId });
    if (!current) return null;
    const timestamp = this.clock();
    this.db.prepare('UPDATE runtime_run_bindings SET state=?,updated_at=?,terminal_at=? WHERE run_id=?').run(state, timestamp, timestamp, runId);
    this.db.prepare('DELETE FROM runtime_active_turns WHERE run_id=?').run(runId);
    return this.getRunBinding({ runId });
  }
  updateRunSequence({ runId, run_id, sequence } = {}) {
    const id = required(runId ?? run_id, 'run_id'); const next = Number(sequence);
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('sequence_invalid');
    const timestamp = this.clock();
    const result = this.db.prepare('UPDATE runtime_run_bindings SET last_sequence=?,updated_at=? WHERE run_id=? AND last_sequence < ?').run(next, timestamp, id, next);
    const record = this.getRunBinding({ runId: id });
    if (!record) return { ok: false, reason: 'run_binding_not_found', record: null };
    return result.changes ? { ok: true, record } : { ok: false, reason: 'sequence_not_monotonic', record };
  }
  setActiveTurn({ sessionBindingId, session_binding_id, runId, run_id, nativeTurnId, native_turn_id, state = 'active' } = {}) {
    const bindingId = required(sessionBindingId ?? session_binding_id, 'session_binding_id'); const id = required(runId ?? run_id, 'run_id');
    const run = this.getRunBinding({ runId: id }); if (!run || run.sessionBindingId !== bindingId) throw new Error('run_binding_session_mismatch');
    const timestamp = this.clock(); const turn = nativeTurnId ?? native_turn_id ?? run.nativeTurnId;
    this.db.prepare(`INSERT INTO runtime_active_turns (session_binding_id,run_id,native_turn_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(session_binding_id) DO UPDATE SET run_id=excluded.run_id,native_turn_id=excluded.native_turn_id,state=excluded.state,updated_at=excluded.updated_at`)
      .run(bindingId, id, turn == null ? null : text(turn) || null, required(state, 'state'), timestamp, timestamp);
    return this.getActiveTurn({ sessionBindingId: bindingId });
  }
  getActiveTurn({ sessionBindingId, session_binding_id } = {}) { return activeTurnRecord(this.db.prepare('SELECT * FROM runtime_active_turns WHERE session_binding_id=?').get(required(sessionBindingId ?? session_binding_id, 'session_binding_id'))); }
  clearActiveTurn({ sessionBindingId, session_binding_id } = {}) { return this.db.prepare('DELETE FROM runtime_active_turns WHERE session_binding_id=?').run(required(sessionBindingId ?? session_binding_id, 'session_binding_id')).changes > 0; }
}

export function createRuntimeBindingStore(options) { return new RuntimeBindingStore(options); }

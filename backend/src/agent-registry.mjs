import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';
import { mergeAgentContextConfig, normalizeAgentContextConfig } from './agent-context-config.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const DEFAULT_CAPABILITIES = Object.freeze(['chat', 'files', 'skills']);

function now() { return new Date().toISOString(); }
function text(value) { return String(value ?? '').trim(); }
function json(value) { return JSON.stringify(value); }
function parseJson(value, fallback = []) { try { return JSON.parse(value); } catch { return fallback; } }
function executionEnvironment(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_execution_environment_invalid');
  const kind = text(value.kind);
  const workspaceRoot = text(value.workspaceRoot);
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw new Error('agent_execution_environment_invalid');
  if (kind === 'local') return { kind, workspaceRoot: path.resolve(workspaceRoot) };
  // Preserve legacy provider-less assignments as unresolved data. Core cannot
  // truthfully decide which independently installed mod owns them.
  if (kind === 'gateway') {
    const targetId = text(value.hostId || value.targetId);
    if (!targetId) throw new Error('agent_execution_environment_target_required');
    return { kind: 'unresolved', legacyKind: 'gateway', targetId, workspaceRoot: path.resolve(workspaceRoot) };
  }
  if (kind === 'unresolved') {
    const legacyKind = text(value.legacyKind);
    const targetId = text(value.targetId);
    if (!legacyKind || !targetId) throw new Error('agent_execution_environment_invalid');
    return { kind, legacyKind, targetId, workspaceRoot: path.resolve(workspaceRoot) };
  }
  if (kind !== 'remote') throw new Error('agent_execution_environment_invalid');
  const providerId = text(value.providerId);
  const targetId = text(value.targetId);
  if (!providerId) throw new Error('agent_execution_environment_provider_required');
  if (!targetId) throw new Error('agent_execution_environment_target_required');
  return { kind, providerId, targetId, workspaceRoot: path.resolve(workspaceRoot) };
}
function bootstrapSampleIdentitiesEnabled(value = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES) { return ['1', 'true', 'yes', 'on'].includes(String(value ?? '0').trim().toLowerCase()); }

function assertAgent(input = {}, { requireName = true } = {}) {
  const id = text(input.id);
  const name = input.name === undefined ? undefined : text(input.name);
  const enabled = input.enabled === undefined ? undefined : input.enabled === true;
  const availableCapabilities = input.availableCapabilities === undefined ? undefined : [...new Set((Array.isArray(input.availableCapabilities) ? input.availableCapabilities : []).map(text).filter(Boolean))];
  const contextConfig = input.contextConfig === undefined ? undefined : normalizeAgentContextConfig(input.contextConfig, { partial: true });
  const assignedExecutionEnvironment = input.executionEnvironment === undefined ? undefined : executionEnvironment(input.executionEnvironment);
  if (!id || id === '.' || id === '..' || !ID.test(id)) throw new Error('agent_id_invalid');
  if (requireName && (!name || name.length > 64)) throw new Error('agent_name_invalid');
  if (name !== undefined && name.length > 64) throw new Error('agent_name_invalid');
  if (availableCapabilities !== undefined && (!availableCapabilities.length || availableCapabilities.some((item) => item.length > 64))) throw new Error('agent_available_capabilities_invalid');
  return { id, name, enabled, availableCapabilities, contextConfig, executionEnvironment: assignedExecutionEnvironment };
}

function row(row) {
  return row && {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    availableCapabilities: parseJson(row.available_capabilities, DEFAULT_CAPABILITIES),
    contextConfig: normalizeAgentContextConfig(parseJson(row.context_config_json, {})),
    executionEnvironment: row.execution_environment_json ? executionEnvironment(parseJson(row.execution_environment_json, null)) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentRegistryStore {
  constructor({ databasePath, bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES } = {}) {
    this.databasePath = databasePath || settingsDatabasePath();
    this.bootstrapSampleIdentities = bootstrapSampleIdentitiesEnabled(bootstrapSampleIdentities);
    this.db = openSettingsDatabase({ databasePath: this.databasePath });
  }
  close() { this.db.close(); }
  bootstrap() {
    const existing = this.db.prepare('SELECT * FROM agents WHERE id=?').get('hatchet');
    if (existing) return row(existing);
    if (!this.bootstrapSampleIdentities) return null;
    const timestamp = now();
    this.db.prepare('INSERT INTO agents (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('hatchet', 'Hatchet', 1, json(DEFAULT_CAPABILITIES), json(normalizeAgentContextConfig({})), null, timestamp, timestamp);
    return this.get('hatchet');
  }
  list({ includeDisabled = true } = {}) {
    this.bootstrap();
    const where = includeDisabled ? '' : 'WHERE enabled=1';
    return this.db.prepare(`SELECT * FROM agents ${where} ORDER BY CASE id WHEN 'hatchet' THEN 0 ELSE 1 END, name COLLATE NOCASE, id`).all().map(row);
  }
  get(id) { return row(this.db.prepare('SELECT * FROM agents WHERE id=?').get(text(id))); }
  // Runtime-facing lookup accepts a canonical id or a human-facing agent name.
  // Keep CRUD lookup exact: an agent id is still the durable identity.
  resolve(reference) {
    const value = text(reference);
    if (!value) return null;
    const exact = this.get(value);
    if (exact) return exact;
    const matches = this.db.prepare('SELECT * FROM agents WHERE id COLLATE NOCASE=? OR name COLLATE NOCASE=? ORDER BY CASE WHEN id COLLATE NOCASE=? THEN 0 ELSE 1 END, id').all(value, value, value).map(row);
    return matches.length === 1 ? matches[0] : null;
  }
  create(input = {}) {
    this.bootstrap();
    const agent = assertAgent(input);
    if (this.get(agent.id)) throw new Error('agent_id_exists');
    const timestamp = now();
    this.db.prepare('INSERT INTO agents (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(agent.id, agent.name, agent.enabled === false ? 0 : 1, json(agent.availableCapabilities || DEFAULT_CAPABILITIES), json(normalizeAgentContextConfig(agent.contextConfig || {})), agent.executionEnvironment ? json(agent.executionEnvironment) : null, timestamp, timestamp);
    return this.get(agent.id);
  }
  update(id, input = {}) {
    const current = this.get(id);
    if (!current) throw new Error('agent_not_found');
    const patch = assertAgent({ ...input, id: current.id }, { requireName: false });
    const timestamp = now();
    this.db.prepare('UPDATE agents SET name=?, enabled=?, available_capabilities=?, context_config_json=?, execution_environment_json=?, updated_at=? WHERE id=?')
      .run(patch.name === undefined ? current.name : patch.name, patch.enabled === undefined ? (current.enabled ? 1 : 0) : (patch.enabled ? 1 : 0), json(patch.availableCapabilities === undefined ? current.availableCapabilities : patch.availableCapabilities), json(patch.contextConfig === undefined ? current.contextConfig : mergeAgentContextConfig(current.contextConfig, patch.contextConfig)), patch.executionEnvironment === undefined ? (current.executionEnvironment ? json(current.executionEnvironment) : null) : (patch.executionEnvironment ? json(patch.executionEnvironment) : null), timestamp, current.id);
    return this.get(current.id);
  }
  delete(id) {
    const current = this.get(id);
    if (!current) throw new Error('agent_not_found');
    this.db.prepare('DELETE FROM agents WHERE id=?').run(text(id));
    return current;
  }
}

export async function ensureAgentRoots({ runtimeState, agent } = {}) {
  if (!runtimeState?.workspaceRoot || !agent?.id) throw new Error('agent_runtime_context_required');
  const workspaceRoot = path.resolve(runtimeState.workspaceRoot, agent.id);
  const globalRoot = path.resolve(runtimeState.workspaceRoot, 'global');
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(globalRoot, { recursive: true, mode: 0o755 });
  for (const dir of ['skills', 'sessions', 'artifacts', 'tools']) await fs.mkdir(path.join(workspaceRoot, dir), { recursive: true, mode: 0o700 });
  return agentRuntimeContext({ runtimeState, agent });
}

export function agentRuntimeContext({ runtimeState, agent } = {}) {
  if (!runtimeState?.workspaceRoot || !agent?.id) throw new Error('agent_runtime_context_required');
  const workspaceRoot = path.resolve(runtimeState.workspaceRoot, agent.id);
  const dataRoot = workspaceRoot;
  const globalRoot = path.resolve(runtimeState.workspaceRoot, 'global');
  return {
    agentId: agent.id,
    agent,
    contextConfig: normalizeAgentContextConfig(agent.contextConfig || {}),
    agentWorkspaceRoot: workspaceRoot,
    agentDataRoot: dataRoot,
    skillsRoot: path.join(workspaceRoot, 'skills'),
    settingsDatabasePath: runtimeState.settingsDatabasePath || null,
    // Controller-owned persisted assignment. Null preserves local execution.
    executionEnvironment: agent.executionEnvironment || null,
    // No agent-specific filesystem boundary. Workspaces are context, not cages.
    filesystemBoundaries: [],
  };
}

export const __agentRegistry = Object.freeze({ DEFAULT_CAPABILITIES, assertAgent, bootstrapSampleIdentitiesEnabled });

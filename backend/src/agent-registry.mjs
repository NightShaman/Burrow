import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeAgentContextConfig, normalizeAgentContextConfig } from './agent-context-config.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const DEFAULT_CAPABILITIES = Object.freeze(['chat', 'files', 'skills']);

function text(value) { return String(value ?? '').trim(); }
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

// Mod-owned identities are a separate, deliberately closed capability contract.
// Unknown groups (notably native engineering tools) must never be inferred.
const MOD_AGENT_CAPABILITIES = Object.freeze(['a2a', 'forge', 'brains', 'mcp', 'skills']);
const MOD_AGENT_VISIBILITY = Object.freeze(['agents', 'chat']);
function normalizeModAgent(value, { ownerModId = null, partial = false, current = null } = {}) {
  const invalid = () => { throw new Error('mod_agent_metadata_invalid'); };
  const object = input => input && typeof input === 'object' && !Array.isArray(input);
  if (!object(value) || Object.keys(value).some(key => !['ownerModId', 'capabilities', 'visibility'].includes(key))) invalid();
  const owner = ownerModId ?? value.ownerModId;
  if (typeof owner !== 'string' || owner.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner)) invalid();
  if (value.ownerModId !== undefined && value.ownerModId !== owner) invalid();
  if (current && current.ownerModId !== owner) invalid();
  const flags = (name, allowed) => {
    const input = value[name];
    if (input !== undefined && (!object(input) || Object.keys(input).some(key => !allowed.includes(key)) || Object.values(input).some(flag => typeof flag !== 'boolean'))) invalid();
    return Object.fromEntries(allowed.map(key => [key, input?.[key] ?? (partial ? current?.[name]?.[key] : false) ?? false]));
  };
  return { ownerModId: owner, capabilities: flags('capabilities', MOD_AGENT_CAPABILITIES), visibility: flags('visibility', MOD_AGENT_VISIBILITY) };
}

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
    // Controller-owned persisted assignment. Null preserves local execution.
    executionEnvironment: agent.executionEnvironment || null,
    // No agent-specific filesystem boundary. Workspaces are context, not cages.
    filesystemBoundaries: [],
  };
}

export { assertAgent, executionEnvironment, normalizeModAgent, MOD_AGENT_CAPABILITIES, MOD_AGENT_VISIBILITY };
export const __agentRegistry = Object.freeze({ DEFAULT_CAPABILITIES, assertAgent, bootstrapSampleIdentitiesEnabled });

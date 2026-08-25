import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeToolSchemas } from './action-proposal.mjs';

const TARGET_KINDS = new Set(['filesystem', 'repository', 'repo', 'directory', 'dir']);

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function absolute(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error(`${field}_must_be_absolute`);
  }
  return path.resolve(value.trim());
}

function optionalAbsolute(value, field) {
  return value == null ? null : absolute(value, field);
}

/**
 * Validate a structurally supplied target. Prose is deliberately not accepted
 * here; callers must pass a target request from a transport/API boundary.
 */
export async function resolveExecutionTarget(targetRequest = null, { filesystemBoundaries = [] } = {}) {
  if (targetRequest == null) return null;
  if (!targetRequest || typeof targetRequest !== 'object') throw new Error('target_request_must_be_object');
  const requestedKind = String(targetRequest.kind || '').trim();
  if (!TARGET_KINDS.has(requestedKind)) throw new Error(`unsupported_target_kind:${requestedKind || 'missing'}`);
  const kind = ['repository', 'repo', 'directory', 'dir'].includes(requestedKind) ? 'filesystem' : requestedKind;
  const requestedRoot = absolute(targetRequest.root, 'target_root');
  if (!requestedRoot) throw new Error('target_root_required');
  const root = await fs.realpath(requestedRoot).catch(() => null);
  if (!root) throw new Error('target_root_not_found');
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('target_root_not_found');
  return freeze({ kind, root, boundaries: [] });
}

/**
 * Immutable facts for one turn. This object contains no authority, routing,
 * workflow, or inferred-intent decisions.
 */
export function createExecutionContext({
  sessionId,
  conversationId = null,
  continuityScope = null,
  agentId = null,
  includeBrainMemory = false,
  includeAgentChat = false,
  includeTaskBoard = false,
  agentRuntime = null,
  resolveAgentRuntime = null,
  runAgentReply = null,
  workspaceRoot,
  target = null,
  dataRoot,
  cacheRoot,
  settingsDatabasePath = null,
  agentWorkspaceRoot = null,
  agentDataRoot = null,
  skillsRoot = null,
  filesystemBoundaries = [],
  executionBoundaries = null,
  toolSchemas = null,
  mcpTools = null,
  mcpConnections = null,
  protectedValues = null,
} = {}) {
  const resolvedAgentWorkspaceRoot = optionalAbsolute(agentWorkspaceRoot, 'agent_workspace_root');
  const resolvedAgentDataRoot = optionalAbsolute(agentDataRoot, 'agent_data_root');
  const resolvedSkillsRoot = optionalAbsolute(skillsRoot, 'skills_root');
  // These are selected-context roots, not access-control boundaries. A
  // selected agent automatically loads only its configured profile and skills,
  // but ordinary filesystem inspection remains open to every agent.
  const context = {
    sessionId: sessionId == null ? null : String(sessionId),
    conversationId: conversationId == null ? null : String(conversationId),
    continuityScope: continuityScope == null ? null : String(continuityScope).trim() || null,
    agentId: agentId == null ? null : String(agentId),
    workspaceRoot: absolute(workspaceRoot, 'workspace_root'),
    target,
    dataRoot: absolute(dataRoot, 'data_root'),
    cacheRoot: absolute(cacheRoot, 'cache_root'),
    settingsDatabasePath: optionalAbsolute(settingsDatabasePath, 'settings_database_path'),
    agentWorkspaceRoot: resolvedAgentWorkspaceRoot,
    agentDataRoot: resolvedAgentDataRoot,
    skillsRoot: resolvedSkillsRoot,
    scopeSource: resolvedAgentWorkspaceRoot ? 'agent-runtime' : 'legacy',
    // Trusted, non-serialized delivery authority for explicit cross-agent chat.
    // It supplies no recipient filesystem/profile/memory authority to this turn.
    agentRuntime: agentRuntime || null,
    resolveAgentRuntime: typeof resolveAgentRuntime === 'function' ? resolveAgentRuntime : null,
    runAgentReply: typeof runAgentReply === 'function' ? runAgentReply : null,
    filesystemBoundaries: filesystemBoundaries.map((item) => absolute(item, 'filesystem_boundary')).filter(Boolean),
    executionBoundaries: executionBoundaries && typeof executionBoundaries === 'object' ? executionBoundaries : null,
    toolSchemas: Array.isArray(toolSchemas) ? toolSchemas : nativeToolSchemas({ includeWorkingMemory: Boolean(agentId), includeBrainMemory: Boolean(includeBrainMemory), includeAgentProfile: Boolean(agentId && settingsDatabasePath), includeAgentChat: Boolean(includeAgentChat), includeTaskBoard: Boolean(includeTaskBoard), includeMcpMenu: mcpConnections instanceof Map && mcpConnections.size > 0 }),
    mcpTools: mcpTools instanceof Map ? mcpTools : new Map(),
    mcpConnections: mcpConnections instanceof Map ? mcpConnections : new Map(),
    protectedValues: protectedValues instanceof Map ? protectedValues : new Map(),
  };
  return freeze(context);
}

export const __executionContext__ = Object.freeze({ TARGET_KINDS });

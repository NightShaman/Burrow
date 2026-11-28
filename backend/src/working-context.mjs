import path from 'node:path';
import { recentFileReferentsFromToolResults, resolveFileReferent } from './file-referents.mjs';
import { isAbsoluteRemotePath, normalizeRemotePathForMatching } from './remote-execution-path.mjs';
import { mergeReadEvidence } from './read-evidence.mjs';

const MAX_TARGETS = 6;
const MAX_REFERENTS = 8;

function uniqueStrings(values = [], limit = Infinity, preserve = false) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = preserve ? String(value || '') : String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeWorkspace(value = null, remote = false) {
  if (!value || typeof value !== 'object') return null;
  const root = value.root || value.workspaceRoot || null;
  if (remote && !isAbsoluteRemotePath(root)) return null;
  return root ? { root: remote ? root : path.resolve(String(root)), ...(value.source ? { source: String(value.source) } : {}) } : null;
}

function normalizePathList(values = [], limit = Infinity, pathContext = {}) {
  return uniqueStrings((values || []).map((value) => pathContext.remote
    ? resolveFileReferent(value, pathContext)
    : path.resolve(String(value))), limit, pathContext.remote);
}

/**
 * Continuity is only a bounded reference ledger. Legacy source lists, issue
 * prose, trace/receipt evidence, and child summaries are deliberately dropped.
 */
export function normalizeWorkingContext(context = null, pathContext = {}) {
  const input = context && typeof context === 'object' ? context : {};
  // `continuityScope` is an explicit operator/runtime namespace for local
  // operational continuity. Legacy `project` metadata remains readable so
  // existing sessions continue cleanly after the vocabulary migration.
  const continuityScope = String((input.continuityScope ?? input.continuity_scope ?? input.project) || '').trim();
  return {
    ...(continuityScope && continuityScope.length <= 160 ? { continuityScope } : {}),
    workspace: normalizeWorkspace(input.workspace, pathContext.remote),
    targets: normalizePathList(input.targets || [], MAX_TARGETS, pathContext),
    referents: uniqueStrings(input.referents || [], MAX_REFERENTS),
    ...(Array.isArray(input.readEvidence) && input.readEvidence.length ? { readEvidence: mergeReadEvidence([], input.readEvidence) } : {}),
  };
}

export function workingContextFromSession(session = null, pathContext = {}) {
  const context = normalizeWorkingContext(session?.metadata?.workingContext || null, pathContext);
  // Older versions used this source for both real requests and defaults
  // forwarded by A2A. Retire the ambiguous hint without changing execution
  // settings, file evidence, or separately recorded filesystem targets.
  if (context.workspace?.source === 'explicit_workspace_root') context.workspace = null;
  return context;
}

export async function verifiedEventsFromTurnInput({ workspaceResolution = null } = {}) {
  const root = workspaceResolution?.resolved ? workspaceResolution.workspaceRoot : null;
  return [{
    ...(root ? { workspace: { root, source: workspaceResolution.reason || 'explicit_turn_target' } } : {}),
  }];
}

export function verifiedEventsFromToolResults(toolResults = [], { workspaceRoot = null, runId = null, traceDir = null, remote = false } = {}) {
  const targets = [];
  for (const result of toolResults || []) {
    if (!remote && result?.ok && result.tool === 'files_read' && result.filePath) targets.push(result.filePath);
  }
  for (const referent of recentFileReferentsFromToolResults(toolResults, { workspaceRoot, runId, traceDir, remote })) {
    if (referent.path) targets.push(resolveFileReferent(referent.path, { workspaceRoot, remote }));
  }
  return targets.length ? [{ targets }] : [];
}

export function applyWorkingContextEvents(context = null, events = [], pathContext = {}) {
  let next = normalizeWorkingContext(context, pathContext);
  const workspaceKey = pathContext.remote
    ? (root) => normalizeRemotePathForMatching(root, { ignoreWindowsCase: true })
    : (root) => path.resolve(root);
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const normalized = normalizeWorkingContext(event, pathContext);
    const workspaceChanged = normalized.workspace?.root && next.workspace?.root
      && workspaceKey(normalized.workspace.root) !== workspaceKey(next.workspace.root);
    next = normalizeWorkingContext({
      continuityScope: normalized.continuityScope || next.continuityScope,
      workspace: normalized.workspace || next.workspace,
      // File references belong to the workspace where they were observed.
      // Do not carry them into a different explicit workspace.
      targets: workspaceChanged ? normalized.targets : [...normalized.targets, ...next.targets],
      referents: workspaceChanged ? normalized.referents : [...normalized.referents, ...next.referents],
      readEvidence: mergeReadEvidence(normalized.readEvidence, next.readEvidence),
    }, pathContext);
  }
  return next;
}

export async function persistSessionWorkingContext({ rootDir, sessionId, workingContext, conversationStore = null, agentId, pathContext = {} } = {}) {
  const normalized = normalizeWorkingContext(workingContext, pathContext);
  if (!conversationStore) throw new Error('conversation_store_required');
  const {readEvidence = [], ...context} = normalized;
  await conversationStore.patchMetadata({agentId,sessionId,metadata:{workingContext:context,readEvidence}});
  return normalized;
}

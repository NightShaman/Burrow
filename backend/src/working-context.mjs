import path from 'node:path';
import { writeSessionMetadata } from './session-store.mjs';
import { recentFileReferentsFromToolResults } from './file-referents.mjs';
import { mergeReadEvidence } from './read-evidence.mjs';
import { writeSessionReadEvidence } from './read-evidence-store.mjs';

const MAX_TARGETS = 6;
const MAX_REFERENTS = 8;

function uniqueStrings(values = [], limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeWorkspace(value = null) {
  if (!value || typeof value !== 'object') return null;
  const root = value.root || value.workspaceRoot || null;
  return root ? { root: path.resolve(String(root)), ...(value.source ? { source: String(value.source) } : {}) } : null;
}

function normalizePathList(values = [], limit = Infinity) {
  return uniqueStrings((values || []).map((value) => path.resolve(String(value))), limit);
}

/**
 * Continuity is only a bounded reference ledger. Legacy source lists, issue
 * prose, trace/receipt evidence, and child summaries are deliberately dropped.
 */
export function normalizeWorkingContext(context = null) {
  const input = context && typeof context === 'object' ? context : {};
  // `continuityScope` is an explicit operator/runtime namespace for local
  // operational continuity. Legacy `project` metadata remains readable so
  // existing sessions continue cleanly after the vocabulary migration.
  const continuityScope = String((input.continuityScope ?? input.continuity_scope ?? input.project) || '').trim();
  return {
    ...(continuityScope && continuityScope.length <= 160 ? { continuityScope } : {}),
    workspace: normalizeWorkspace(input.workspace),
    targets: normalizePathList(input.targets || [], MAX_TARGETS),
    referents: uniqueStrings(input.referents || [], MAX_REFERENTS),
    ...(Array.isArray(input.readEvidence) && input.readEvidence.length ? { readEvidence: mergeReadEvidence([], input.readEvidence) } : {}),
  };
}

export function workingContextFromSession(session = null) {
  return normalizeWorkingContext(session?.metadata?.workingContext || null);
}

export async function verifiedEventsFromTurnInput({ workspaceResolution = null } = {}) {
  const root = workspaceResolution?.resolved ? workspaceResolution.workspaceRoot : null;
  return [{
    ...(root ? { workspace: { root, source: workspaceResolution.reason || 'explicit_turn_target' } } : {}),
  }];
}

export function verifiedEventsFromToolResults(toolResults = [], { workspaceRoot = null, runId = null, traceDir = null } = {}) {
  const targets = [];
  for (const result of toolResults || []) {
    if (result?.ok && result.tool === 'files_read' && result.filePath) targets.push(result.filePath);
  }
  for (const referent of recentFileReferentsFromToolResults(toolResults, { workspaceRoot, runId, traceDir })) {
    if (referent.path) targets.push(path.isAbsolute(referent.path) ? referent.path : path.resolve(workspaceRoot || process.cwd(), referent.path));
  }
  return targets.length ? [{ targets }] : [];
}

export function applyWorkingContextEvents(context = null, events = []) {
  let next = normalizeWorkingContext(context);
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const normalized = normalizeWorkingContext(event);
    next = normalizeWorkingContext({
      continuityScope: normalized.continuityScope || next.continuityScope,
      workspace: normalized.workspace || next.workspace,
      targets: [...normalized.targets, ...next.targets],
      referents: [...normalized.referents, ...next.referents],
      readEvidence: mergeReadEvidence(normalized.readEvidence, next.readEvidence),
    });
  }
  return next;
}

export async function persistSessionWorkingContext({ rootDir, sessionId, workingContext } = {}) {
  const normalized = normalizeWorkingContext(workingContext);
  if (!rootDir || !sessionId) return normalized;
  // Keep bounded active-session evidence outside session metadata's defensive
  // graph budget. The metadata ledger carries only routing/reference state.
  await writeSessionReadEvidence({ rootDir, sessionId, evidence: normalized.readEvidence || [] });
  const { readEvidence: _readEvidence, ...metadataWorkingContext } = normalized;
  return writeSessionMetadata({ rootDir, sessionId, extra: { workingContext: metadataWorkingContext } });
}

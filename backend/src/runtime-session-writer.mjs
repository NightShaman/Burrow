import { appendSessionActivity, appendSessionContextState, appendSessionEntry, appendSessionTurn } from './session-store.mjs';

export async function appendRuntimeSessionTurn({
  sessionRoot,
  dataRoot = null,
  sessionId,
  role,
  content,
  runId,
  traceDir,
  metadata = {},
} = {}) {
  return appendSessionTurn({ rootDir: sessionRoot || dataRoot, sessionId, role, content, runId, traceDir, metadata });
}

export async function appendRuntimeSessionEntry({
  sessionRoot,
  dataRoot = null,
  sessionId,
  type,
  role,
  content,
  runId,
  traceDir,
  metadata = {},
  visibility,
  entersPrompt,
  parentId,
} = {}) {
  return appendSessionEntry({ rootDir: sessionRoot || dataRoot, sessionId, type, role, content, runId, traceDir, metadata, visibility, entersPrompt, parentId });
}

export async function appendRuntimeSessionContextState({
  sessionRoot,
  dataRoot = null,
  sessionId,
  runId = null,
  traceDir = null,
  state,
} = {}) {
  return appendSessionContextState({ rootDir: sessionRoot || dataRoot, sessionId, runId, traceDir, state });
}

export async function appendRuntimeActivity({
  sessionRoot,
  dataRoot = null,
  sessionId,
  logger,
  runId = null,
  traceDir = null,
  sequence = 0,
  content,
  metadata = {},
} = {}) {
  if (!(sessionRoot || dataRoot) || !sessionId || !content) return null;
  return appendSessionActivity({
    rootDir: sessionRoot || dataRoot,
    sessionId,
    runId: runId || logger?.runId || null,
    traceDir: traceDir || logger?.traceDir || null,
    sequence,
    content,
    metadata,
  });
}

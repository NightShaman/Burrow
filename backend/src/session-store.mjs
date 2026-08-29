import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedRedactedValue, redactAndTruncateText } from './redaction.mjs';
import { normalizeSessionContextState } from './session-context-state.mjs';
import { assessInterruptedRunRecovery } from './recovery-resume-policy.mjs';

const SESSION_TAIL_READ_MAX_BYTES = 4 * 1024 * 1024;

function safeId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || randomUUID();
}

function nowIso() { return new Date().toISOString(); }
function sessionDir(rootDir, sessionId) {
  if (!rootDir) throw new Error('rootDir is required');
  return path.join(rootDir, 'sessions', safeId(sessionId));
}
function sessionFile(rootDir, sessionId) { return path.join(sessionDir(rootDir, sessionId), 'session.jsonl'); }
function sessionMetaFile(rootDir, sessionId) { return path.join(sessionDir(rootDir, sessionId), 'session.meta.json'); }
function resetArchiveMetaFile(rootDir, sessionId, fileName) { return path.join(sessionDir(rootDir, sessionId), `${String(fileName || '').replace(/\.jsonl$/, '')}.archive.json`); }
function continuityHeadFile(rootDir, sessionId) { return path.join(sessionDir(rootDir, sessionId), 'continuity-head.json'); }
function interruptedRunFile(rootDir, sessionId) { return path.join(sessionDir(rootDir, sessionId), 'interrupted-run.json'); }
function jsonLine(value) { return `${JSON.stringify(value)}\n`; }

const continuityLocks = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sessionLockDir(rootDir, sessionId, name) { return path.join(sessionDir(rootDir, sessionId), `.${name}-lock`); }
function continuityLockDir(rootDir, sessionId) { return sessionLockDir(rootDir, sessionId, 'continuity'); }

async function withSessionFileLock(rootDir, sessionId, name, fn) {
  const lockDir = sessionLockDir(rootDir, sessionId, name);
  await fs.mkdir(sessionDir(rootDir, sessionId), { recursive: true });
  for (let attempts = 0; attempts < 2_400; attempts += 1) {
    try {
      // mkdir is the lock acquisition. Unlike renaming a prepared directory,
      // it cannot replace an existing empty lock directory during owner-file
      // initialization. That replacement allowed two independent processes
      // to append the same transcript concurrently.
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }), 'utf8');
        return await fn();
      } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      // Do not reclaim a lock merely because its recorded PID exited. A
      // waiter can observe an old owner, that owner can release the lock, and
      // another process can acquire it before the waiter removes the path.
      // That sequence deletes the new owner's directory between mkdir() and
      // owner.json, producing the ENOENT seen under cross-process contention.
      // Recover only locks that have remained untouched long enough to be
      // abandoned; normal handoff never needs a contender to delete a lock.
      let stale = false;
      try { stale = Date.now() - (await fs.stat(lockDir)).mtimeMs > 60_000; } catch {}
      if (stale) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(25);
    }
  }
  throw new Error(`session continuity lock timed out: ${sessionId}`);
}
async function withContinuityFileLock(rootDir, sessionId, fn) { return withSessionFileLock(rootDir, sessionId, 'continuity', fn); }

async function withContinuityLock(rootDir, sessionId, fn) {
  const key = `${path.resolve(rootDir)}:${safeId(sessionId)}`;
  const previous = continuityLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  continuityLocks.set(key, queued);
  await previous.catch(() => {});
  try { return await withContinuityFileLock(rootDir, sessionId, fn); }
  finally {
    release();
    if (continuityLocks.get(key) === queued) continuityLocks.delete(key);
  }
}
async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}
function defaultVisibility({ type, role }) {
  if (type === 'message' && ['user', 'assistant', 'agent'].includes(String(role || ''))) return 'chat';
  return type === 'event' ? 'activity' : 'debug';
}
function defaultEntersPrompt({ type, role, visibility }) {
  return type === 'message' && ['user', 'assistant', 'agent'].includes(String(role || '')) && visibility === 'chat';
}
function redactedMetadata(metadata) {
  return boundedRedactedValue(metadata || {});
}

function retainedChatMetadata(metadata = {}) {
  // Successor transcripts preserve conversational provenance, not bulky
  // finalizer/debug receipts from the archived generation.
  const projected = {};
  for (const key of ['decision', 'canonicalExecution', 'executionDigest', 'toolResultCount', 'iteration', 'tool', 'callId', 'ok', 'toolCalls', 'normalizedResult', 'subjectScope', 'fromAgentId', 'fromAgentName', 'toAgentId', 'messageMode', 'sourceSessionId', 'targetSessionId', 'contextState']) {
    if (metadata?.[key] !== undefined) projected[key] = metadata[key];
  }
  return redactedMetadata(projected);
}
function normalizeTranscriptEntry(entry = {}, { sessionId = null } = {}) {
  const type = entry.type || 'message';
  const role = entry.role ?? null;
  const visibility = entry.visibility || defaultVisibility({ type, role });
  return {
    id: entry.id || randomUUID(), parentId: entry.parentId ?? null, ts: entry.ts || nowIso(),
    sessionId: safeId(entry.sessionId || sessionId), type, role, content: entry.content ?? '',
    contentTruncated: Boolean(entry.contentTruncated), runId: entry.runId ?? null, traceDir: entry.traceDir ?? null,
    visibility, entersPrompt: entry.entersPrompt ?? defaultEntersPrompt({ type, role, visibility }),
    metadata: redactedMetadata(entry.metadata || {}),
  };
}
function isChatMessage(entry) {
  return entry?.type === 'message' && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && entry?.visibility === 'chat' && entry?.entersPrompt === true && String(entry?.content || '').trim();
}

function normalizedArchiveTitleText(value = '') { return String(value || '').replace(/[`*_#[\]()>|]/g, ' ').replace(/\s+/g, ' ').trim(); }
function lowInformationArchiveTitle(value = '') {
  const text = normalizedArchiveTitleText(value).toLowerCase();
  return !text || text.length < 3 || /^(?:ok(ay)?|cool|nice|great|awesome|yep|yeah|yes|no|thanks?|thank you|hi|hello|hey|yo|sup|good (?:morning|afternoon|evening)|howdy|what'?s up|gm|morning|afternoon|evening)(?:[!?.\s]|there\b)*$/iu.test(text);
}
function titleCaseArchiveText(value = '') {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
  return normalizedArchiveTitleText(value).split(/\s+/).map((word, index) => {
    const lower = word.toLowerCase();
    if (index && small.has(lower)) return lower;
    if (/^[A-Z0-9_./-]{2,}$/.test(word)) return word;
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }).join(' ');
}
export function deriveArchiveTitle(turns = [], { fallback = 'Untitled conversation' } = {}) {
  const users = (turns || []).filter((turn) => turn?.role === 'user' && String(turn.content || '').trim());
  const candidate = users.find((turn) => !lowInformationArchiveTitle(turn.content)) || users[0];
  if (!candidate) return fallback;
  let title = normalizedArchiveTitleText(candidate.content).replace(/^(ok(ay)?|so|hey|yo|alright|well)[,\s]+/i, '').trim();
  title = title.match(/^(.{12,120}?[.!?])\s/)?.[1] || title.split('\n')[0] || title;
  if (title.length > 80) title = `${title.slice(0, 80).replace(/\s+\S*$/, '').trim()}…`;
  return title.length >= 3 ? titleCaseArchiveText(title) : fallback;
}

function isCanonicalExecutionEntry(entry) {
  return ['tool_call', 'tool_result'].includes(String(entry?.type || ''))
    && entry?.metadata?.canonicalExecution === true
    && String(entry?.content || '').trim();
}

function isExecutionDigestEntry(entry) {
  return String(entry?.type || '') === 'execution_digest'
    && entry?.metadata?.executionDigest === true
    && entry?.entersPrompt === true
    && String(entry?.content || '').trim();
}
function isCompactionTailEntry(entry) {
  return String(entry?.type || '') === 'context_state' || isChatMessage(entry) || isExecutionDigestEntry(entry) || isCanonicalExecutionEntry(entry);
}
async function fileExists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

// Active transcripts are intentionally small. Metadata is an index, not a second
// transcript: counters, lineage pointers, and stable session state only.
function classifySession(sessionId, metadata = {}) {
  const explicit = String(metadata.kind || metadata.sessionKind || '').toLowerCase();
  if (['main', 'task', 'subagent', 'system'].includes(explicit)) return explicit;
  if (['subagent-task', 'worker', 'child'].includes(explicit)) return 'subagent';
  if (metadata.parentSessionId || metadata.parentConversationId || metadata.subagentId) return 'subagent';
  if (/^task[-_:]/i.test(String(sessionId)) || metadata.ownerTaskId) return 'task';
  return 'main';
}

function initialMetadata(sessionId, ts = nowIso()) {
  const kind = classifySession(sessionId);
  return {
    version: 4, sessionKey: sessionId, sessionId, conversationId: randomUUID(), transcriptGeneration: randomUUID(),
    activeTranscript: 'session.jsonl', compactedTranscripts: [], chatType: 'direct', kind,
    parentSessionId: null, ownerTaskId: kind === 'task' ? String(sessionId).replace(/^task[-_:]/i, '') : null,
    createdAt: ts, updatedAt: ts, completedAt: null, archivedAt: null, retentionEligibleAt: null,
    turnCount: 0, chatTurnCount: 0, lastInteractionAt: null, lastRole: null, lastRunId: null,
  };
}

export async function readSessionMetadata({ rootDir, sessionId } = {}) {
  try {
    const text = await fs.readFile(sessionMetaFile(rootDir, safeId(sessionId)), 'utf8');
    return text.trim() ? JSON.parse(text) : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readSessionContinuityHead({ rootDir, sessionId } = {}) {
  try {
    const text = await fs.readFile(continuityHeadFile(rootDir, safeId(sessionId)), 'utf8');
    const value = text.trim() ? JSON.parse(text) : null;
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function boundedRecoveryText(value, limit = 1_200) { return String(value || '').trim().slice(0, limit) || null; }
function normalizeInterruptedRunManifest(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    sessionId: boundedRecoveryText(source.sessionId, 120),
    runId: boundedRecoveryText(source.runId, 200),
    generation: Number.isSafeInteger(source.generation) ? source.generation : null,
    status: 'interrupted',
    reason: boundedRecoveryText(source.reason, 160) || 'unknown',
    interruptedAt: boundedRecoveryText(source.interruptedAt, 64) || nowIso(),
    objective: boundedRecoveryText(source.objective, 2_000),
    lastCompletedStep: boundedRecoveryText(source.lastCompletedStep, 1_200),
    pendingVerification: Array.isArray(source.pendingVerification) ? source.pendingVerification.map((item) => boundedRecoveryText(item, 400)).filter(Boolean).slice(0, 8) : [],
    changedFiles: Array.isArray(source.changedFiles) ? source.changedFiles.map((item) => boundedRecoveryText(item, 500)).filter(Boolean).slice(0, 12) : [],
    traceRef: boundedRecoveryText(source.traceRef, 1_000),
  };
}
export async function readInterruptedRunManifest({ rootDir, sessionId } = {}) {
  try {
    const text = await fs.readFile(interruptedRunFile(rootDir, safeId(sessionId)), 'utf8');
    const value = text.trim() ? JSON.parse(text) : null;
    return value?.status === 'interrupted' ? value : null;
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function recordInterruptedRun({ rootDir, sessionId, runId, generation, reason, objective = null, lastCompletedStep = null, pendingVerification = [], changedFiles = [], traceRef = null, workingContext = null, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  return withContinuityLock(rootDir, id, async () => {
    await fs.mkdir(sessionDir(rootDir, id), { recursive: true });
    const manifest = normalizeInterruptedRunManifest({ sessionId: id, runId, generation, reason, objective, lastCompletedStep, pendingVerification, changedFiles, traceRef, workingContext, interruptedAt: clock() });
    await atomicWriteJson(interruptedRunFile(rootDir, id), manifest);
    const assessment = await assessInterruptedRunRecovery({ rootDir, sessionId: id, manifest, readChatMessages });
    await atomicWriteJson(recoveryContinuationFile(rootDir, id), normalizeRecoveryContinuation({ decision: assessment.action, decisionReason: assessment.reason, transcriptMessages: assessment.transcriptMessages, autoResume: assessment.autoResume }, manifest));
    const head = await readSessionContinuityHead({ rootDir, sessionId: id });
    // Shutdown observers know the active run identity but may not have its
    // private continuity generation. A matching run id is sufficient to close
    // that live owner; when a generation is supplied it remains a strict guard.
    const generationMatches = generation === null || generation === undefined || Number(head?.generation) === Number(generation);
    if (head?.runId === String(runId) && generationMatches && (head.state === 'running' || head.state === 'finalizing')) {
      await atomicWriteJson(continuityHeadFile(rootDir, id), { ...head, state: 'interrupted', interruptedAt: manifest.interruptedAt, interruption: { reason: manifest.reason, runId: manifest.runId } });
    }
    return manifest;
  });
}

function continuitySnapshot(metadata = {}) {
  return {
    transcriptGeneration: metadata?.transcriptGeneration || null,
    lastRunId: metadata?.lastRunId || null,
    updatedAt: metadata?.updatedAt || null,
  };
}

function processIsAlive(processId) {
  const pid = Number(processId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but belongs to another account.
    return error?.code === 'EPERM';
  }
}

async function recoverAbandonedContinuityHead({ rootDir, sessionId, prior, metadata, reason, clock }) {
  // Never retry a possibly partial terminal finalizer. The transcript is the
  // canonical record of what reached disk; recovery only closes its abandoned
  // ownership generation so a later turn can safely claim a new one.
  const recoveredAt = clock();
  const completedMetadata = {
    ...metadata,
    kind: metadata.kind || classifySession(sessionId, metadata),
    completedAt: metadata.completedAt || recoveredAt,
    retentionEligibleAt: metadata.retentionEligibleAt || recoveredAt,
    updatedAt: metadata.updatedAt || recoveredAt,
  };
  await writeMetadata(rootDir, sessionId, completedMetadata);
  const recovered = {
    ...prior,
    latestRunId: completedMetadata.lastRunId || prior.runId || prior.latestRunId || null,
    state: 'interrupted',
    interruptedAt: recoveredAt,
    snapshot: continuitySnapshot(completedMetadata),
    recoveredAt,
    recovery: { reason, abandonedRunId: prior.runId || null },
  };
  const manifest = normalizeInterruptedRunManifest({ sessionId, runId: prior.runId, generation: prior.generation, reason, interruptedAt: recoveredAt, lastCompletedStep: 'Run ownership was abandoned; reconcile durable session and workspace state before continuing.' });
  await atomicWriteJson(interruptedRunFile(rootDir, sessionId), manifest);
  await atomicWriteJson(recoveryContinuationFile(rootDir, sessionId), normalizeRecoveryContinuation({}, manifest));
  await atomicWriteJson(continuityHeadFile(rootDir, sessionId), recovered);
  return { prior: recovered, metadata: completedMetadata, manifest };
}

export async function claimSessionContinuityHead({ rootDir, sessionId, runId, acceptedLatestRunIds = [], clock = nowIso } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (!runId) throw new Error('runId is required');
  const id = safeId(sessionId);
  return withContinuityLock(rootDir, id, async () => {
    await fs.mkdir(sessionDir(rootDir, id), { recursive: true });
    let prior = await readSessionContinuityHead({ rootDir, sessionId: id });
    let metadata = await readSessionMetadata({ rootDir, sessionId: id }) || await writeSessionMetadata({ rootDir, sessionId: id });
    if (!metadata.kind) metadata.kind = classifySession(id, metadata);
    let snapshot = continuitySnapshot(metadata);
    let recoveryManifest = prior?.state === 'interrupted' ? await readInterruptedRunManifest({ rootDir, sessionId: id }) : null;
    // An owner that exited after persisting transcript state cannot finish its
    // generation. Close it without replaying its work; the next turn receives
    // a fresh generation over the durable transcript instead of a permanent
    // user-visible continuity_uncertain failure.
    const abandonedFinalization = prior?.state === 'finalizing' && !processIsAlive(prior.processId);
    const abandonedForeignRun = prior?.state === 'running' && Number(prior?.processId) !== process.pid && snapshot.lastRunId === prior.runId && !processIsAlive(prior.processId);
    const completedHeadBehindTranscript = prior?.state === 'completed' && prior.latestRunId && snapshot.lastRunId && snapshot.lastRunId !== prior.latestRunId;
    if (abandonedFinalization || abandonedForeignRun || completedHeadBehindTranscript) {
      const recovery = await recoverAbandonedContinuityHead({
        rootDir,
        sessionId: id,
        prior,
        metadata,
        reason: abandonedFinalization ? 'terminal_finalization_abandoned' : (abandonedForeignRun ? 'interrupted_run_abandoned' : 'completed_head_behind_transcript'),
        clock,
      });
      prior = recovery.prior;
      metadata = recovery.metadata;
      snapshot = continuitySnapshot(metadata);
      recoveryManifest = recovery.manifest || recoveryManifest;
    }
    // Trusted internal ingress (for example, an attributed agent message) may
    // append a transcript turn before its bounded recipient run can claim the
    // head. That known append must not be mistaken for an interrupted foreign
    // run, while arbitrary transcript advances remain fail-closed.
    const acceptedLatest = new Set((Array.isArray(acceptedLatestRunIds) ? acceptedLatestRunIds : [acceptedLatestRunIds]).map((value) => String(value || '')).filter(Boolean));
    const completedStateDisagrees = Boolean(prior?.state === 'completed' && prior.latestRunId && snapshot.lastRunId && snapshot.lastRunId !== prior.latestRunId && !acceptedLatest.has(snapshot.lastRunId));
    // A different process cannot safely decide whether an interrupted run
    // finished persisting. Refuse to replace it when transcript metadata
    // shows that run advanced beyond the prior completed head.
    const interruptedForeignRun = Boolean(prior?.state === 'running' && Number(prior?.processId) !== process.pid && snapshot.lastRunId === prior.runId && processIsAlive(prior.processId));
    const finalizationUncertain = prior?.state === 'finalizing' && processIsAlive(prior.processId);
    const continuityUncertain = completedStateDisagrees || interruptedForeignRun || finalizationUncertain;
    const head = {
      version: 1,
      sessionId: id,
      processId: process.pid,
      generation: Number(prior?.generation || 0) + 1,
      runId: String(runId),
      latestRunId: prior?.latestRunId || snapshot.lastRunId || null,
      state: continuityUncertain ? 'continuity_uncertain' : 'running',
      claimedAt: clock(),
      completedAt: null,
      snapshot,
      ...(continuityUncertain ? { reason: finalizationUncertain ? 'terminal_finalization_incomplete' : (interruptedForeignRun ? 'interrupted_run_from_another_process' : 'session_metadata_ahead_of_last_completed_head') } : {}),
    };
    await atomicWriteJson(continuityHeadFile(rootDir, id), head);
    return { ...head, current: !continuityUncertain, recoveryManifest };
  });
}

export async function isSessionContinuityCurrent({ rootDir, sessionId, runId, generation } = {}) {
  const head = await readSessionContinuityHead({ rootDir, sessionId });
  return Boolean(head && head.state === 'running' && head.runId === String(runId) && Number(head.generation) === Number(generation));
}

export async function commitSessionContinuityHead({ rootDir, sessionId, runId, generation, commit = null, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  return withContinuityLock(rootDir, id, async () => {
    const head = await readSessionContinuityHead({ rootDir, sessionId: id });
    if (!head || head.state !== 'running' || head.runId !== String(runId) || Number(head.generation) !== Number(generation)) return { ok: false, stale: true, head, value: null };
    // Publish intent before any terminal side effect. If finalization throws or
    // the process dies later, future claims fail closed instead of retrying
    // append-heavy finalizers and duplicating receipts/transcript entries.
    const finalizing = { ...head, state: 'finalizing', finalizationStartedAt: clock() };
    await atomicWriteJson(continuityHeadFile(rootDir, id), finalizing);
    let value;
    try {
      value = typeof commit === 'function' ? await commit(finalizing) : null;
    } catch (error) {
      const metadata = await readSessionMetadata({ rootDir, sessionId: id }) || initialMetadata(id);
      await recoverAbandonedContinuityHead({ rootDir, sessionId: id, prior: finalizing, metadata, reason: 'terminal_finalization_failed', clock });
      throw error;
    }
    const metadata = await readSessionMetadata({ rootDir, sessionId: id }) || initialMetadata(id);
    const completedAt = clock();
    const completedMetadata = {
      ...metadata,
      kind: metadata.kind || classifySession(id, metadata),
      completedAt,
      retentionEligibleAt: completedAt,
      updatedAt: completedAt,
    };
    await writeMetadata(rootDir, id, completedMetadata);
    const completed = { ...head, latestRunId: String(runId), state: 'completed', completedAt, snapshot: continuitySnapshot(completedMetadata) };
    await atomicWriteJson(continuityHeadFile(rootDir, id), completed);
    return { ok: true, stale: false, head: completed, value };
  });
}

export async function completeSessionContinuityHead(args = {}) {
  return commitSessionContinuityHead(args);
}

async function writeMetadata(rootDir, sessionId, metadata) {
  await fs.mkdir(sessionDir(rootDir, sessionId), { recursive: true });
  // Session resets and terminal appends can overlap. Atomic replacement keeps
  // readers from ever observing interleaved/truncated JSON metadata.
  await atomicWriteJson(sessionMetaFile(rootDir, sessionId), metadata);
  return metadata;
}

async function updateSessionMetadataAfterAppend({ rootDir, sessionId, entry } = {}) {
  const existing = await readSessionMetadata({ rootDir, sessionId });
  // Attributed A2A messages are transcript ingress, not runs owned by this
  // session. Their source run ID must not advance the recipient's continuity
  // head; doing so makes queued/delivery-only messages look like an
  // interrupted foreign run. The eventual recipient run claims its own head.
  const advancesContinuity = entry?.metadata?.kind !== 'agent-message';
  const metadata = {
    ...(existing || initialMetadata(sessionId, entry.ts)),
    version: 4, sessionKey: existing?.sessionKey || sessionId, sessionId,
    kind: existing?.kind || classifySession(sessionId, existing || {}),
    ownerTaskId: existing?.ownerTaskId || (classifySession(sessionId, existing || {}) === 'task' ? String(sessionId).replace(/^task[-_:]/i, '') : null),
    activeTranscript: 'session.jsonl', updatedAt: entry.ts || nowIso(),
    turnCount: Number(existing?.turnCount || 0) + 1,
    chatTurnCount: Number(existing?.chatTurnCount || 0) + (isChatMessage(entry) ? 1 : 0),
    lastInteractionAt: isChatMessage(entry) ? entry.ts : (existing?.lastInteractionAt || null),
    lastRole: entry.role || null,
    lastRunId: advancesContinuity ? (entry.runId || null) : (existing?.lastRunId || null),
  };
  return writeMetadata(rootDir, sessionId, metadata);
}

const sessionAppendQueues = new Map();
async function withSessionAppendLock(rootDir, sessionId, operation) {
  const key = `${path.resolve(rootDir)}:${sessionId}`;
  const prior = sessionAppendQueues.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(() => withSessionFileLock(rootDir, sessionId, 'append', operation));
  sessionAppendQueues.set(key, current);
  return current.finally(() => { if (sessionAppendQueues.get(key) === current) sessionAppendQueues.delete(key); });
}

export async function appendSessionEntry({ rootDir, sessionId, type = 'message', role = null, content, runId = null, traceDir = null, metadata = {}, visibility = null, entersPrompt = undefined, parentId = null, clock = nowIso, maxContentChars = 20_000 } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (type === 'message' && !role) throw new Error('role is required for message entries');
  const resolvedSessionId = safeId(sessionId);
  await fs.mkdir(sessionDir(rootDir, resolvedSessionId), { recursive: true });
  const contentEnvelope = redactAndTruncateText(content || '', { maxChars: maxContentChars });
  const resolvedVisibility = visibility || defaultVisibility({ type, role });
  const entry = normalizeTranscriptEntry({
    id: randomUUID(), parentId, ts: clock(), sessionId: resolvedSessionId, type: String(type),
    role: role === null || role === undefined ? null : String(role), content: contentEnvelope.text,
    contentTruncated: contentEnvelope.truncated, runId, traceDir, visibility: resolvedVisibility,
    entersPrompt: entersPrompt ?? defaultEntersPrompt({ type, role, visibility: resolvedVisibility }), metadata,
  }, { sessionId: resolvedSessionId });
  return withSessionAppendLock(rootDir, resolvedSessionId, async () => {
    await fs.appendFile(sessionFile(rootDir, resolvedSessionId), jsonLine(entry), 'utf8');
    await updateSessionMetadataAfterAppend({ rootDir, sessionId: resolvedSessionId, entry });
    return entry;
  });
}
export async function appendSessionTurn(args = {}) { return appendSessionEntry({ ...args, type: 'message' }); }

/**
 * Persist one normalized operational event as a chat-visible activity stream.
 * Activity is intentionally excluded from prompt assembly by `entersPrompt:false`.
 */
export async function appendSessionContextState({ rootDir, sessionId, runId = null, traceDir = null, state, clock = nowIso } = {}) {
  const contextState = normalizeSessionContextState(state);
  return appendSessionEntry({ rootDir, sessionId, type: 'context_state', role: null, content: contextState.title, runId, traceDir, visibility: 'debug', entersPrompt: false, metadata: { contextState }, clock });
}

export async function appendSessionActivity({ rootDir, sessionId, runId = null, traceDir = null, sequence, content, metadata = {}, clock = nowIso } = {}) {
  const normalizedSequence = Number(sequence);
  if (!Number.isSafeInteger(normalizedSequence) || normalizedSequence < 0) throw new Error('activity_sequence_invalid');
  return appendSessionEntry({
    rootDir,
    sessionId,
    type: 'event',
    role: null,
    content,
    runId,
    traceDir,
    visibility: 'activity',
    entersPrompt: false,
    clock,
    metadata: { ...metadata, activitySequence: normalizedSequence },
    maxContentChars: 4_000,
  });
}

async function readJsonLines(filePath) {
  const lines = [];
  let remainder = '';
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    const parts = (remainder + chunk).split('\n');
    remainder = parts.pop();
    lines.push(...parts.filter(Boolean));
  }
  if (remainder.trim()) lines.push(remainder);
  return lines;
}
async function readTailJsonLines(filePath, limit) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return [];
    let bytes = Math.min(size, 64 * 1024, SESSION_TAIL_READ_MAX_BYTES);
    while (true) {
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.allocUnsafe(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      if (start > 0) lines.shift();
      if (lines.length >= limit || start === 0 || bytes >= SESSION_TAIL_READ_MAX_BYTES) return lines.slice(-limit);
      bytes = Math.min(size, SESSION_TAIL_READ_MAX_BYTES, bytes * 2);
    }
  } finally { await handle.close(); }
}
async function transcriptPaths(rootDir, sessionId, includeHistory, includeResetHistory = false) {
  const active = sessionFile(rootDir, sessionId);
  if (!includeHistory) return [active];
  const directory = sessionDir(rootDir, sessionId);
  let names = [];
  try { names = await fs.readdir(directory); } catch (error) { if (error?.code === 'ENOENT') return [active]; throw error; }
  const historyPattern = includeResetHistory ? /^session\.(?:compacted|reset)\..+\.jsonl$/ : /^session\.compacted\..+\.jsonl$/;
  return [...names.filter((name) => historyPattern.test(name)).sort().map((name) => path.join(directory, name)), active];
}

function resetSnapshotId(sessionId, fileName) {
  return `${safeId(sessionId)}.${String(fileName || '').replace(/^session\./, '').replace(/\.jsonl$/, '')}`;
}

async function readTranscriptFile(filePath, sessionId, { resetArchive = false } = {}) {
  const lines = await readJsonLines(filePath);
  const entries = [];
  for (const line of lines) {
    try {
      const entry = normalizeTranscriptEntry(JSON.parse(line), { sessionId });
      entries.push(resetArchive ? { ...entry, metadata: { ...(entry.metadata || {}), resetArchive: true } } : entry);
    } catch { /* malformed legacy row */ }
  }
  return entries;
}

// Reset snapshots are human-facing archive documents, not sessions. Keep their
// discovery out of listSessionRecords/readSessionTurns so they can never enter
// normal context, continuity, or session-search paths.
export async function listResetSessionArchives({ rootDir, query = '', limit = 100 } = {}) {
  const base = path.join(rootDir, 'sessions');
  let directories = [];
  try { directories = await fs.readdir(base, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const needle = String(query || '').toLowerCase();
  const snapshots = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const sessionId = safeId(directory.name);
    let names = [];
    try { names = await fs.readdir(sessionDir(rootDir, sessionId)); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    for (const fileName of names.filter((name) => /^session\.reset\..+\.jsonl$/.test(name)).sort()) {
      const filePath = path.join(sessionDir(rootDir, sessionId), fileName);
      const entries = await readTranscriptFile(filePath, sessionId);
      const chatTurns = entries.filter(isChatMessage);
      const last = chatTurns.at(-1) || entries.at(-1) || null;
      const id = resetSnapshotId(sessionId, fileName);
      if (needle && !`${id}\n${chatTurns.map((turn) => turn.content).join('\n')}`.toLowerCase().includes(needle)) continue;
      const stat = await fs.stat(filePath);
      let archiveMetadata = {};
      try { archiveMetadata = JSON.parse(await fs.readFile(resetArchiveMetaFile(rootDir, sessionId, fileName), 'utf8')) || {}; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      snapshots.push({ id, sourceSessionId: sessionId, fileName, archiveSnapshot: 'reset', turnCount: entries.length, chatTurnCount: chatTurns.length, createdAt: entries.at(0)?.ts || stat.birthtime.toISOString(), updatedAt: last?.ts || stat.mtime.toISOString(), lastRole: last?.role || null, lastContent: last?.content || '', archiveTitle: archiveMetadata.title || deriveArchiveTitle(chatTurns, { fallback: `Conversation from ${sessionId}` }), archiveSummary: archiveMetadata.summary || null, summaryStatus: archiveMetadata.summaryStatus || 'not_configured', summarizedAt: archiveMetadata.summarizedAt || null });
    }
  }
  return snapshots.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
}

export async function readResetSessionArchive({ rootDir, archiveId } = {}) {
  const id = String(archiveId || '').trim();
  const snapshot = (await listResetSessionArchives({ rootDir, limit: 10_000 })).find((item) => item.id === id);
  if (!snapshot) return null;
  const turns = await readTranscriptFile(path.join(sessionDir(rootDir, snapshot.sourceSessionId), snapshot.fileName), snapshot.sourceSessionId);
  return { ...snapshot, turns };
}

export async function writeResetSessionArchiveMetadata({ rootDir, archiveId, metadata = {} } = {}) {
  const snapshot = (await listResetSessionArchives({ rootDir, limit: 10_000 })).find((item) => item.id === String(archiveId || '').trim());
  if (!snapshot) return null;
  const filePath = resetArchiveMetaFile(rootDir, snapshot.sourceSessionId, snapshot.fileName);
  let prior = {};
  try { prior = JSON.parse(await fs.readFile(filePath, 'utf8')) || {}; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const value = { ...prior, ...redactedMetadata(metadata), updatedAt: nowIso() };
  await atomicWriteJson(filePath, value);
  return value;
}

export async function readSessionTurns({ rootDir, sessionId, limit = 20, includeHistory = false, includeResetHistory = false } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!sessionId) throw new Error('sessionId is required');
  const resolvedSessionId = safeId(sessionId);
  const paths = await transcriptPaths(rootDir, resolvedSessionId, includeHistory, includeResetHistory);
  const entries = [];
  for (const filePath of paths) {
    const resetArchive = /\/session\.reset\..+\.jsonl$/.test(filePath);
    try {
      const sourceLines = !includeHistory && Number.isFinite(limit) && limit > 0 ? await readTailJsonLines(filePath, limit) : await readJsonLines(filePath);
      for (const line of sourceLines) {
        try {
          const entry = normalizeTranscriptEntry(JSON.parse(line), { sessionId: resolvedSessionId });
          entries.push(resetArchive ? { ...entry, metadata: { ...(entry.metadata || {}), resetArchive: true } } : entry);
        } catch { /* malformed legacy row */ }
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries;
}
export async function readSessionEntries(args = {}) { return readSessionTurns(args); }

// Read-only portable representation of the canonical persisted session stream.
// Compacted generations are included by default so an external memory system can
// ingest the full surviving record rather than only the active prompt tail.
// Reset snapshots remain separate archive documents and are intentionally not
// mixed into the new session that follows a reset.
export async function exportSessionTranscript({ rootDir, sessionId } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!sessionId) throw new Error('sessionId is required');
  const id = safeId(sessionId);
  const metadata = await readSessionMetadata({ rootDir, sessionId: id });
  if (!metadata) return null;
  const entries = await readSessionTurns({ rootDir, sessionId: id, limit: 0, includeHistory: true });
  return {
    schemaVersion: '1',
    session: { id, metadata },
    entries,
  };
}

// Planner state is structured turn metadata, not a prose-history window.
export async function readSessionPendingActions({ rootDir, sessionId } = {}) {
  const entries = await readSessionTurns({ rootDir, sessionId, limit: 0 });
  return entries.flatMap((entry) => {
    const pending = [entry?.metadata?.pendingAction, ...(entry?.metadata?.pendingActions || [])].filter(Boolean);
    return pending.map((action) => ({ ...action, turnId: entry.id || null, role: entry.role || null }));
  });
}
async function readFiltered({ rootDir, sessionId, limit, predicate, includeHistory = false }) {
  const entries = await readSessionTurns({ rootDir, sessionId, limit: limit > 0 ? Math.max(limit * 4, 100) : 0, includeHistory });
  const matched = entries.filter(predicate);
  return Number.isFinite(limit) && limit > 0 ? matched.slice(-limit) : matched;
}
export async function readChatMessages({ rootDir, sessionId, limit = 20, includeHistory = false } = {}) { return readFiltered({ rootDir, sessionId, limit, includeHistory, predicate: isChatMessage }); }
export async function readActivityEvents({ rootDir, sessionId, limit = 50, includeHistory = false } = {}) { return readFiltered({ rootDir, sessionId, limit, includeHistory, predicate: (entry) => entry.visibility === 'activity' }); }
export async function readDebugEntries({ rootDir, sessionId, limit = 50, includeHistory = false } = {}) { return readFiltered({ rootDir, sessionId, limit, includeHistory, predicate: (entry) => entry.visibility === 'debug' || entry.visibility === 'hidden' }); }

export function summarizeSessionTurns(turns = [], { maxChars = 4000 } = {}) {
  const rendered = (turns || []).map((turn) => turn.role === 'agent'
    ? `[Agent message from ${turn.metadata?.fromAgentName || turn.metadata?.fromAgentId || 'another agent'}]: ${turn.content}`
    : `${turn.role}: ${turn.content}`).join('\n\n').trim();
  if (!rendered || !Number.isFinite(maxChars) || rendered.length <= maxChars) return rendered;
  const markerFor = (omitted) => `\n\n[truncated ${omitted} chars from earlier session turns]`;
  let retainedChars = Math.max(0, maxChars - markerFor(0).length);
  let retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  for (let index = 0; index < 3; index += 1) {
    const marker = markerFor(rendered.length - retained.length);
    retainedChars = Math.max(0, maxChars - marker.length);
    retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  }
  return `${retained}${markerFor(rendered.length - retained.length)}`;
}

// Compatibility entry point for callers that update durable session state. It
// deliberately never rebuilds metadata by replaying the transcript.
export async function writeSessionMetadata({ rootDir, sessionId, extra = {} } = {}) {
  const id = safeId(sessionId);
  const existing = await readSessionMetadata({ rootDir, sessionId: id });
  const metadata = { ...(existing || initialMetadata(id)), ...redactedMetadata(extra), version: 3, sessionKey: extra.sessionKey || existing?.sessionKey || id, sessionId: id, activeTranscript: 'session.jsonl' };
  return writeMetadata(rootDir, id, metadata);
}

export async function loadSessionContext({ rootDir, sessionId, limit = 12, maxChars = 4000 } = {}) {
  const turns = await readSessionTurns({ rootDir, sessionId, limit });
  const metadata = await readSessionMetadata({ rootDir, sessionId }) || await writeSessionMetadata({ rootDir, sessionId });
  return { sessionId: safeId(sessionId), turnCount: metadata.turnCount ?? turns.length, turns, summary: summarizeSessionTurns(turns.filter(isChatMessage), { maxChars }), metadata };
}

export async function rotateCompactedTranscript({ rootDir, sessionId, summary, tailEntries = [], clock = nowIso } = {}) {
  const id = safeId(sessionId);
  const active = sessionFile(rootDir, id);
  const stamp = clock().replace(/[:.]/g, '-');
  const archiveName = `session.compacted.${stamp}.jsonl`;
  const archivePath = path.join(sessionDir(rootDir, id), archiveName);
  if (await fileExists(active)) await fs.rename(active, archivePath);
  const summaryEntry = normalizeTranscriptEntry({
    id: randomUUID(), ts: clock(), sessionId: id, type: 'summary', role: null, content: summary.text,
    visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary },
  }, { sessionId: id });
  const retained = tailEntries.filter(isCompactionTailEntry).map((entry) => normalizeTranscriptEntry({
    ...entry,
    sessionId: id,
    metadata: retainedChatMetadata(entry.metadata),
  }, { sessionId: id }));
  await fs.writeFile(active, [summaryEntry, ...retained].map(jsonLine).join(''), 'utf8');
  const existing = await readSessionMetadata({ rootDir, sessionId: id });
  const metadata = {
    ...(existing || initialMetadata(id, summaryEntry.ts)), version: 3, sessionKey: existing?.sessionKey || id, sessionId: id,
    transcriptGeneration: randomUUID(), activeTranscript: 'session.jsonl',
    compactedTranscripts: [...(existing?.compactedTranscripts || []), archiveName], updatedAt: summaryEntry.ts,
    turnCount: 1 + retained.length, chatTurnCount: retained.filter(isChatMessage).length,
    lastInteractionAt: retained.filter(isChatMessage).at(-1)?.ts || existing?.lastInteractionAt || null,
    lastRole: retained.at(-1)?.role || null, lastRunId: retained.at(-1)?.runId || null,
  };
  await writeMetadata(rootDir, id, metadata);
  return { archivePath, archiveName, summaryEntry, retainedCount: retained.length, metadata };
}

export async function resetSession({ rootDir, sessionId, clock = nowIso } = {}) {
  // A reset starts a new conversation identity. Runtime derives a fresh opaque
  // continuity scope from this new conversationId on its next normal turn.
  const id = safeId(sessionId); const active = sessionFile(rootDir, id); const stamp = clock().replace(/[:.]/g, '-');
  // Reset archives are immutable proof. A clock can repeat, so a timestamp
  // alone cannot be a unique archive identity: POSIX rename would otherwise
  // replace an earlier snapshot at the same destination.
  const directory = sessionDir(rootDir, id);
  const archivePath = path.join(directory, `session.reset.${stamp}.${randomUUID()}.jsonl`);
  // A session may exist logically (for example, the registered default
  // session) before any transcript file or directory has been materialized.
  // Reset must create its storage boundary before attempting an archive, and
  // only read archive contents when a transcript was actually rotated.
  await fs.mkdir(directory, { recursive: true });
  const archived = await fileExists(active);
  if (archived) await fs.rename(active, archivePath);
  const archiveEntries = archived ? await readTranscriptFile(archivePath, id) : [];
  if (archiveEntries.length) await atomicWriteJson(resetArchiveMetaFile(rootDir, id, path.basename(archivePath)), { title: deriveArchiveTitle(archiveEntries.filter(isChatMessage), { fallback: `Conversation from ${id}` }), titleSource: 'derived', summary: null, summaryStatus: 'not_configured', summarizedAt: null, createdAt: clock() });
  const prior = await readSessionMetadata({ rootDir, sessionId: id });
  const metadata = { ...initialMetadata(id, clock()), conversationId: randomUUID(), resetAt: clock(), resetArchive: path.basename(archivePath), archived: prior?.archived || false, archivedAt: prior?.archivedAt || null };
  await writeMetadata(rootDir, id, metadata);
  await fs.rm(continuityHeadFile(rootDir, id), { force: true });
  return { ok: true, sessionId: id, conversationId: metadata.conversationId, archivedPath: (await fileExists(archivePath)) ? archivePath : null, metadata };
}

export async function forkSession({ rootDir, sourceSessionId, targetSessionId, limit = 200, clock = nowIso } = {}) {
  if (!sourceSessionId || !targetSessionId) throw new Error('sourceSessionId and targetSessionId are required');
  const sourceId = safeId(sourceSessionId); const targetId = safeId(targetSessionId);
  const turns = await readSessionTurns({ rootDir, sessionId: sourceId, limit });
  await fs.mkdir(sessionDir(rootDir, targetId), { recursive: true });
  await fs.writeFile(sessionFile(rootDir, targetId), turns.map((turn) => jsonLine({ ...turn, sessionId: targetId, metadata: { ...(turn.metadata || {}), forkedFrom: sourceId } })).join(''), 'utf8');
  const metadata = { ...initialMetadata(targetId, clock()), forkedFrom: sourceId, forkedAt: clock(), turnCount: turns.length, chatTurnCount: turns.filter(isChatMessage).length, updatedAt: turns.at(-1)?.ts || clock() };
  await writeMetadata(rootDir, targetId, metadata);
  return { ok: true, sourceSessionId: sourceId, targetSessionId: targetId, copiedTurns: turns.length, metadata };
}

export async function listSessionRecords({ rootDir, includeArchived = false, query = '', limit = 100 } = {}) {
  const base = path.join(rootDir, 'sessions'); let directories = [];
  try { directories = await fs.readdir(base, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const needle = String(query || '').toLowerCase(); const records = [];
  for (const entry of directories.filter((item) => item.isDirectory())) {
    const id = entry.name; const metadata = await readSessionMetadata({ rootDir, sessionId: id }) || await writeSessionMetadata({ rootDir, sessionId: id });
    if (!metadata.kind) {
      metadata.kind = classifySession(id, metadata);
      await writeMetadata(rootDir, id, metadata);
    }
    if (!includeArchived && metadata.archived) continue;
    const turns = needle ? await readSessionTurns({ rootDir, sessionId: id, limit: 50 }) : [];
    if (needle && !`${id}\n${turns.map((turn) => turn.content).join('\n')}`.toLowerCase().includes(needle)) continue;
    records.push({ id, metadata, turnCount: metadata.turnCount || 0, updatedAt: metadata.updatedAt || null, archived: Boolean(metadata.archived), summary: '' });
  }
  return records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
}

export async function renameSession({ rootDir, sessionId, targetSessionId, clock = nowIso } = {}) {
  const sourceId = safeId(sessionId); const targetId = safeId(targetSessionId);
  if (sourceId === targetId) return { ok: true, sessionId: sourceId, targetSessionId: targetId, unchanged: true };
  const targetDir = sessionDir(rootDir, targetId); if (await fileExists(targetDir)) throw new Error(`target session already exists: ${targetId}`);
  await fs.rename(sessionDir(rootDir, sourceId), targetDir);
  const metadata = await readSessionMetadata({ rootDir, sessionId: targetId }) || initialMetadata(targetId);
  await writeMetadata(rootDir, targetId, { ...metadata, sessionKey: targetId, sessionId: targetId, renamedFrom: sourceId, renamedAt: clock() });
  return { ok: true, sessionId: targetId, previousSessionId: sourceId, copiedTurns: metadata.turnCount || 0, metadata: await readSessionMetadata({ rootDir, sessionId: targetId }) };
}
export async function archiveSession({ rootDir, sessionId, archived = true, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  const turns = archived ? await readChatMessages({ rootDir, sessionId: id, limit: 0 }) : [];
  const archiveTitle = archived ? deriveArchiveTitle(turns, { fallback: `Conversation from ${id}` }) : undefined;
  const metadata = await writeSessionMetadata({ rootDir, sessionId: id, extra: { archived: Boolean(archived), archivedAt: archived ? clock() : null, ...(archived ? { archiveTitle, archiveTitleSource: 'derived', archiveSummary: null, archiveSummaryStatus: 'not_configured', archiveSummarizedAt: null } : {}) } });
  return { ok: true, sessionId: id, archived: Boolean(archived), metadata };
}

export const __test__ = { safeId, sessionDir, sessionFile, sessionMetaFile, deriveArchiveTitle, summarizeSessionTurns, normalizeTranscriptEntry, isChatMessage, readJsonLines, readTailJsonLines, retainedChatMetadata, classifySession, SESSION_TAIL_READ_MAX_BYTES };

// Durable, per-session recovery continuation. The interruption manifest remains
// the factual record; this separate queue record owns dispatch lifecycle.
function recoveryContinuationFile(rootDir, sessionId) { return path.join(sessionDir(rootDir, sessionId), 'recovery-queue.json'); }
function recoveryContinuationKey(manifest = {}) { return `${String(manifest.runId || 'unknown').slice(0, 200)}:${Number.isSafeInteger(manifest.generation) ? manifest.generation : 'unknown'}`; }
function normalizeRecoveryContinuation(value = {}, manifest = {}) {
  const status = ['pending', 'running', 'completed', 'failed'].includes(value?.status) ? value.status : 'pending';
  return {
    version: 1,
    key: String(value?.key || recoveryContinuationKey(manifest)).slice(0, 260),
    status,
    decision: ['resume', 'reconcile_first', 'needs_user_input'].includes(value?.decision) ? value.decision : 'reconcile_first',
    decisionReason: value?.decisionReason ? String(value.decisionReason).slice(0, 160) : null,
    transcriptMessages: Number.isSafeInteger(value?.transcriptMessages) ? value.transcriptMessages : 0,
    autoResume: Boolean(value?.autoResume),
    queuedAt: String(value?.queuedAt || manifest.interruptedAt || nowIso()).slice(0, 64),
    claimedAt: value?.claimedAt ? String(value.claimedAt).slice(0, 64) : null,
    claimedByRunId: value?.claimedByRunId ? String(value.claimedByRunId).slice(0, 200) : null,
    claimedProcessId: Number.isInteger(value?.claimedProcessId) && value.claimedProcessId > 0 ? value.claimedProcessId : null,
    attempts: Number.isSafeInteger(value?.attempts) && value.attempts >= 0 ? value.attempts : 0,
    completedAt: value?.completedAt ? String(value.completedAt).slice(0, 64) : null,
    result: value?.result ? String(value.result).slice(0, 120) : null,
  };
}
export async function readRecoveryContinuation({ rootDir, sessionId } = {}) {
  try {
    const text = await fs.readFile(recoveryContinuationFile(rootDir, safeId(sessionId)), 'utf8');
    const value = text.trim() ? JSON.parse(text) : null;
    return value && typeof value === 'object' ? value : null;
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function enqueueInterruptedRunContinuation({ rootDir, sessionId, manifest = null, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  return withContinuityLock(rootDir, id, async () => {
    const source = manifest || await readInterruptedRunManifest({ rootDir, sessionId: id });
    if (!source) return null;
    const existing = await readRecoveryContinuation({ rootDir, sessionId: id });
    const assessment = await assessInterruptedRunRecovery({ rootDir, sessionId: id, manifest: source, readChatMessages });
    const continuation = normalizeRecoveryContinuation({ ...(existing || { queuedAt: clock() }), decision: assessment.action, decisionReason: assessment.reason, transcriptMessages: assessment.transcriptMessages, autoResume: assessment.autoResume }, source);
    await atomicWriteJson(recoveryContinuationFile(rootDir, id), continuation);
    return continuation;
  });
}
export async function claimInterruptedRunContinuation({ rootDir, sessionId, recoveryRunId, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  if (!recoveryRunId) throw new Error('recovery_run_id_required');
  return withContinuityLock(rootDir, id, async () => {
    const manifest = await readInterruptedRunManifest({ rootDir, sessionId: id });
    const existing = await readRecoveryContinuation({ rootDir, sessionId: id });
    const abandonedClaim = existing?.status === 'running'
      && Number.isInteger(existing.claimedProcessId)
      && !processIsAlive(existing.claimedProcessId);
    if (!manifest || !existing || !existing.autoResume || (existing.status !== 'pending' && !abandonedClaim)) return { ok: false, manifest, continuation: existing };
    const continuation = normalizeRecoveryContinuation({
      ...existing,
      status: 'running',
      claimedAt: clock(),
      claimedByRunId: recoveryRunId,
      claimedProcessId: process.pid,
      attempts: Number(existing.attempts || 0) + 1,
    }, manifest);
    await atomicWriteJson(recoveryContinuationFile(rootDir, id), continuation);
    return { ok: true, manifest, continuation };
  });
}
export async function completeInterruptedRunContinuation({ rootDir, sessionId, recoveryRunId, ok, result = null, clock = nowIso } = {}) {
  const id = safeId(sessionId);
  return withContinuityLock(rootDir, id, async () => {
    const manifest = await readInterruptedRunManifest({ rootDir, sessionId: id });
    const existing = await readRecoveryContinuation({ rootDir, sessionId: id });
    if (!existing || existing.status !== 'running' || existing.claimedByRunId !== String(recoveryRunId)) return { ok: false, stale: true, continuation: existing || null };
    const continuation = normalizeRecoveryContinuation({ ...existing, status: ok ? 'completed' : 'failed', completedAt: clock(), result: result || (ok ? 'completed' : 'failed') }, manifest || {});
    await atomicWriteJson(recoveryContinuationFile(rootDir, id), continuation);
    if (ok && manifest) await atomicWriteJson(interruptedRunFile(rootDir, id), { ...manifest, status: 'recovered', recoveredAt: continuation.completedAt, recoveredByRunId: String(recoveryRunId) });
    return { ok: true, stale: false, continuation };
  });
}
export async function listPendingRecoveryContinuations({ rootDir, limit = 100 } = {}) {
  let entries = [];
  try { entries = await fs.readdir(path.join(rootDir, 'sessions'), { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const pending = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const sessionId = safeId(entry.name);
    const [manifest, continuation] = await Promise.all([readInterruptedRunManifest({ rootDir, sessionId }), readRecoveryContinuation({ rootDir, sessionId })]);
    const reclaimable = continuation?.status === 'running'
      && Number.isInteger(continuation.claimedProcessId)
      && !processIsAlive(continuation.claimedProcessId);
    if (manifest && continuation?.autoResume && (continuation.status === 'pending' || reclaimable)) pending.push({ sessionId, manifest, continuation });
  }
  return pending.sort((a, b) => String(a.continuation.queuedAt).localeCompare(String(b.continuation.queuedAt))).slice(0, limit);
}

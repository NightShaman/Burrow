import { archivePage, archiveUtcDay } from '../../src/archive-pagination.mjs';
import { localDay, validateTimezone } from '../../src/timezone.mjs';
import { redactText } from '../../src/redaction.mjs';

const PHASES = ['light', 'deep', 'rem'];
const PHASE_SET = new Set(PHASES);
const text = (value) => typeof value === 'string' ? value : '';
const timestamp = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};
// The runner normally records startedAt. Scheduled claims and older retained
// receipts can have only generatedAt; do not group by updatedAt or completion.
export function dreamReceiptCreatedAt(receipt) {
  return timestamp(receipt?.startedAt) || timestamp(receipt?.createdAt) || timestamp(receipt?.generatedAt);
}

// Never forward the receipt graph, owner metadata, request/response diagnostics,
// or model output. Error text is bounded and strips common credential envelopes
// even on older cycle-level errors that predate the runner's safeModelError.
function safeError(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let result = redactText(value)
    .replace(/\b(Basic|Bearer)\s+[^\s"']+/gi, '$1 [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, (item) => `${item.split(/[=:]/, 1)[0]}=[redacted]`)
    .replace(/(?:\b(?:raw|response|body|output|content|completion)(?:[_ -]?(?:body|text))?\s*[=:])\s*[\s\S]*/i, '[response details omitted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted]')
    // A serialized error body may itself be a provider response, not a safe
    // diagnostic. Preserve its prefix, not the raw JSON or markdown output.
    .replace(/\s*[{[]\s*["'{[][^\n]*$/s, ' [details omitted]')
    .replace(/```[\s\S]*/g, '[details omitted]')
    .replace(/\s+/g, ' ').trim();
  if (result.length > 500) result = `${result.slice(0, 499).trimEnd()}…`;
  return result || null;
}

function phaseErrors(phase) {
  const entries = [['extraction', phase?.extractionError], ['diary', phase?.diaryError],
    ['reconciliation', phase?.reconciliationError], ['phase', phase?.error]];
  return Object.fromEntries(entries.map(([key, value]) => [key, safeError(value)]).filter(([, value]) => value));
}
function phaseAttempt(receipt, phase, runningProgress = false) {
  const errors = phaseErrors(phase);
  const diaryId = text(phase?.diaryId) || null;
  let status = 'unknown';
  if (Object.keys(errors).length || phase?.ok === false || phase?.status === 'failed') status = diaryId ? 'partial' : 'failed';
  else if (diaryId || phase?.ok === true || phase?.status === 'completed') status = 'completed';
  else if (runningProgress) status = 'running';
  return {
    runId: text(receipt?.runId), status, error: Object.values(errors)[0] || null, errors,
    // Phase timestamps are shown only when explicitly recorded. Cycle timing is
    // separately labeled so it is never presented as measured phase timing.
    startedAt: timestamp(phase?.startedAt), completedAt: timestamp(phase?.completedAt),
    runStartedAt: dreamReceiptCreatedAt(receipt), runCompletedAt: timestamp(receipt?.completedAt), diaryId,
  };
}
function cycleAttempt(receipt) {
  return { runId: text(receipt?.runId), status: ['running', 'failed', 'partial', 'interrupted'].includes(receipt?.status) ? receipt.status : 'unknown',
    error: safeError(receipt?.error), startedAt: dreamReceiptCreatedAt(receipt), completedAt: timestamp(receipt?.completedAt) };
}
function diaryDocument(entry) {
  return { id: text(entry.id), phase: text(entry.phase), entryDate: text(entry.entryDate) || null,
    createdAt: timestamp(entry.createdAt), markdown: text(entry.narrative) };
}
const sortDiaries = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id);
const sortAttempts = (a, b) => (b.runStartedAt || b.startedAt || '').localeCompare(a.runStartedAt || a.startedAt || '') || b.runId.localeCompare(a.runId);
function diarySummary(diary) {
  return diary ? { id: diary.id, entryDate: diary.entryDate, createdAt: diary.createdAt, excerpt: diary.markdown.slice(0, 320).trim() } : null;
}
function phaseSummary(phase) {
  const latest = phase.attempts[0];
  return { phase: phase.phase, diaryCount: phase.diaries.length, attemptCount: phase.attempts.length,
    latestStatus: latest?.status || null, latestError: latest?.error || null, latestDiary: diarySummary(phase.diaries[0]) };
}
function groupSummary(group) {
  const latest = group.cycleAttempts[0];
  return { agentId: group.agentId, agentName: group.agentName, day: group.day, timezone: group.timezone, createdAt: group.createdAt,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, phaseSummary(group.phases[phase])])),
    otherDiaries: { diaryCount: group.otherDiaries.length, latestDiary: diarySummary(group.otherDiaries[0]) },
    cycleAttempts: { count: group.cycleAttempts.length, latestStatus: latest?.status || null, latestError: latest?.error || null } };
}
function matchesQuery(group, query) {
  if (!query) return true;
  const fields = [group.agentId, group.agentName, group.day];
  for (const phase of Object.values(group.phases)) {
    if (phase.diaries.length || phase.attempts.length) fields.push(phase.phase);
    for (const diary of phase.diaries) fields.push(diary.markdown, diary.id, diary.entryDate);
    for (const attempt of phase.attempts) fields.push(attempt.runId, attempt.status, ...Object.values(attempt.errors));
  }
  for (const diary of group.otherDiaries) fields.push(diary.phase, diary.markdown, diary.id, diary.entryDate);
  for (const attempt of group.cycleAttempts) fields.push(attempt.runId, attempt.status, attempt.error);
  return fields.some((field) => text(field).toLowerCase().includes(query));
}

// A group is the union of real diaries and receipt evidence on a local day.
// Receipt phases contain explicit IDs, but never join by date or phase. In
// particular, retries may fail after an earlier diary was already published.
export function projectDreamGroups({ agents, diariesByAgent, receiptsByAgent, timezone }) {
  const groups = new Map();
  function groupFor(agent, createdAt) {
    const day = localDay(createdAt, timezone);
    if (!day) return null;
    const key = JSON.stringify([agent.id, day]);
    let group = groups.get(key);
    if (!group) {
      group = { agentId: agent.id, agentName: agent.name || agent.id, day, timezone, createdAt,
        phases: Object.fromEntries(PHASES.map((phase) => [phase, { phase, diaries: [], attempts: [] }])), otherDiaries: [], cycleAttempts: [] };
      groups.set(key, group);
    } else if (createdAt > group.createdAt) group.createdAt = createdAt;
    return group;
  }
  for (const agent of agents) {
    for (const entry of diariesByAgent.get(agent.id) || []) {
      const createdAt = timestamp(entry.createdAt); if (!createdAt) continue;
      const group = groupFor(agent, createdAt); const diary = diaryDocument(entry);
      if (PHASE_SET.has(diary.phase)) group.phases[diary.phase].diaries.push(diary);
      else group.otherDiaries.push(diary);
    }
    for (const receipt of receiptsByAgent.get(agent.id) || []) {
      const createdAt = dreamReceiptCreatedAt(receipt); if (!createdAt) continue;
      const group = groupFor(agent, createdAt);
      const results = Array.isArray(receipt.phases) ? receipt.phases.filter((phase) => PHASE_SET.has(phase?.phase)) : [];
      const activePhase = PHASE_SET.has(receipt.progress?.phase) && ['extraction', 'diary', 'synthesis'].includes(receipt.progress?.step) ? receipt.progress.phase : null;
      const runningPhase = receipt.status === 'running' ? activePhase : null;
      const postPhase = ['phase_completed', 'saving_connections', 'preferences', 'saving_diaries', 'finalizing', 'finished'].includes(receipt.progress?.step);
      for (const phase of results) {
        const activeFailure = activePhase === phase.phase && ['failed','interrupted'].includes(receipt.status);
        const attempt = phaseAttempt(receipt, activeFailure ? { ...phase, error: receipt.error } : phase, runningPhase === phase.phase && !postPhase);
        if (activeFailure && receipt.status === 'interrupted') attempt.status = 'interrupted';
        group.phases[phase.phase].attempts.push(attempt);
      }
      if (runningPhase && !results.some((phase) => phase.phase === runningPhase) && !postPhase) {
        group.phases[runningPhase].attempts.push(phaseAttempt(receipt, {}, true));
      }
      // An interrupted or failed run can die before final phase results are
      // written. Explicit current progress identifies that phase; post-phase
      // persistence failures cannot be attributed to the last phase by guess.
      const failedActivePhase = ['failed', 'interrupted'].includes(receipt.status) && activePhase && !postPhase
        && !results.some(phase => phase.phase === activePhase);
      if (failedActivePhase) {
        const attempt = phaseAttempt(receipt, { error: receipt.error });
        attempt.status = receipt.status;
        group.phases[activePhase].attempts.push(attempt);
      }
      const phaseErrorTexts = results.flatMap((phase) => Object.values(phaseErrors(phase)));
      const cycleError = safeError(receipt.error);
      const hasUnattributedFailure = ['failed', 'partial', 'interrupted'].includes(receipt.status)
        && ((cycleError && !phaseErrorTexts.includes(cycleError)) || (!cycleError && !phaseErrorTexts.length));
      if ((hasUnattributedFailure && !activePhase) || (receipt.status === 'running' && (!runningPhase || postPhase))) group.cycleAttempts.push(cycleAttempt(receipt));
    }
  }
  for (const group of groups.values()) {
    for (const phase of Object.values(group.phases)) { phase.diaries.sort(sortDiaries); phase.attempts.sort(sortAttempts); }
    group.otherDiaries.sort(sortDiaries); group.cycleAttempts.sort(sortAttempts);
  }
  return [...groups.values()];
}

export function listDreamGroups(groups, { timezone = 'UTC', agentId = null, date = null, query = '', limit = 200, cursor = null } = {}) {
  timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
  if (date) archiveUtcDay(date);
  query = text(query).trim().toLowerCase();
  const page = archivePage(groups.filter((group) => (!agentId || group.agentId === agentId) && (!date || group.day === date) && matchesQuery(group, query)), {
    limit, cursor, scope: JSON.stringify(['dream-groups', agentId || null, date || null, timezone, query]),
    timestamp: (group) => group.day, identity: (group) => group.agentId,
  });
  return { ok: true, groups: page.items.map(groupSummary), nextCursor: page.nextCursor, hasMore: page.hasMore };
}

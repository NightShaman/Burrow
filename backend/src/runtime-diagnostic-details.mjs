import { promises as fs } from 'node:fs';
import { redactAndTruncateText } from './redaction.mjs';
import { validTraceRunId } from './trace-summary.mjs';
import { runtimeDiagnosticSessionSummary } from './runtime-diagnostic-sessions.mjs';
import { compactDelegationMetadata } from './compact-delegation-metadata.mjs';

// Match the existing mod/Forge diagnostic page convention. Text previews use
// trace-summary's existing 1,000-character default and can be configured per read.
export const DIAGNOSTIC_PAGE_DEFAULT = 50;
export const DIAGNOSTIC_PAGE_MAX = 100;
export const DIAGNOSTIC_PREVIEW_CHARS = 1000;
const invalid = () => { throw Object.assign(new Error('invalid_diagnostics_query'), { statusCode: 400 }); };
export function diagnosticPageLimit(limit = DIAGNOSTIC_PAGE_DEFAULT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIAGNOSTIC_PAGE_MAX) invalid();
  return limit;
}
const text = value => typeof value === 'string' ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
function project(source, shape) {
  return Object.fromEntries(Object.entries(shape).map(([key, clean]) => [key, clean(source?.[key])]));
}

export async function runtimeDiagnosticSessionDetail(conversationStore, { agentId, sessionId, limit, maxContentChars = DIAGNOSTIC_PREVIEW_CHARS } = {}) {
  limit = diagnosticPageLimit(limit);
  if (!Number.isSafeInteger(maxContentChars) || maxContentChars < 1) invalid();
  const metadata = await conversationStore.getMetadata({ agentId, sessionId });
  if (!metadata) return null;
  // One lookahead makes truncation explicit without fetching the full transcript.
  const rows = await conversationStore.projection({ agentId, sessionId, visibility: 'chat', limit: limit + 1 });
  return {
    ...runtimeDiagnosticSessionSummary({ ...metadata, sessionId }),
    turns: rows.slice(-limit).map(turn => {
      const preview = redactAndTruncateText(String(turn.content || ''), { maxChars: maxContentChars });
      const metadata = compactDelegationMetadata(turn.metadata);
      return {
        ...project(turn, { id: text, ts: text, type: text, role: text, runId: text, visibility: text }),
        content: preview.text,
        contentChars: preview.originalChars,
        contentTruncated: turn.contentTruncated === true || preview.truncated,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      };
    }),
    hasMore: rows.length > limit,
    limit,
    maxContentChars,
  };
}

// Never return inspection's messages, support packs, receipts, evidence bodies,
// summaries or provider payloads. Even the status API's runEvidence has arrays.
export function runtimeDiagnosticContextSummary(status = {}) {
  return {
    sessionId: text(status.sessionId),
    context: project(status.context, { estimatedTokens: number, capacityTokens: number, usageRatio: number, percent: number, pressure: text, source: text, provenance: text, lastTurnAt: text, active: boolean, modelCall: number, continuation: boolean, providerInputTokens: number, runId: text }),
    recall: project(status.recall, { requested: boolean, used: boolean, scope: text, sourceCount: number, searchedSessionCount: number }),
    runEvidence: project(status.runEvidence, { candidateCount: number, selectedCount: number, omittedCount: number, chars: number, reason: text }),
    compaction: {
      ...project(status.compaction, { active: boolean, summarizedTurnCount: number, rawRecentTurnCount: number }),
      next: project(status.compaction?.next, { ready: boolean, reason: text, pressure: text, eligibleTurnCount: number, estimatedEligibleTokens: number }),
      last: status.compaction?.last ? project(status.compaction.last, { id: text, createdAt: text, sourceTurnCount: number, firstSummarizedEntryId: text, lastSummarizedEntryId: text, firstKeptEntryId: text, reason: text, pressure: text, rawTailTurnCount: number, eligibleTurnCount: number, estimatedEligibleTokens: number }) : null,
    },
  };
}

export function runtimeDiagnosticActiveRuns({ runs = [], subagents = [] } = {}) {
  const shape = { id: text, runId: text, agentId: text, sessionId: text, parentSessionId: text, parentRunId: text, status: text, phase: text, source: text, startedAt: text, createdAt: text, updatedAt: text, lastActualActivityAt: text, final: boolean, detached: boolean, steeringReady: boolean };
  return {
    runs: runs.map(run => ({ ...project(run, shape), progressCount: Array.isArray(run.progress) ? run.progress.length : 0, steeringCount: Array.isArray(run.steering) ? run.steering.length : 0 })),
    subagents: subagents.map(run => ({ ...project(run, shape), activity: project(run.activity, { kind: text, status: text, phase: text, sequence: number, startedAt: text, completedAt: text, lastActualActivityAt: text, heartbeatAt: text, tool: text, model: text }) })),
  };
}

export async function runtimeDiagnosticTraces({ traceRoot, agentId, sessionId, limit, cursor } = {}) {
  limit = diagnosticPageLimit(limit);
  let after = null;
  if (cursor !== undefined && cursor !== null) {
    try {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) invalid();
      const key = JSON.parse(bytes.toString('utf8'));
      if (key.v !== 1 || key.agentId !== agentId || key.sessionId !== sessionId || !validTraceRunId(key.after)) invalid();
      after = key.after;
    } catch { invalid(); }
  }
  // Retain only a page plus lookahead, not the directory inventory. Ordering is
  // the same descending run-id ordering as the UI list. Not a snapshot cursor.
  const ids = [];
  try {
    const directory = await fs.opendir(traceRoot);
    for await (const entry of directory) {
      if (!entry.isDirectory() || !validTraceRunId(entry.name) || (after !== null && entry.name >= after)) continue;
      const at = ids.findIndex(id => id < entry.name);
      ids.splice(at < 0 ? ids.length : at, 0, entry.name);
      if (ids.length > limit + 1) ids.pop();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const page = ids.slice(0, limit);
  const hasMore = ids.length > limit;
  return {
    traces: page.map(id => ({ id, url: `/api/traces/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}` })),
    hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, agentId, sessionId, after: page.at(-1) })).toString('base64url') : null,
  };
}

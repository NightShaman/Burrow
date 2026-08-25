import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactAndTruncateText, redactText } from './redaction.mjs';
import { readSessionEntries } from './session-store.mjs';

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readPreview(filePath, maxChars = 1000) {
  if (!filePath) return null;
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const envelope = redactAndTruncateText(text, { maxChars });
    return { path: filePath, chars: envelope.originalChars, text: envelope.text, truncated: envelope.truncated };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: filePath, missing: true };
    throw error;
  }
}

function byType(records) {
  const counts = {};
  for (const record of records) {
    const key = record.type || record.payload?.stage || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}


function dataRootFromTraceRoot(traceRoot) {
  const resolved = path.resolve(traceRoot);
  if (path.basename(resolved) === 'traces' && path.basename(path.dirname(resolved)) === 'cache') {
    const runtimeRoot = path.dirname(path.dirname(resolved));
    const deployedDataRoot = path.join(runtimeRoot, 'workspace', 'hatchet');
    return existsSync(deployedDataRoot) ? deployedDataRoot : runtimeRoot;
  }
  return resolved;
}

async function traceBaseRoot(rootDir, runId = null) {
  const resolved = path.resolve(rootDir);
  if (!runId) return resolved;
  try {
    await fs.access(path.join(resolved, runId));
    return resolved;
  } catch {}
  const cacheTraceRoot = path.join(resolved, 'cache', 'traces');
  try {
    await fs.access(path.join(cacheTraceRoot, runId));
    return cacheTraceRoot;
  } catch {}
  return resolved;
}

async function dirMtimeMs(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function latestTraceRun({ rootDir } = {}) {
  if (!rootDir) throw new Error('rootDir is required');

  const tracesDir = await traceBaseRoot(rootDir, null);
  let entries = [];
  try {
    entries = await fs.readdir(tracesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const runs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const traceDir = path.join(tracesDir, entry.name);
      return { runId: entry.name, traceDir, mtimeMs: await dirMtimeMs(traceDir) };
    }));

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.runId.localeCompare(a.runId));
  return runs[0] || null;
}

function stageLabel(record) {
  const payload = record.payload || {};
  if (record.type === 'router') return payload.stage || 'router';
  if (record.type === 'tool') return payload.tool ? `tool:${payload.tool}` : 'tool';
  if (record.type === 'memory') return payload.stage || payload.decision || 'memory';
  if (record.type === 'model') return payload.stage || 'model';
  if (record.type === 'verifier') return payload.stage || 'verifier';
  return record.type || payload.stage || 'event';
}

function cardStatus(record) {
  const payload = record.payload || {};
  if (record.type === 'tool' && payload.phase === 'start') return 'running';
  if (payload.ok === false || payload.error || payload.blocked) return 'failed';
  if (Array.isArray(payload.blockers) && payload.blockers.length) return 'blocked';
  if (Array.isArray(payload.warnings) && payload.warnings.length) return 'warning';
  if (payload.ok === true) return 'ok';
  return 'info';
}

function toolActivityFromTimeline(timeline = []) {
  const byActivityId = new Map();
  for (const card of timeline) {
    if (card.stream !== 'tool') continue;
    const payload = card.payload || {};
    const activityId = payload.activityId || `legacy-${card.index}`;
    const prior = byActivityId.get(activityId);
    byActivityId.set(activityId, {
      id: activityId,
      tool: payload.tool || prior?.tool || null,
      phase: payload.phase || 'result',
      status: card.status,
      startedAt: prior?.startedAt || (payload.phase === 'start' ? card.ts : null),
      finishedAt: payload.phase === 'result' ? card.ts : prior?.finishedAt || null,
      payload: { ...(prior?.payload || {}), ...payload },
    });
  }
  return [...byActivityId.values()].map((item) => ({
    ...item,
    status: item.phase === 'start' ? 'running' : item.status,
  }));
}

function modelActivityFromTimeline(timeline = []) {
  const pending = new Map();
  for (const card of timeline) {
    if (card.stream !== 'model') continue;
    const payload = card.payload || {};
    if (payload.stage === 'model-request' && payload.requestId) pending.set(payload.requestId, card.ts);
    if (payload.stage === 'model-response' && payload.requestId) pending.delete(payload.requestId);
  }
  const [requestId, startedAt] = [...pending.entries()].at(-1) || [];
  return requestId ? { id: requestId, status: 'running', label: 'Waiting for model', startedAt } : null;
}

function compactPayload(record) {
  const payload = record.payload || {};
  const compact = {
    stage: payload.stage || null,
    requestId: payload.requestId || null,
    ok: payload.ok ?? null,
    decision: payload.decision || null,
    routeKind: payload.session?.kind || payload.routeKind || null,
    tool: payload.tool || null,
    activityId: payload.activityId || null,
    phase: payload.phase || null,
    command: payload.command ? redactText(payload.command) : null,
    filePath: payload.filePath || null,
    error: payload.error ? redactText(String(payload.error)) : null,
    blockers: payload.blockers || null,
    warnings: payload.warnings || null,
    proposedActions: payload.proposedActions ?? null,
    answerChars: payload.answerChars ?? null,
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== null && value !== undefined));
}

export function buildTraceTimeline({ events = [], router = [], tools = [], memory = [], model = [], verifier = [] } = {}) {
  const streams = [
    ...router.map((record) => ({ stream: 'router', ...record })),
    ...memory.map((record) => ({ stream: 'memory', ...record })),
    ...model.map((record) => ({ stream: 'model', ...record })),
    ...tools.map((record) => ({ stream: 'tool', ...record })),
    ...verifier.map((record) => ({ stream: 'verifier', ...record })),
    ...events.filter((record) => record.type !== 'router' && record.type !== 'tool' && record.type !== 'memory' && record.type !== 'model' && record.type !== 'verifier').map((record) => ({ stream: record.stream || 'event', ...record })),
  ];
  return streams
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .map((record, index) => ({
      index,
      ts: record.ts || null,
      stream: record.stream || 'event',
      type: record.type || 'event',
      stage: stageLabel(record),
      status: cardStatus(record),
      summary: stageLabel(record),
      payload: compactPayload(record),
    }));
}

function latestTraceSessionId({ events = [], router = [], tools = [], memory = [], model = [], verifier = [] } = {}) {
  const aggregate = [...events].reverse().find((record) => record.sessionId);
  if (aggregate) return aggregate.sessionId;
  return [...router, ...tools, ...memory, ...model, ...verifier]
    .filter((record) => record.sessionId)
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))[0]?.sessionId || null;
}

function compactAuthorityEvidence(evidence = null) {
  if (!evidence) return null;
  return {
    interpretation: evidence.interpretation || null,
    blocked: Boolean(evidence.blocked),
    blockerKind: evidence.blockerKind || null,
    blockers: Array.isArray(evidence.blockers) ? evidence.blockers : [],
    executionPolicy: evidence.executionPolicy || {},
    toolActivity: evidence.toolActivity || {},
    explanation: evidence.explanation || null,
  };
}

function receiptAuthorityEvidence(entry = {}) {
  if (entry.metadata?.authorityEvidence && typeof entry.metadata.authorityEvidence === 'object') return entry.metadata.authorityEvidence;
  try {
    return JSON.parse(entry.content || '{}')?.authorityEvidence || null;
  } catch {
    return null;
  }
}

function latestAuthorityFromEntries(entries = [], runId = null) {
  return receiptAuthorityEvidence(entries
    .filter((entry) => entry.type === 'receipt' && entry.runId === runId && receiptAuthorityEvidence(entry))
    .at(-1) || {});
}

async function latestReceiptAuthorityEvidence({ rootDir, runId, sessionId }) {
  if (!rootDir || !runId) return null;
  if (sessionId) {
    const evidence = latestAuthorityFromEntries(await readSessionEntries({ rootDir: dataRootFromTraceRoot(rootDir), sessionId, limit: 0, includeHistory: true }), runId);
    if (evidence) return compactAuthorityEvidence(evidence);
  }
  let sessionDirs = [];
  try {
    sessionDirs = await fs.readdir(path.join(dataRootFromTraceRoot(rootDir), 'sessions'), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const entry of sessionDirs.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const evidence = latestAuthorityFromEntries(await readSessionEntries({ rootDir: dataRootFromTraceRoot(rootDir), sessionId: entry.name, limit: 0, includeHistory: true }), runId);
    if (evidence) return compactAuthorityEvidence(evidence);
  }
  return null;
}

async function linkedWorkItems({ rootDir, runId, sessionId }) {
  const dataRoot = dataRootFromTraceRoot(rootDir);
  const candidateDirs = [path.join(dataRoot, 'sessions', '_work-items'), path.join(dataRoot, 'work-items')];
  let workItemsDir = candidateDirs[0];
  let entries = [];
  for (const candidate of candidateDirs) {
    try {
      entries = await fs.readdir(candidate, { withFileTypes: true });
      workItemsDir = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!entries.length) return [];
  const linked = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    let item = null;
    try {
      item = JSON.parse(await fs.readFile(path.join(workItemsDir, entry.name, 'work-item.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    const matchingSteps = (item.steps || []).filter((step) => {
      if (runId && step.runId === runId) return true;
      if (runId && typeof step.traceDir === 'string' && (step.traceDir.endsWith(`/traces/${runId}`) || step.traceDir.endsWith(`/${runId}`))) return true;
      return false;
    });
    const sessionMatch = sessionId && item.sessionId === sessionId;
    if (!sessionMatch && matchingSteps.length === 0) continue;
    linked.push({
      id: item.id || entry.name,
      title: item.title || null,
      status: item.status || null,
      sessionId: item.sessionId || null,
      workspaceRoot: item.workspaceRoot || null,
      matchingSteps: matchingSteps.map((step) => ({ step: step.step || null, runId: step.runId || null, traceDir: step.traceDir || null, decision: step.decision || null, ok: step.ok ?? null })),
    });
  }
  return linked.sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 20);
}

function authorityEntryFromReceipt(entry = {}, { sessionId = null } = {}) {
  const evidence = receiptAuthorityEvidence(entry);
  if (!evidence) return null;
  const authority = authorityExplanationFromTraceSummary({ authorityEvidence: compactAuthorityEvidence(evidence) });
  return {
    sessionId: sessionId || entry.sessionId || null,
    runId: entry.runId || null,
    ts: entry.ts || null,
    interpretation: authority.interpretation,
    blocked: authority.blocked,
    blockerKind: authority.blockerKind,
    blockers: authority.blockers,
    explanation: authority.explanation,
    authority,
  };
}

export async function listAuthorityExplanationsForSession({ rootDir, sessionId, limit = 20 } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!sessionId) throw new Error('sessionId is required');
  const entries = await readSessionEntries({ rootDir, sessionId, limit: 0, includeHistory: true });
  const items = entries
    .filter((entry) => entry.type === 'receipt' && receiptAuthorityEvidence(entry))
    .map((entry) => authorityEntryFromReceipt(entry, { sessionId }))
    .filter(Boolean)
    .reverse();
  const resolvedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  return {
    sessionId,
    items: items.slice(0, resolvedLimit),
  };
}

export async function latestAuthorityExplanationForSession({ rootDir, sessionId } = {}) {
  const listed = await listAuthorityExplanationsForSession({ rootDir, sessionId, limit: 1 });
  const latest = listed.items[0] || null;
  const authority = latest?.authority || authorityExplanationFromTraceSummary({});
  return {
    available: authority.available,
    sessionId,
    runId: latest?.runId || null,
    ts: latest?.ts || null,
    authority,
  };
}

export function authorityExplanationFromTraceSummary(traceSummary = {}) {
  const evidence = traceSummary?.authorityEvidence || null;
  if (!evidence) {
    return {
      available: false,
      interpretation: 'missing',
      blocked: null,
      blockerKind: null,
      blockers: [],
      explanation: 'No receipt authority evidence available.',
    };
  }
  return {
    available: true,
    interpretation: evidence.interpretation || null,
    blocked: Boolean(evidence.blocked),
    blockerKind: evidence.blockerKind || null,
    blockers: Array.isArray(evidence.blockers) ? evidence.blockers : [],
    executionPolicy: evidence.executionPolicy || {},
    toolActivity: evidence.toolActivity || {},
    explanation: evidence.explanation || 'Receipt authority evidence is present without a textual explanation.',
  };
}

export async function summarizeTrace({ rootDir, runId, includeToolOutput = false, maxOutputChars = 1000, includeRelatedWorkTrace = true } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!runId) throw new Error('runId is required');

  const traceRoot = await traceBaseRoot(rootDir, runId);
  const traceDir = path.join(traceRoot, runId);
  const [events, router, tools, memory, model, verifier] = await Promise.all([
    readJsonl(path.join(traceDir, 'events.jsonl')),
    readJsonl(path.join(traceDir, 'router.jsonl')),
    readJsonl(path.join(traceDir, 'tool-calls.jsonl')),
    readJsonl(path.join(traceDir, 'memory.jsonl')),
    readJsonl(path.join(traceDir, 'model.jsonl')),
    readJsonl(path.join(traceDir, 'verifier.jsonl')),
  ]);

  let artifactCount = 0;
  try {
    artifactCount = (await fs.readdir(path.join(traceDir, 'artifacts'))).length;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const toolFailures = tools.filter((record) => record.payload?.ok === false);
  const latestRouter = router.at(-1)?.payload || null;
  const traceSessionId = latestTraceSessionId({ events, router, tools, memory, model, verifier });
  const latestSessionRouter = [...router].reverse().find((record) => record.payload?.session || record.payload?.priorSession)?.payload || null;
  const sessionSummary = latestSessionRouter ? {
    session: latestSessionRouter.session || null,
    sessionId: latestSessionRouter.sessionId || latestSessionRouter.priorSession?.sessionId || traceSessionId,
    priorSession: latestSessionRouter.priorSession || null,
    answerChars: latestSessionRouter.answerChars ?? null,
    proposedActions: latestSessionRouter.proposedActions ?? null,
  } : (traceSessionId ? { session: null, sessionId: traceSessionId, priorSession: null, answerChars: null, proposedActions: null } : null);
  const toolOutput = includeToolOutput
    ? await Promise.all(tools.map(async (record) => {
        const artifacts = record.payload?.artifacts || {};
        return {
          tool: record.payload?.tool || null,
          ok: record.payload?.ok ?? null,
          command: record.payload?.command ? redactText(record.payload.command) : null,
          filePath: record.payload?.filePath || null,
          stdout: await readPreview(artifacts.stdoutPath, maxOutputChars),
          stderr: await readPreview(artifacts.stderrPath, maxOutputChars),
          result: await readPreview(artifacts.resultPath, maxOutputChars),
        };
      }))
    : undefined;

  const timeline = buildTraceTimeline({ events, router, tools, memory, model, verifier });
  const toolActivity = toolActivityFromTimeline(timeline);
  const modelActivity = modelActivityFromTimeline(timeline);
  const liveActivity = toolActivity.some((item) => item.status === 'running')
    ? { kind: 'tools', items: toolActivity.filter((item) => item.status === 'running') }
    : modelActivity ? { kind: 'model', items: [modelActivity] } : { kind: 'idle', items: [] };
  const resolvedSessionId = traceSessionId || sessionSummary?.sessionId || null;
  const [workItems, authorityEvidence] = await Promise.all([
    linkedWorkItems({ rootDir: traceRoot, runId, sessionId: resolvedSessionId }),
    latestReceiptAuthorityEvidence({ rootDir: traceRoot, runId, sessionId: resolvedSessionId }),
  ]);

  let relatedWorkTrace = null;
  if (includeRelatedWorkTrace && !runId.endsWith('-work')) {
    const relatedRunId = `${runId}-work`;
    const related = await summarizeTrace({
      rootDir: traceRoot,
      runId: relatedRunId,
      includeToolOutput,
      maxOutputChars,
      includeRelatedWorkTrace: false,
    });
    if (related.exists) relatedWorkTrace = related;
  }

  return {
    runId,
    traceDir,
    exists: events.length > 0 || router.length > 0 || tools.length > 0 || artifactCount > 0,
    counts: {
      events: events.length,
      router: router.length,
      tools: tools.length,
      memory: memory.length,
      model: model.length,
      verifier: verifier.length,
      artifacts: artifactCount,
    },
    eventTypes: byType(events),
    timeline,
    cards: timeline,
    toolActivity,
    modelActivity,
    liveActivity,
    routerStages: router.map((record) => record.payload?.stage || record.type || 'unknown'),
    toolFailures: toolFailures.map((record) => ({
      tool: record.payload?.tool,
      error: record.payload?.error,
      command: record.payload?.command ? redactText(record.payload.command) : undefined,
      filePath: record.payload?.filePath,
    })),
    latestRouter,
    authorityEvidence,
    sessionId: resolvedSessionId,
    session: sessionSummary,
    workItems,
    ...(includeToolOutput ? { toolOutput } : {}),
    ...(relatedWorkTrace ? { relatedWorkTrace } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const runId = process.argv[3];
  const summary = await summarizeTrace({ rootDir, runId });
  console.log(JSON.stringify(summary, null, 2));
}

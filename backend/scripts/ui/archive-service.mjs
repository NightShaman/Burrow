import { createHmac } from 'node:crypto';
import { archiveRunListPage } from './archive-run-list.mjs';
import { readArchiveRun } from '../../src/archive-proof.mjs';
import { archivePage, archiveUtcDay, archiveUtcMonth, archiveCalendarDates, matchesArchiveDay, archiveCursorBoundary, archiveCursor } from '../../src/archive-pagination.mjs';
import { validateTimezone } from '../../src/timezone.mjs';
import { listTiddleCards, tiddleHistory } from '../../src/tiddle-continuity.mjs';

// Read-only Archive projections own collection scope, pagination and snapshot
// cursors. Store access is composed by the server, never opened by this service.
export function createArchiveService({ stores, agentsStore, dreamDiaryStore,
  resolveAgentRuntime, runtimeConfig, runtimeTraceRoot, settingsKeyFromEnvironment,
  isChatMessage, compactChatTurn, summarizeSessionTurns, boundedInteger } = {}) {
  function archiveSessionListItem(record = {}, agentRuntime = {}, agent = {}) {
    const metadata = record.metadata || {};
    const sessionId = record.id || metadata.sessionId || metadata.sessionKey || 'default';
    return {
      agentId: agentRuntime.agentId || agent.id || null,
      agentName: agent.name || agentRuntime.agentName || agentRuntime.agentId || agent.id || null,
      sessionId,
      id: sessionId,
      title: record.archiveTitle || metadata.archiveTitle || metadata.title || metadata.name || sessionId,
      titleSource: record.archiveTitle || metadata.archiveTitle ? 'derived' : 'legacy',
      summary: record.archiveSummary || metadata.archiveSummary || null,
      summaryStatus: record.summaryStatus || metadata.archiveSummaryStatus || 'not_configured',
      summarizedAt: record.summarizedAt || metadata.archiveSummarizedAt || null,
      turnCount: record.turnCount ?? metadata.turnCount ?? 0,
      chatTurnCount: metadata.chatTurnCount ?? null,
      createdAt: metadata.createdAt || null,
      updatedAt: record.updatedAt || metadata.updatedAt || metadata.lastInteractionAt || null,
      archived: Boolean(record.archiveSnapshot || record.archived || metadata.archived),
      archivedAt: metadata.archivedAt || null,
      kind: metadata.kind || null,
      lastRole: metadata.lastRole || null,
      lastRunId: metadata.lastRunId || null,
      ...(record.archiveSnapshot ? { archiveSnapshot: record.archiveSnapshot, sourceSessionId: record.sourceSessionId } : {}),
    };
  }

  async function archiveDreamRows({ agentId = null, phase = null } = {}) {
    const agents = (await agentsStore().list({ includeDisabled: true })).filter((agent) => !agentId || agent.id === String(agentId));
    const store = dreamDiaryStore();
    try {
      return (await Promise.all(agents.map(async (agent) => {
        const listed = await store.list(agent.id, { phase, limit: null });
        return listed.map((entry) => ({ id: entry.id, kind: 'dream', agentId: agent.id, agentName: agent.name, entryDate: entry.entryDate, phase: entry.phase, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, excerpt: String(entry.narrative || '').slice(0, 320).trim(), createdAt: entry.createdAt }));
      }))).flat();
    } finally { await store.close(); }
  }

  async function archiveDreams({ timezone = 'UTC', agentId = null, date = null, phase = null, limit = 200, cursor = null } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    const entries = await archiveDreamRows({ agentId, phase });
    const page = archivePage(entries.filter((entry) => matchesArchiveDay(entry.createdAt, date, timezone)), { limit, cursor, scope: JSON.stringify(['dreams', agentId, date, phase, timezone]), timestamp: (row) => row.createdAt, identity: (row) => `${row.agentId}:${row.id}` });
    return { ok: true, entries: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveDreamDetail(agentId, entryId) {
    const store = dreamDiaryStore();
    try {
      const entry = await store.get(agentId, entryId);
      const agent = await agentsStore().get(agentId);
      return { ok: true, document: { id: entry.id, kind: 'dream', agentId, agentName: agent?.name || agentId, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, subtitle: entry.entryDate, phase: entry.phase, markdown: entry.narrative, createdAt: entry.createdAt } };
    } catch (error) { return { ok: false, status: String(error?.message || error) === 'dream_diary_entry_not_found' ? 404 : 400, error: String(error?.message || error) }; } finally { await store.close(); }
  }

  async function archiveContinuityCards({ agentId = null, scope = null, limit = 200, cursor = null } = {}) {
    const agents = (await agentsStore().list({ includeDisabled: true })).filter((agent) => !agentId || agent.id === String(agentId));
    const cards = (await Promise.all(agents.map(async (agent) => (await listTiddleCards({ agentId: agent.id, scope, limit: null, stores: stores(), })).cards.map((card) => ({ ...card, kind: 'continuity', agentId: agent.id, agentName: agent.name }))))).flat();
    const page = archivePage(cards, { limit, cursor, scope: JSON.stringify(['cards', agentId, scope]), timestamp: (row) => row.lastSeen, identity: (row) => `${row.agentId}:${row.id}` });
    return { ok: true, scope: scope || null, cards: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveContinuityCardDetail({ agentId, cardId, limit = 200, cursor = null } = {}) {
    const agent = await agentsStore().get(agentId);
    if (!agent) return { ok: false, status: 404, error: 'agent_not_found' };
    const cards = (await listTiddleCards({ agentId, limit: null, stores: stores(), })).cards;
    const card = cards.find((candidate) => candidate.id === cardId);
    if (!card) return { ok: false, status: 404, error: 'archive_continuity_card_not_found' };
    const history = (await tiddleHistory({ agentId, cardId, limit: null, stores: stores(), })).entries;
    const page = archivePage(history, { limit, cursor, scope: JSON.stringify(['history', agentId, cardId]), timestamp: (row) => row.at, identity: (row) => row.id });
    return { ok: true, card: { ...card, kind: 'continuity', agentId, agentName: agent.name }, history: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveRuns({ agentRuntime = null, sessionId = null, limit = 100, cursor = null } = {}) {
    const agents = agentRuntime ? [agentRuntime] : await Promise.all((await agentsStore().list({ includeDisabled: false })).map((agent) => resolveAgentRuntime(agent.id)));
    const scopes = await Promise.all(agents.map(async runtime => {
      const agent = await agentsStore().resolve(runtime.agentId) || { name: runtime.agentId };
      const config = await runtimeConfig(runtime.agentId);
      return {
        conversationStore: stores().conversations,
        rootDir: runtime.agentWorkspaceRoot,
        dataRoot: runtime.agentDataRoot,
        resolveTraceRoot: actualSessionId => runtimeTraceRoot(config, actualSessionId, runtime.agentId),
        agentId: runtime.agentId,
        agentName: agent.name,
      };
    }));
    return archiveRunListPage({ scopes, agentId: agentRuntime?.agentId ?? null, sessionId, limit, cursor });
  }


  async function archiveRunDetailForAgent({ agentRuntime, runId } = {}) {
    const agent = await agentsStore().resolve(agentRuntime.agentId) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
    const runtime = await runtimeConfig(agentRuntime.agentId);
    return readArchiveRun({
      conversationStore: stores().conversations,
      rootDir: agentRuntime.agentWorkspaceRoot,
      dataRoot: agentRuntime.agentDataRoot,
      resolveTraceRoot: (actualSessionId) => runtimeTraceRoot(runtime, actualSessionId, agentRuntime.agentId),
      agentId: agentRuntime.agentId,
      agentName: agent.name,
      runId,
    });
  }

  async function archiveRunDetail({ agentRuntime = null, runId } = {}) {
    if (agentRuntime) return archiveRunDetailForAgent({ agentRuntime, runId });
    for (const agent of await agentsStore().list({ includeDisabled: false })) {
      const run = await archiveRunDetailForAgent({ agentRuntime: await resolveAgentRuntime(agent.id), runId });
      if (run) return run;
    }
    return null;
  }

  async function archiveSessionRows({ includeArchived = true, agentId = null, includeDisabled = false } = {}) {
    const agents = (await agentsStore().list({ includeDisabled: Boolean(includeDisabled) })).filter((agent) => !agentId || agent.id === agentId);
    const store = stores().conversations;
    return (await Promise.all(agents.map(async (agent) => {
      const [sessions, archives] = await Promise.all([store.listSessions({ agentId: agent.id, includeArchived }), store.listArchives({ agentId: agent.id, limit: null })]);
      return [
        ...sessions.map((record) => archiveSessionListItem({ id: record.sessionId, ...record, metadata: record }, { agentId: agent.id }, agent)),
        ...archives.filter((record) => record.kind === 'reset').map((record) => archiveSessionListItem({ id: record.archiveId, archiveSnapshot: 'reset', sourceSessionId: record.sessionId, turnCount: record.entries.length, updatedAt: record.createdAt, archiveSummary: record.metadata?.summary, summaryStatus: record.metadata?.summaryStatus, metadata: { ...record.metadata, createdAt: record.createdAt } }, { agentId: agent.id }, agent)),
      ];
    }))).flat();
  }

  async function archiveCalendar({ timezone = 'UTC', kind, month, agentId = null } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    const parsedMonth = archiveUtcMonth(month);
    if (!['sessions', 'dreams'].includes(kind)) throw new Error('archive_kind_invalid');
    if (kind === 'sessions' && typeof stores().conversations.listArchiveCalendarDates === 'function') {
      const agents = (await agentsStore().list({ includeDisabled: false })).filter((agent) => !agentId || agent.id === agentId);
      const dates = [...new Set((await Promise.all(agents.map((agent) => stores().conversations.listArchiveCalendarDates({ agentId: agent.id, month: parsedMonth, timezone })))).flat())].sort();
      return { ok: true, kind, month: parsedMonth, dates };
    }
    if (kind === 'dreams') {
      const agents = (await agentsStore().list({ includeDisabled: true })).filter((agent) => !agentId || agent.id === agentId);
      const store = dreamDiaryStore();
      try {
        if (typeof store.listCalendarDates === 'function') {
          const dates = [...new Set((await Promise.all(agents.map((agent) => store.listCalendarDates(agent.id, { month: parsedMonth, timezone })))).flat())].sort();
          return { ok: true, kind, month: parsedMonth, dates };
        }
        const rows = (await Promise.all(agents.map(async (agent) => (await store.list(agent.id, { limit: null })).map((entry) => ({ createdAt: entry.createdAt }))))).flat();
        return { ok: true, kind, month: parsedMonth, dates: archiveCalendarDates(rows, parsedMonth, (row) => row.createdAt, timezone) };
      } finally { await store.close(); }
    }
    const rows = await archiveSessionRows({ agentId });
    const dates = archiveCalendarDates(rows, parsedMonth, (row) => kind === 'dreams' ? row.createdAt : row.archivedAt || row.updatedAt || row.createdAt, timezone);
    return { ok: true, kind, month: parsedMonth, dates };
  }

  async function archiveSessions({ timezone = 'UTC', includeArchived = true, query = '', agentId = null, date = null, limit = 200, includeDisabled = false, cursor = null } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    const store = stores().conversations;
    if (typeof store.listArchiveSessions === 'function') {
      const size = Math.max(1, Math.min(1000, Number(limit) || 200));
      const scope = JSON.stringify(['sessions', includeArchived, query, includeDisabled, agentId, date, timezone]);
      const boundary = archiveCursorBoundary(cursor, { scope });
      const agents = (await agentsStore().list({ includeDisabled: Boolean(includeDisabled) })).filter((agent) => !agentId || agent.id === agentId);
      const pages = await Promise.all(agents.map(async (agent) => ({ agent, page: await store.listArchiveSessions({ agentId: agent.id, includeArchived, query, date, timezone, limit: size, boundary }) })));
      const rows = pages.flatMap(({ agent, page }) => page.rows.map((record) => archiveSessionListItem({
        id: record.id, archiveSnapshot: record.archiveSnapshot, sourceSessionId: record.sourceSessionId,
        turnCount: record.turnCount, updatedAt: record.updatedAt,
        archiveSummary: record.metadata?.archiveSummary || record.metadata?.summary,
        summaryStatus: record.metadata?.archiveSummaryStatus || record.metadata?.summaryStatus,
        metadata: { ...record.metadata, createdAt: record.createdAt, updatedAt: record.updatedAt },
      }, { agentId: agent.id }, agent)));
      rows.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || `${right.agentId}:${right.id}`.localeCompare(`${left.agentId}:${left.id}`));
      const sessions = rows.slice(0, size);
      const hasMore = rows.length > size || pages.some(({ page }) => page.hasMore);
      const last = sessions.at(-1);
      return { sessions, nextCursor: hasMore && last ? archiveCursor({ scope, timestamp: String(last.updatedAt || ''), identity: `${last.agentId}:${last.id}` }) : null, hasMore };
    }
    const rows = await archiveSessionRows({ includeArchived, agentId, includeDisabled });
    const page = archivePage(rows.filter((item) => (matchesArchiveDay(item.archivedAt || item.updatedAt || item.createdAt, date, timezone)) && (!query || JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))), { limit, cursor, max: 1000, scope: JSON.stringify(['sessions', includeArchived, query, includeDisabled, agentId, date, timezone]), timestamp: (row) => row.updatedAt, identity: (row) => `${row.agentId}:${row.id}` });
    return { sessions: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // UI cursors bind to both authority scope and the exact PostgreSQL snapshot.
  function uiArchivePage(source, { agentId, sessionId, limit, before, from, to }) {
    const turns = source.filter(isChatMessage).filter((turn) => (!from || String(turn.ts || '') >= from) && (!to || String(turn.ts || '') <= to));
    const scope = `${agentId}:${sessionId}`;
    const digest = createHmac('sha256', settingsKeyFromEnvironment()).update(JSON.stringify({ scope, from, to, turns })).digest('hex');
    let end = turns.length;
    if (before) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch { throw new Error('archive_cursor_invalid'); }
      if (cursor.scope !== scope || cursor.digest !== digest || !Number.isSafeInteger(cursor.end) || cursor.end < 0 || cursor.end > turns.length) throw new Error('archive_cursor_invalid');
      end = cursor.end;
    }
    const start = Math.max(0, end - boundedInteger(limit, { fallback: 100, max: 500 }));
    return { turns: turns.slice(start, end), hasMore: start > 0, nextCursor: start > 0 ? Buffer.from(JSON.stringify({ scope, digest, end: start })).toString('base64url') : null, historyStatus: 'complete' };
  }

  async function archiveSessionDetail(agentId, sessionId, pageOptions = {}) {
    const agentRuntime = await resolveAgentRuntime(agentId);
    const agent = await agentsStore().resolve(agentRuntime.agentId) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
    const store = stores().conversations;
    const archive = typeof store.readArchiveById === 'function'
      ? await store.readArchiveById({ agentId: agentRuntime.agentId, archiveId: sessionId, kind: 'reset' })
      : (await store.listArchives({ agentId: agentRuntime.agentId, limit: null })).find((item) => item.kind === 'reset' && item.archiveId === sessionId);
    const resetSnapshot = archive ? { id: archive.archiveId, sourceSessionId: archive.sessionId, turnCount: archive.entries.length, createdAt: archive.createdAt, updatedAt: archive.createdAt, archiveSummary: archive.metadata?.summary, summaryStatus: archive.metadata?.summaryStatus, archiveTitle: archive.metadata?.archiveTitle } : null;
    const source = archive ? archive.entries : (await store.exportTranscript({ agentId: agentRuntime.agentId, sessionId }))?.entries;
    if (!source) return null;
    const page = uiArchivePage(source, { agentId: agentRuntime.agentId, sessionId, ...pageOptions });
    if (resetSnapshot) {
      const chatTurns = page.turns.map(compactChatTurn);
      return {
        agentId: agentRuntime.agentId,
        agentName: agent.name || agentRuntime.agentId,
        sessionId: resetSnapshot.id,
        session: {
          id: resetSnapshot.id,
          sessionId: resetSnapshot.id,
          agentId: agentRuntime.agentId,
          agentName: agent.name || agentRuntime.agentId,
          archiveSnapshot: 'reset',
          sourceSessionId: resetSnapshot.sourceSessionId,
          turnCount: resetSnapshot.turnCount,
          metadata: { archived: true, archiveSnapshot: 'reset', sourceSessionId: resetSnapshot.sourceSessionId, createdAt: resetSnapshot.createdAt, updatedAt: resetSnapshot.updatedAt },
          summary: resetSnapshot.archiveSummary || null,
          summaryStatus: resetSnapshot.summaryStatus || 'not_configured',
          title: resetSnapshot.archiveTitle || `Conversation from ${resetSnapshot.sourceSessionId}`,
          turns: chatTurns,
          activities: [],
        },
        hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus,
      };
    }
    const metadata = await stores().conversations.getMetadata({agentId:agentRuntime.agentId,sessionId});
    if (!metadata || !page) return null;
    const session = { id: sessionId, turnCount: metadata.turnCount ?? page.turns.length, metadata, summary: metadata.summary || summarizeSessionTurns(page.turns, { maxChars: 2000 }), turns: page.turns.map(compactChatTurn), activities: [] };
    return {
      hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus,
      agentId: agentRuntime.agentId,
      agentName: agent.name || agentRuntime.agentId,
      sessionId: session.id,
      session: {
        ...session,
        agentId: agentRuntime.agentId,
        agentName: agent.name || agentRuntime.agentId,
        sessionId: session.id,
      },
    };
  }

  return { archiveSessions, archiveCalendar, archiveSessionDetail, archiveRuns, archiveRunDetail, archiveDreams, archiveDreamDetail, archiveContinuityCards, archiveContinuityCardDetail };
}

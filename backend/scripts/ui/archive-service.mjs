import { createHmac } from 'node:crypto';
import { archiveReadCheckpoint, archiveReadTasks } from '../../src/archive-read-scope.mjs';
import { archiveRunListPage } from './archive-run-list.mjs';
import { readArchiveRun } from '../../src/archive-proof.mjs';
import { archivePage, archiveUtcDay, archiveUtcMonth, archiveCalendarDates, matchesArchiveDay, archiveCursorBoundary, archiveCursor } from '../../src/archive-pagination.mjs';
import { redactValue } from '../../src/redaction.mjs';
import { validateTimezone } from '../../src/timezone.mjs';
import { listTiddleCards, tiddleHistory } from '../../src/tiddle-continuity.mjs';
import { dreamReceiptCreatedAt, listDreamGroups, projectDreamGroups } from './archive-dream-groups.mjs';

// Read-only Archive projections own collection scope, pagination and snapshot
// cursors. Store access is composed by the server, never opened by this service.
export function createArchiveService({ stores, agentsStore: registryFactory, dreamDiaryStore,
  resolveAgentRuntime, runtimeConfig, runtimeTraceRoot, settingsKeyFromEnvironment,
  isChatMessage, compactChatTurn, summarizeSessionTurns, boundedInteger } = {}) {
  // Native registry reads must not enter bootstrap's durable row lock, even
  // when the service is composed directly (tests/mods), rather than by the UI.
  const agentsStore = () => {
    const registry = registryFactory();
    if (typeof registry.listArchiveAgents !== 'function') return registry;
    return { list: options => registry.listArchiveAgents(options),
      get: (id, options) => registry.resolveArchiveAgent(id, options),
      resolve: (id, options) => registry.resolveArchiveAgent(id, options) };
  };
  function archiveSessionListItem(record = {}, agentRuntime = {}, agent = {}) {
    const metadata = record.metadata || {};
    const sessionId = record.id || metadata.sessionId || metadata.sessionKey || 'default';
    const reset = record.archiveSnapshot === 'reset';
    return {
      agentId: agentRuntime.agentId || agent.id || null,
      agentName: agent.name || agentRuntime.agentName || agentRuntime.agentId || agent.id || null,
      sessionId,
      id: sessionId,
      title: record.archiveTitle || metadata.archiveTitle || metadata.title || metadata.name || (reset && record.sourceSessionId ? `Conversation from ${record.sourceSessionId}` : sessionId),
      titleSource: record.archiveTitle || metadata.archiveTitle ? 'derived' : 'legacy',
      summary: record.archiveSummary || metadata.archiveSummary || null,
      summaryStatus: record.summaryStatus || metadata.archiveSummaryStatus || 'not_configured',
      summarizedAt: record.summarizedAt || metadata.archiveSummarizedAt || null,
      turnCount: record.turnCount ?? metadata.turnCount ?? 0,
      chatTurnCount: reset ? null : metadata.chatTurnCount ?? null,
      createdAt: metadata.createdAt || null,
      updatedAt: record.updatedAt || metadata.updatedAt || metadata.lastInteractionAt || null,
      archived: Boolean(record.archiveSnapshot || record.archived || metadata.archived),
      archivedAt: reset ? record.updatedAt || metadata.createdAt || null : metadata.archivedAt || null,
      kind: metadata.kind || null,
      lastRole: metadata.lastRole || null,
      lastRunId: metadata.lastRunId || null,
      ...(record.matchedDate ? { matchedDate: record.matchedDate } : {}),
      ...(record.archiveSnapshot ? { archiveSnapshot: record.archiveSnapshot, sourceSessionId: record.sourceSessionId } : {}),
    };
  }

  async function archiveDreamRows({ agentId = null, phase = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agents = (await agentsStore().list({ includeDisabled: true, ...options })).filter((agent) => !agentId || agent.id === String(agentId));
    archiveReadCheckpoint(options);
    const store = dreamDiaryStore();
    try {
      return (await archiveReadTasks(agents.map((agent) => async readOptions => {
        const listed = await store.list(agent.id, { phase, limit: null, ...readOptions });
        return listed.map((entry) => ({ id: entry.id, kind: 'dream', agentId: agent.id, agentName: agent.name, entryDate: entry.entryDate, phase: entry.phase, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, excerpt: String(entry.narrative || '').slice(0, 320).trim(), createdAt: entry.createdAt }));
      }), options)).flat();
    } finally { await store.close(); }
  }

  async function archiveDreams({ timezone = 'UTC', agentId = null, date = null, phase = null, limit = 200, cursor = null, signal, deadline } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    const options = { signal, deadline };
    const entries = await archiveDreamRows({ agentId, phase, ...options });
    archiveReadCheckpoint(options);
    const page = archivePage(entries.filter((entry) => matchesArchiveDay(entry.createdAt, date, timezone)), { limit, cursor, scope: JSON.stringify(['dreams', agentId, date, phase, timezone]), timestamp: (row) => row.createdAt, identity: (row) => `${row.agentId}:${row.id}` });
    return { ok: true, entries: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveDreamDetail(agentId, entryId, options = {}) {
    archiveReadCheckpoint(options);
    const store = dreamDiaryStore();
    try {
      const entry = await store.get(agentId, entryId, options);
      archiveReadCheckpoint(options);
      const agent = await agentsStore().get(agentId, options);
      archiveReadCheckpoint(options);
      return { ok: true, document: { id: entry.id, kind: 'dream', agentId, agentName: agent?.name || agentId, title: `${entry.phase.toUpperCase()} dream · ${entry.entryDate}`, subtitle: entry.entryDate, phase: entry.phase, markdown: entry.narrative, createdAt: entry.createdAt } };
    } catch (error) {
      archiveReadCheckpoint(options);
      if (error?.message === 'archive_query_timeout') throw error;
      return { ok: false, status: String(error?.message || error) === 'dream_diary_entry_not_found' ? 404 : 400, error: String(error?.message || error) };
    } finally { await store.close(); }
  }

  async function archiveDreamReceiptRows(agents, options = {}) {
    archiveReadCheckpoint(options);
    const cycleStore = stores()?.dreamCycles;
    if (!cycleStore) return new Map(agents.map((agent) => [agent.id, []]));
    // Never silently fall back to Settings' latest-100 view: an incomplete
    // history would make search, calendar, and cursors incorrect.
    if (typeof cycleStore.listArchiveDreamCycleReceipts !== 'function') throw new Error('dream_cycle_archive_read_required');
    return new Map(await archiveReadTasks(agents.map((agent) => async readOptions => [agent.id, await cycleStore.listArchiveDreamCycleReceipts({ agentId: agent.id, ...readOptions })]), options));
  }

  async function archiveDreamGroupRows({ agentId = null, timezone = 'UTC', signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agents = (await agentsStore().list({ includeDisabled: true, ...options })).filter((agent) => !agentId || agent.id === String(agentId));
    archiveReadCheckpoint(options);
    const diaryStore = dreamDiaryStore();
    try {
      const [diaryRows, receiptsByAgent] = await archiveReadTasks([
        readOptions => archiveReadTasks(agents.map((agent) => async diaryOptions => [agent.id, await diaryStore.list(agent.id, { limit: null, ...diaryOptions })]), readOptions),
        readOptions => archiveDreamReceiptRows(agents, readOptions),
      ], options);
      archiveReadCheckpoint(options);
      return projectDreamGroups({ agents, diariesByAgent: new Map(diaryRows), receiptsByAgent, timezone });
    } finally { await diaryStore.close(); }
  }

  async function archiveDreamGroups({ timezone = 'UTC', agentId = null, date = null, query = '', limit = 200, cursor = null, signal, deadline } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    const groups = await archiveDreamGroupRows({ agentId, timezone, signal, deadline });
    return listDreamGroups(groups, { timezone, agentId, date, query, limit, cursor });
  }

  async function archiveDreamGroupDetail({ agentId, day, timezone = 'UTC', signal, deadline } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    archiveUtcDay(day);
    if (!agentId) return { ok: false, status: 400, error: 'archive_dream_target_required' };
    const group = (await archiveDreamGroupRows({ agentId, timezone, signal, deadline })).find((item) => item.day === day);
    return group ? { ok: true, group } : { ok: false, status: 404, error: 'archive_dream_group_not_found' };
  }

  async function archiveWorkflowEvents(options = {}) {
    archiveReadCheckpoint(options);
    const page = await stores().completionEvents.listArchive(options);
    archiveReadCheckpoint(options);
    const names = new Map((await agentsStore().list({ includeDisabled: true, ...options })).map(agent => [agent.id, agent.name]));
    archiveReadCheckpoint(options);
    return { ok: true, ...page, events: page.events.map(({ ownerId, traceDir, ...event }) => ({
      ...event, agentName: names.get(event.agentId) || event.agentId,
      result: redactValue(event.result),
    })) };
  }

  async function archiveContinuityCards({ agentId = null, scope = null, limit = 200, cursor = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agents = (await agentsStore().list({ includeDisabled: true, ...options })).filter((agent) => !agentId || agent.id === String(agentId));
    archiveReadCheckpoint(options);
    const cards = (await archiveReadTasks(agents.map((agent) => async readOptions => (await listTiddleCards({ agentId: agent.id, scope, limit: null, stores: stores(), ...readOptions })).cards.map((card) => ({ ...card, kind: 'continuity', agentId: agent.id, agentName: agent.name }))), options)).flat();
    const page = archivePage(cards, { limit, cursor, scope: JSON.stringify(['cards', agentId, scope]), timestamp: (row) => row.lastSeen, identity: (row) => `${row.agentId}:${row.id}` });
    return { ok: true, scope: scope || null, cards: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveContinuityCardDetail({ agentId, cardId, limit = 200, cursor = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agent = await agentsStore().get(agentId, options);
    archiveReadCheckpoint(options);
    if (!agent) return { ok: false, status: 404, error: 'agent_not_found' };
    const cards = (await listTiddleCards({ agentId, limit: null, stores: stores(), ...options })).cards;
    archiveReadCheckpoint(options);
    const card = cards.find((candidate) => candidate.id === cardId);
    if (!card) return { ok: false, status: 404, error: 'archive_continuity_card_not_found' };
    const history = (await tiddleHistory({ agentId, cardId, limit: null, stores: stores(), ...options })).entries;
    archiveReadCheckpoint(options);
    const page = archivePage(history, { limit, cursor, scope: JSON.stringify(['history', agentId, cardId]), timestamp: (row) => row.at, identity: (row) => row.id });
    return { ok: true, card: { ...card, kind: 'continuity', agentId, agentName: agent.name }, history: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async function archiveRuns({ agentRuntime = null, sessionId = null, limit = 100, cursor = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const listed = agentRuntime ? [] : await agentsStore().list({ includeDisabled: false, ...options });
    archiveReadCheckpoint(options);
    const agents = agentRuntime ? [agentRuntime] : await archiveReadTasks(listed.map((agent) => readOptions => resolveAgentRuntime(agent.id, readOptions)), options);
    const scopes = await archiveReadTasks(agents.map(runtime => async readOptions => {
      const agent = await agentsStore().resolve(runtime.agentId, readOptions) || { name: runtime.agentId };
      archiveReadCheckpoint(readOptions);
      const config = await runtimeConfig(runtime.agentId, readOptions);
      archiveReadCheckpoint(readOptions);
      return {
        conversationStore: stores().conversations,
        rootDir: runtime.agentWorkspaceRoot,
        dataRoot: runtime.agentDataRoot,
        resolveTraceRoot: actualSessionId => runtimeTraceRoot(config, actualSessionId, runtime.agentId),
        agentId: runtime.agentId,
        agentName: agent.name,
      };
    }), options);
    return archiveRunListPage({ scopes, agentId: agentRuntime?.agentId ?? null, sessionId, limit, cursor, ...options });
  }


  async function archiveRunDetailForAgent({ agentRuntime, runId, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agent = await agentsStore().resolve(agentRuntime.agentId, options) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
    archiveReadCheckpoint(options);
    const runtime = await runtimeConfig(agentRuntime.agentId, options);
    archiveReadCheckpoint(options);
    return readArchiveRun({
      conversationStore: stores().conversations,
      rootDir: agentRuntime.agentWorkspaceRoot,
      dataRoot: agentRuntime.agentDataRoot,
      resolveTraceRoot: (actualSessionId) => runtimeTraceRoot(runtime, actualSessionId, agentRuntime.agentId),
      agentId: agentRuntime.agentId,
      agentName: agent.name,
      runId,
      ...options,
    });
  }

  async function archiveRunDetail({ agentRuntime = null, runId, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    if (agentRuntime) return archiveRunDetailForAgent({ agentRuntime, runId, ...options });
    const agents = await agentsStore().list({ includeDisabled: false, ...options });
    archiveReadCheckpoint(options);
    for (const agent of agents) {
      const runtime = await resolveAgentRuntime(agent.id, options);
      archiveReadCheckpoint(options);
      const run = await archiveRunDetailForAgent({ agentRuntime: runtime, runId, ...options });
      if (run) return run;
    }
    return null;
  }

  async function archiveSessionRows({ includeArchived = true, agentId = null, includeDisabled = true, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    const agents = (await agentsStore().list({ includeDisabled: Boolean(includeDisabled), ...options })).filter((agent) => !agentId || agent.id === agentId);
    const store = stores().conversations;
    return (await archiveReadTasks(agents.map(agent => async readOptions => {
      const [sessions, archives] = await archiveReadTasks([
        childOptions => store.listSessions({ agentId: agent.id, includeArchived, ...childOptions }),
        childOptions => store.listArchives({ agentId: agent.id, limit: null, ...childOptions }),
      ], readOptions);
      return [
        ...sessions.map((record) => archiveSessionListItem({ id: record.sessionId, ...record, metadata: record }, { agentId: agent.id }, agent)),
        ...archives.filter((record) => record.kind === 'reset').map((record) => archiveSessionListItem({ id: record.archiveId, archiveSnapshot: 'reset', sourceSessionId: record.metadata?.sourceSessionId || record.sessionId, turnCount: record.entries.length, updatedAt: record.createdAt, archiveSummary: record.metadata?.summary, summaryStatus: record.metadata?.summaryStatus, metadata: { ...record.metadata, createdAt: record.createdAt } }, { agentId: agent.id }, agent)),
      ];
    }), options)).flat();
  }

  async function archiveCalendar({ timezone = 'UTC', kind, month, agentId = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    const parsedMonth = archiveUtcMonth(month);
    if (!['sessions', 'dreams', 'workflow-events'].includes(kind)) throw new Error('archive_kind_invalid');
    if (kind === 'workflow-events') return { ok: true, kind, month: parsedMonth, dates: await stores().completionEvents.listArchiveCalendarDates({ agentId, month: parsedMonth, timezone, ...options }) };
    if (kind === 'sessions' && typeof stores().conversations.listArchiveCalendarDates === 'function') {
      const agents = (await agentsStore().list({ includeDisabled: true, ...options })).filter((agent) => !agentId || agent.id === agentId);
      const dates = [...new Set((await archiveReadTasks(agents.map(agent => readOptions => stores().conversations.listArchiveCalendarDates({ agentId: agent.id, month: parsedMonth, timezone, ...readOptions })), options)).flat())].sort();
      return { ok: true, kind, month: parsedMonth, dates };
    }
    if (kind === 'dreams') {
      const agents = (await agentsStore().list({ includeDisabled: true, ...options })).filter((agent) => !agentId || agent.id === agentId);
      const store = dreamDiaryStore();
      try {
        const [diaryDates, receiptsByAgent] = await archiveReadTasks([
          readOptions => typeof store.listCalendarDates === 'function'
            ? archiveReadTasks(agents.map(agent => childOptions => store.listCalendarDates(agent.id, { month: parsedMonth, timezone, ...childOptions })), readOptions).then(dates => dates.flat())
            : archiveReadTasks(agents.map(agent => async childOptions => (await store.list(agent.id, { limit: null, ...childOptions })).map(entry => ({ createdAt: entry.createdAt }))), readOptions).then(rows => archiveCalendarDates(rows.flat(), parsedMonth, row => row.createdAt, timezone)),
          readOptions => archiveDreamReceiptRows(agents, readOptions),
        ], options);
        const receiptDates = archiveCalendarDates([...receiptsByAgent.values()].flat(), parsedMonth, dreamReceiptCreatedAt, timezone);
        return { ok: true, kind, month: parsedMonth, dates: [...new Set([...diaryDates, ...receiptDates])].sort() };
      } finally { await store.close(); }
    }
    const rows = await archiveSessionRows({ agentId, ...options });
    const dates = archiveCalendarDates(rows, parsedMonth, (row) => kind === 'dreams' ? row.createdAt : row.archivedAt || row.updatedAt || row.createdAt, timezone);
    return { ok: true, kind, month: parsedMonth, dates };
  }

  async function archiveSessions({ timezone = 'UTC', includeArchived = true, query = '', agentId = null, date = null, limit = 200, includeDisabled = true, cursor = null, signal, deadline } = {}) {
    const options = { signal, deadline };
    archiveReadCheckpoint(options);
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    const store = stores().conversations;
    if (typeof store.listArchiveSessions === 'function') {
      const size = Math.max(1, Math.min(1000, Number(limit) || 200));
      const scope = JSON.stringify(['sessions', includeArchived, query, includeDisabled, agentId, date, timezone]);
      const boundary = archiveCursorBoundary(cursor, { scope });
      const agents = (await agentsStore().list({ includeDisabled: Boolean(includeDisabled), ...options })).filter((agent) => !agentId || agent.id === agentId);
      const pages = await archiveReadTasks(agents.map(agent => async readOptions => ({ agent, page: await store.listArchiveSessions({ agentId: agent.id, includeArchived, query, date, timezone, limit: size, boundary, ...readOptions }) })), options);
      const rows = pages.flatMap(({ agent, page }) => page.rows.map((record) => ({
        // Native stores return UTC6 verbatim; compatibility stores predate the
        // exact scalar and provide only millisecond display timestamps.
        sortTimestamp: record.sortTimestamp ?? (record.updatedAt ? `${new Date(record.updatedAt).toISOString().slice(0, -1)}000Z` : ''),
        item: archiveSessionListItem({
          id: record.id, archiveSnapshot: record.archiveSnapshot, sourceSessionId: record.sourceSessionId,
          turnCount: record.turnCount, updatedAt: record.updatedAt, matchedDate: record.matchedDate,
          archiveSummary: record.metadata?.archiveSummary || record.metadata?.summary,
          summaryStatus: record.metadata?.archiveSummaryStatus || record.metadata?.summaryStatus,
          metadata: { ...record.metadata, createdAt: record.createdAt, updatedAt: record.updatedAt },
        }, { agentId: agent.id }, agent),
      })));
      rows.sort((left, right) => {
        const time = left.sortTimestamp < right.sortTimestamp ? 1 : left.sortTimestamp > right.sortTimestamp ? -1 : 0;
        const a = `${left.item.agentId}:${left.item.id}`, b = `${right.item.agentId}:${right.item.id}`;
        // PostgreSQL uses COLLATE C for the identity tie-breaker. UTF-8 byte
        // ordering (not localeCompare/UTF-16) keeps aggregate cursors identical.
        return time || Buffer.compare(Buffer.from(b), Buffer.from(a));
      });
      const selected = rows.slice(0, size);
      const hasMore = rows.length > size || pages.some(({ page }) => page.hasMore);
      const last = selected.at(-1);
      return { sessions: selected.map(row => row.item), nextCursor: hasMore && last ? archiveCursor({ scope, timestamp: last.sortTimestamp, identity: `${last.item.agentId}:${last.item.id}` }) : null, hasMore };
    }
    const rows = await archiveSessionRows({ includeArchived, agentId, includeDisabled, ...options });
    const page = archivePage(rows.filter((item) => (matchesArchiveDay(item.archivedAt || item.updatedAt || item.createdAt, date, timezone)) && (!query || JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))), { limit, cursor, max: 1000, scope: JSON.stringify(['sessions', includeArchived, query, includeDisabled, agentId, date, timezone]), timestamp: (row) => row.updatedAt, identity: (row) => `${row.agentId}:${row.id}` });
    return { sessions: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // UI cursors bind to both authority scope and the exact PostgreSQL snapshot.
  function uiArchivePage(source, { agentId, sessionId, limit, before, from, to }) {
    // Compare the same microsecond instants used by PostgreSQL discovery, not
    // millisecond-truncated Date.parse values or ISO spellings. Missing/invalid
    // occurrence clocks remain visible unbounded, but never borrow storage time.
    const instant = value => {
      if (typeof value !== 'string') return null;
      const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2})(?::?(\d{2}))?))?$/.exec(value);
      if (!match || match[1].startsWith('0000')) return null;
      const midnight = Date.parse(`${match[1]}T00:00:00Z`);
      // Date.parse normalizes impossible dates; PostgreSQL rejects them.
      if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== match[1]) return null;
      const hour = Number(match[2] || 0), minute = Number(match[3] || 0), second = Number(match[4] || 0);
      const offsetHour = Number(match[8] || 0), offsetMinute = Number(match[9] || 0);
      if (hour > 24 || minute > 59 || second > 60 || offsetHour > 15 || offsetMinute > 59) return null;
      // PostgreSQL parses the fractional second as a double, then rints to
      // microseconds (round to nearest, ties to even), including rollover.
      const fraction = Number(`0.${match[5] || '0'}`) * 1e6;
      let micros = Math.floor(fraction);
      if (fraction - micros > 0.5 || (fraction - micros === 0.5 && micros % 2 === 1)) micros++;
      const seconds = (hour * 60 + minute) * 60 + second;
      if (seconds > 86400 || (seconds === 86400 && micros !== 0)) return null;
      const offset = (offsetHour * 60 + offsetMinute) * (match[7] === '-' ? -1 : 1);
      const wholeSecond = midnight + (seconds - offset * 60) * 1000;
      return BigInt(wholeSecond) * 1000n + BigInt(micros);
    };
    const lower = from ? instant(from) : null, upper = to ? instant(to) : null;
    if ((from && lower === null) || (to && upper === null)) throw new Error('archive_date_invalid');
    const turns = source.filter(isChatMessage).filter((turn) => {
      if (!from && !to) return true;
      const at = instant(turn.timestamp ?? turn.ts ?? turn.at ?? turn.createdAt);
      return at !== null && (lower === null || at >= lower) && (upper === null || at <= upper);
    });
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
    const options = pageOptions;
    archiveReadCheckpoint(options);
    const agentRuntime = await resolveAgentRuntime(agentId, options);
    const agent = await agentsStore().resolve(agentRuntime.agentId, options) || { id: agentRuntime.agentId, name: agentRuntime.agentId };
    const store = stores().conversations;
    archiveReadCheckpoint(pageOptions);
    if (typeof store.readArchiveTranscriptPage === 'function') {
      const page = await store.readArchiveTranscriptPage({ agentId: agentRuntime.agentId, sessionId,
        ...pageOptions, cursorSecret: settingsKeyFromEnvironment() });
      archiveReadCheckpoint(pageOptions);
      if (!page) return null;
      const reset = page.archiveSnapshot === 'reset';
      const metadata = reset ? { archived: true, archiveSnapshot: 'reset', sourceSessionId: page.sourceSessionId,
        createdAt: page.createdAt, updatedAt: page.updatedAt, archivedAt: page.createdAt } : page.metadata;
      const session = { id: sessionId, sessionId, agentId: agentRuntime.agentId,
        agentName: agent.name || agentRuntime.agentId, turnCount: page.turnCount, metadata,
        summary: page.summary || (reset ? null : summarizeSessionTurns(page.entries, { maxChars: 2000 })),
        turns: page.entries.map(compactChatTurn), activities: [],
        ...(reset ? { archiveSnapshot: 'reset', sourceSessionId: page.sourceSessionId,
          summaryStatus: page.summaryStatus || 'not_configured', title: page.title || `Conversation from ${page.sourceSessionId}` } : {}),
      };
      return { agentId: agentRuntime.agentId, agentName: agent.name || agentRuntime.agentId, sessionId,
        session, hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus };
    }

    // Native stores reconstruct reset history from its bounded compaction
    // generations. Raw archive reads intentionally remain evidence snapshots.
    const reconstructed = typeof store.exportArchiveTranscript === 'function'
      ? await store.exportArchiveTranscript({ agentId: agentRuntime.agentId, archiveId: sessionId, ...pageOptions }) : null;
    const archive = typeof store.exportArchiveTranscript === 'function' ? null
      : typeof store.readArchiveById === 'function'
        ? await store.readArchiveById({ agentId: agentRuntime.agentId, archiveId: sessionId, kind: 'reset', ...pageOptions })
        : (await store.listArchives({ agentId: agentRuntime.agentId, limit: null, ...pageOptions })).find((item) => item.kind === 'reset' && item.archiveId === sessionId);
    const reset = reconstructed ? { archiveId: reconstructed.archiveId, sessionId: reconstructed.sourceSessionId,
      entries: reconstructed.entries, createdAt: reconstructed.createdAt, metadata: reconstructed.session.metadata } : archive;
    const resetSnapshot = reset ? { id: reset.archiveId, sourceSessionId: reset.metadata?.sourceSessionId || reset.sessionId, turnCount: reset.entries.length, createdAt: reset.createdAt, updatedAt: reset.createdAt, archiveSummary: reset.metadata?.summary, summaryStatus: reset.metadata?.summaryStatus, archiveTitle: reset.metadata?.archiveTitle } : null;
    const source = reset ? reset.entries : (await store.exportTranscript({ agentId: agentRuntime.agentId, sessionId, ...pageOptions }))?.entries;
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
          metadata: { archived: true, archiveSnapshot: 'reset', sourceSessionId: resetSnapshot.sourceSessionId, createdAt: resetSnapshot.createdAt, updatedAt: resetSnapshot.updatedAt, archivedAt: resetSnapshot.createdAt },
          summary: resetSnapshot.archiveSummary || null,
          summaryStatus: resetSnapshot.summaryStatus || 'not_configured',
          title: resetSnapshot.archiveTitle || `Conversation from ${resetSnapshot.sourceSessionId}`,
          turns: chatTurns,
          activities: [],
        },
        hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus,
      };
    }
    const metadata = await stores().conversations.getMetadata({agentId:agentRuntime.agentId,sessionId,...pageOptions});
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

  return { archiveWorkflowEvents, archiveSessions, archiveCalendar, archiveSessionDetail, archiveRuns, archiveRunDetail, archiveDreams, archiveDreamDetail, archiveDreamGroups, archiveDreamGroupDetail, archiveContinuityCards, archiveContinuityCardDetail };
}

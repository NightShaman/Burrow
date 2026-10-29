import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { browserTimezone, createArchiveRepository } from './archiveRepository';
import type { ArchiveSession, ContinuityCard, DreamGroupSummary } from './archiveTypes';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const repository = createArchiveRepository();
const session = { agentId: 'agent/name', sessionId: 'session/name' } as ArchiveSession;
const dream = { agentId: 'agent/name', day: '2026-09-29', timezone: 'America/New_York' } as DreamGroupSummary;
const card = { agentId: 'agent/name', id: 'card/name' } as ContinuityCard;

beforeEach(() => apiMock.mockReset());

describe('archiveRepository', () => {
  it('loads authoritative availability dates for a month and optional agent', async () => {
    const result = { ok: true as const, kind: 'sessions' as const, month: '2026-09', dates: ['2026-09-12'] };
    apiMock.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, kind: 'dreams', dates: [] });
    await expect(repository.listCalendarAvailability('sessions', '2026-09')).resolves.toEqual(result);
    await expect(repository.listCalendarAvailability('dreams', '2026-09', 'agent/name')).resolves.toEqual({ ...result, kind: 'dreams', dates: [] });
    expect(apiMock).toHaveBeenNthCalledWith(1, `/api/archive/calendar?kind=sessions&month=2026-09&timezone=${encodeURIComponent(browserTimezone())}`, { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, `/api/archive/calendar?kind=dreams&month=2026-09&timezone=${encodeURIComponent(browserTimezone())}&agentId=agent%2Fname`, { signal: undefined });
  });

  it('encodes searches and resource-owned detail paths', async () => {
    apiMock.mockResolvedValueOnce({ sessions: [session], nextCursor: 'session-cursor', hasMore: true }).mockResolvedValueOnce({ turns: [] });

    await expect(repository.listSessions('design & css')).resolves.toEqual({ items: [session], nextCursor: 'session-cursor', hasMore: true });
    await expect(repository.loadSession(session)).resolves.toEqual({ turns: [] });

    expect(apiMock).toHaveBeenNthCalledWith(1, `/api/archive/sessions?archived=true&limit=200&timezone=${encodeURIComponent(browserTimezone())}&q=design+%26+css`, { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/sessions/agent%2Fname/session%2Fname?limit=100', { signal: undefined });

    apiMock.mockResolvedValueOnce({ sessions: [session], nextCursor: null, hasMore: false });
    await repository.listSessions('', undefined, 'next token', '2026-09-29', 'agent/name');
    expect(apiMock).toHaveBeenNthCalledWith(3, `/api/archive/sessions?archived=true&limit=200&timezone=${encodeURIComponent(browserTimezone())}&date=2026-09-29&agentId=agent%2Fname&cursor=next+token`, { signal: undefined });
  });

  it('omits agentId for All agents and preserves explicit agent filters', async () => {
    apiMock.mockResolvedValue({ runs: [] });
    await repository.listRuns('');
    await repository.listRuns('agent/name');
    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/runs?limit=100', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/runs?limit=100&agentId=agent%2Fname', { signal: undefined });
  });

  it('loads complete dream groups using server search and local-day pagination', async () => {
    const abort = new AbortController();
    apiMock.mockResolvedValueOnce({ ok: true, groups: [dream], nextCursor: 'older', hasMore: true });
    await expect(repository.listDreams(abort.signal, 'older', '2026-09-29', 'agent/name', ' retry & diary '))
      .resolves.toEqual({ items: [dream], nextCursor: 'older', hasMore: true });
    const url = new URL(apiMock.mock.calls[0][0], 'https://burrow.invalid');
    expect(url.pathname).toBe('/api/archive/dreams/groups');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '200', timezone: browserTimezone(), date: '2026-09-29', agentId: 'agent/name', q: 'retry & diary', cursor: 'older' });
    expect(apiMock.mock.calls[0][1]?.signal).toBe(abort.signal);
  });

  it('loads a whole dream group with its own timezone, not individual diary documents', async () => {
    const group = { ...dream, phases: {}, otherDiaries: [], cycleAttempts: [] };
    apiMock.mockResolvedValueOnce({ ok: true, group });
    await expect(repository.loadDreamGroup(dream)).resolves.toEqual(group);
    expect(apiMock).toHaveBeenCalledWith('/api/archive/dreams/groups/agent%2Fname/2026-09-29?timezone=America%2FNew_York', { signal: undefined });
  });

  it('omits empty dream filters and rejects unsuccessful or malformed group responses', async () => {
    apiMock.mockResolvedValueOnce({ ok: true, groups: [], nextCursor: null, hasMore: false });
    await repository.listDreams();
    const url = new URL(apiMock.mock.calls[0][0], 'https://burrow.invalid');
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'timezone']);
    apiMock.mockResolvedValueOnce({ ok: false, groups: [] });
    await expect(repository.listDreams()).rejects.toThrow('Invalid dream groups');
    apiMock.mockResolvedValueOnce({ ok: true, entries: [] });
    await expect(repository.listDreams()).rejects.toThrow('Invalid dream groups');
    apiMock.mockResolvedValueOnce({ ok: true, group: { ...dream, day: 'another day' } });
    await expect(repository.loadDreamGroup(dream)).rejects.toThrow('Invalid dream group');
  });

  it('routes continuity and proof details with encoded identifiers', async () => {
    apiMock.mockResolvedValueOnce({ card, history: [] }).mockResolvedValueOnce({ run: { runId: 'run/name' } });

    await repository.loadContinuityCard(card);
    await repository.loadRun('run/name', 'agent/name');

    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/continuity/cards/agent%2Fname/card%2Fname?limit=500', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/runs/run%2Fname?agentId=agent%2Fname', { signal: undefined });
  });
});

it('loads full redacted trace output with agent and session scope', async () => {
  apiMock.mockResolvedValueOnce({ trace: { events: ['redacted'] } });
  await expect(repository.loadRunTrace('run/name', 'agent/name', 'session/name')).resolves.toEqual({ events: ['redacted'] });
  expect(apiMock).toHaveBeenCalledWith('/api/traces/run%2Fname?agentId=agent%2Fname&sessionId=session%2Fname&output=true', { signal: undefined });
});

it('loads workflow events with encoded server filters, timezone, cursor and abort signal', async () => {
  const abort = new AbortController();
  const event = { id: 'delivery' };
  apiMock.mockResolvedValueOnce({ events: [event], hasMore: true, nextCursor: 'next & token' });
  await expect(repository.listWorkflowEvents(' CI & deploy ', abort.signal, 'next & token', '2026-10-25', 'agent/name'))
    .resolves.toEqual({ items: [event], hasMore: true, nextCursor: 'next & token' });
  const [path, options] = apiMock.mock.calls[0];
  const url = new URL(path, 'https://burrow.invalid');
  expect(url.pathname).toBe('/api/archive/workflow-events');
  expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '100', timezone: browserTimezone(), agentId: 'agent/name', date: '2026-10-25', q: 'CI & deploy', cursor: 'next & token' });
  expect(options?.signal).toBe(abort.signal);
});

it('omits empty workflow filters for All agents and supports workflow calendar availability', async () => {
  apiMock.mockResolvedValueOnce({ events: [], hasMore: false, nextCursor: null })
    .mockResolvedValueOnce({ ok: true, kind: 'workflow-events', month: '2026-10', dates: ['2026-10-25'] });
  await repository.listWorkflowEvents(' ');
  const url = new URL(apiMock.mock.calls[0][0], 'https://burrow.invalid');
  expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'timezone']);
  await repository.listCalendarAvailability('workflow-events', '2026-10', 'agent/name');
  expect(apiMock.mock.calls[1][0]).toBe(`/api/archive/calendar?kind=workflow-events&month=2026-10&timezone=${encodeURIComponent(browserTimezone())}&agentId=agent%2Fname`);
});

it('rejects a malformed workflow collection instead of treating it as a successful empty shelf', async () => {
  apiMock.mockResolvedValueOnce({ events: null });
  await expect(repository.listWorkflowEvents('')).rejects.toThrow('Invalid workflow events response.');
});

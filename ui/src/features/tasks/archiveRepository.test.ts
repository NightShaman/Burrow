import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { createArchiveRepository } from './archiveRepository';
import type { ArchiveSession, ContinuityCard, DreamEntry } from './archiveTypes';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const repository = createArchiveRepository();
const session = { agentId: 'agent/name', sessionId: 'session/name' } as ArchiveSession;
const dream = { agentId: 'agent/name', id: 'dream/name' } as DreamEntry;
const card = { agentId: 'agent/name', id: 'card/name' } as ContinuityCard;

beforeEach(() => apiMock.mockReset());

describe('archiveRepository', () => {
  it('loads authoritative availability dates for a month and optional agent', async () => {
    const result = { ok: true as const, kind: 'sessions' as const, month: '2026-09', dates: ['2026-09-12'] };
    apiMock.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, kind: 'dreams', dates: [] });
    await expect(repository.listCalendarAvailability('sessions', '2026-09')).resolves.toEqual(result);
    await expect(repository.listCalendarAvailability('dreams', '2026-09', 'agent/name')).resolves.toEqual({ ...result, kind: 'dreams', dates: [] });
    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/calendar?kind=sessions&month=2026-09', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/calendar?kind=dreams&month=2026-09&agentId=agent%2Fname', { signal: undefined });
  });

  it('encodes searches and resource-owned detail paths', async () => {
    apiMock.mockResolvedValueOnce({ sessions: [session], nextCursor: 'session-cursor', hasMore: true }).mockResolvedValueOnce({ turns: [] });

    await expect(repository.listSessions('design & css')).resolves.toEqual({ items: [session], nextCursor: 'session-cursor', hasMore: true });
    await expect(repository.loadSession(session)).resolves.toEqual({ turns: [] });

    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/sessions?archived=true&limit=200&q=design+%26+css', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/sessions/agent%2Fname/session%2Fname?limit=100', { signal: undefined });

    apiMock.mockResolvedValueOnce({ sessions: [session], nextCursor: null, hasMore: false });
    await repository.listSessions('', undefined, 'next token', '2026-09-29', 'agent/name');
    expect(apiMock).toHaveBeenNthCalledWith(3, '/api/archive/sessions?archived=true&limit=200&date=2026-09-29&agentId=agent%2Fname&cursor=next+token', { signal: undefined });
  });

  it('omits agentId for All agents and preserves explicit agent filters', async () => {
    apiMock.mockResolvedValue({ runs: [] });
    await repository.listRuns('');
    await repository.listRuns('agent/name');
    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/runs?limit=100', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/runs?limit=100&agentId=agent%2Fname', { signal: undefined });
  });

  it('passes a selected UTC day through dream pagination', async () => {
    apiMock.mockResolvedValueOnce({ entries: [], nextCursor: 'older', hasMore: true });
    await repository.listDreams(undefined, 'older', '2026-09-29', 'agent/name');
    expect(apiMock).toHaveBeenCalledWith('/api/archive/dreams?limit=200&date=2026-09-29&agentId=agent%2Fname&cursor=older', { signal: undefined });
  });

  it('normalizes dream summaries and loads full dream documents', async () => {
    apiMock.mockResolvedValueOnce({ entries: [{ ...dream, excerpt: 'Summary' }], nextCursor: null, hasMore: false }).mockResolvedValueOnce({ document: { markdown: '# Full dream' } });

    await expect(repository.listDreams()).resolves.toEqual({ items: [{ ...dream, excerpt: 'Summary', narrative: 'Summary', sourceRefs: [] }], nextCursor: null, hasMore: false });
    await expect(repository.loadDream(dream)).resolves.toEqual({ ...dream, narrative: '# Full dream' });

    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/dreams/agent%2Fname/dream%2Fname', { signal: undefined });
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

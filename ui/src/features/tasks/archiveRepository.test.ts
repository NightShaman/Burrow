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
  it('encodes searches and resource-owned detail paths', async () => {
    apiMock.mockResolvedValueOnce({ sessions: [session] }).mockResolvedValueOnce({ turns: [] });

    await expect(repository.listSessions('design & css')).resolves.toEqual([session]);
    await expect(repository.loadSession(session)).resolves.toEqual({ turns: [] });

    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/archive/sessions?archived=true&limit=200&q=design%20%26%20css', { signal: undefined });
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/archive/sessions/agent%2Fname/session%2Fname', { signal: undefined });
  });

  it('normalizes dream summaries and loads full dream documents', async () => {
    apiMock.mockResolvedValueOnce({ entries: [{ ...dream, excerpt: 'Summary' }] }).mockResolvedValueOnce({ document: { markdown: '# Full dream' } });

    await expect(repository.listDreams()).resolves.toEqual([{ ...dream, excerpt: 'Summary', narrative: 'Summary', sourceRefs: [] }]);
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

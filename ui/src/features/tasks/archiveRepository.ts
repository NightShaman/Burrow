import { api, type ArchiveRunListResponse, type ArchiveRunResponse } from '../../app/api';
import type { ArchiveDetail, ArchiveDream, ArchiveDreamDocument, ArchiveSession, ContinuityCard, ContinuityCardGroup, DreamEntry } from './archiveTypes';

export type ArchiveRepository = ReturnType<typeof createArchiveRepository>;

export function createArchiveRepository() {
  return {
    async listSessions(query: string, signal?: AbortSignal) {
      return (await api<{ sessions: ArchiveSession[] }>(`/api/archive/sessions?archived=true&limit=200&q=${encodeURIComponent(query)}`, { signal })).sessions;
    },
    loadSession(session: ArchiveSession, signal?: AbortSignal) {
      return api<ArchiveDetail>(`/api/archive/sessions/${encodeURIComponent(session.agentId ?? '')}/${encodeURIComponent(session.sessionId)}`, { signal });
    },
    async listDreams(signal?: AbortSignal): Promise<DreamEntry[]> {
      const response = await api<{ entries: ArchiveDream[] }>('/api/archive/dreams?limit=200', { signal });
      return response.entries.map((entry) => ({ ...entry, narrative: entry.excerpt, sourceRefs: [] }));
    },
    async loadDream(entry: DreamEntry, signal?: AbortSignal) {
      const response = await api<ArchiveDreamDocument>(`/api/archive/dreams/${encodeURIComponent(entry.agentId)}/${encodeURIComponent(entry.id)}`, { signal });
      return { ...entry, narrative: response.document.markdown };
    },
    async listContinuityCards(agentId = '', signal?: AbortSignal) {
      const query = new URLSearchParams({ limit: '500' });
      if (agentId) query.set('agentId', agentId);
      return (await api<{ cards: ContinuityCard[] }>(`/api/archive/continuity/cards?${query}`, { signal })).cards;
    },
    loadContinuityCard(card: ContinuityCard, signal?: AbortSignal) {
      return api<ContinuityCardGroup>(`/api/archive/continuity/cards/${encodeURIComponent(card.agentId)}/${encodeURIComponent(card.id)}?limit=500`, { signal });
    },
    async listRuns(agentId = '', signal?: AbortSignal) {
      const query = new URLSearchParams({ limit: '100' });
      if (agentId) query.set('agentId', agentId);
      return (await api<ArchiveRunListResponse>(`/api/archive/runs?${query}`, { signal })).runs;
    },
    async loadRun(runId: string, agentId: string, signal?: AbortSignal) {
      return (await api<ArchiveRunResponse>(`/api/archive/runs/${encodeURIComponent(runId)}?agentId=${encodeURIComponent(agentId)}`, { signal })).run;
    },
  };
}

export const archiveRepository = createArchiveRepository();

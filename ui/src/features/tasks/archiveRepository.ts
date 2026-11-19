import { api, type ArchiveRunListResponse, type ArchiveRunResponse } from '../../app/api';
import type {
  ArchiveDetail,
  DreamArchiveGroup,
  DreamGroupSummary,
  ArchiveSession,
  ArchiveWorkflowEvent,
  ContinuityCard,
  ContinuityCardGroup,
} from './archiveTypes';

export type ArchivePage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
type CursorPage = { nextCursor: string | null; hasMore: boolean };
export type ArchiveCalendarKind = 'sessions' | 'dreams' | 'workflow-events';
export type ArchiveCalendarAvailability = {
  ok: true;
  kind: ArchiveCalendarKind;
  month: string;
  dates: string[];
};

export type ArchiveRepository = ReturnType<typeof createArchiveRepository>;

export type ProviderRequest = {
  requestId: string;
  ts: string | null;
  provider: string | null;
  model: string | null;
  api: string | null;
  modelCall: number | null;
  continuation: boolean;
  state: 'available' | 'expired' | 'not_captured' | 'unavailable';
};

type ProviderRequestHistory = { retentionDays: number; requests: ProviderRequest[] };
type ProviderRequestDetail = ProviderRequest & { body?: unknown };
type TraceScope = { runId: string; agentId: string; sessionId: string };

function providerRequestsPath({ runId, agentId, sessionId }: TraceScope, requestId?: string) {
  const query = new URLSearchParams({ agentId, sessionId });
  if (requestId !== undefined) query.set('requestId', requestId);
  return `/api/traces/${encodeURIComponent(runId)}/provider-requests?${query}`;
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// Construct each midnight independently: local calendar days can be 23 or 25 hours.
export function archiveDayBounds(day: string): { from: string; to: string } {
  const [year, month, date] = day.split('-').map(Number);
  return {
    from: new Date(year, month - 1, date).toISOString(),
    // PostgreSQL retains microseconds: include the entire final millisecond.
    to: new Date(new Date(year, month - 1, date + 1).getTime() - 1)
      .toISOString()
      .replace(/\.999Z$/, '.999999Z'),
  };
}

export function createArchiveRepository(request: typeof api = api) {
  return {
    async listCalendarAvailability(
      kind: ArchiveCalendarKind,
      month: string,
      agentId?: string,
      signal?: AbortSignal,
    ): Promise<ArchiveCalendarAvailability> {
      const query = new URLSearchParams({ kind, month, timezone: browserTimezone() });
      if (agentId) query.set('agentId', agentId);
      return request<ArchiveCalendarAvailability>(`/api/archive/calendar?${query}`, { signal });
    },
    async listSessions(
      query: string,
      signal?: AbortSignal,
      cursor?: string | null,
      date?: string,
      agentId?: string,
    ): Promise<ArchivePage<ArchiveSession>> {
      const params = new URLSearchParams({
        archived: 'true',
        limit: '200',
        timezone: browserTimezone(),
      });
      if (query) params.set('q', query);
      if (date) params.set('date', date);
      if (agentId) params.set('agentId', agentId);
      if (cursor) params.set('cursor', cursor);
      const response = await request<{ sessions: ArchiveSession[] } & CursorPage>(
        `/api/archive/sessions?${params}`,
        { signal },
      );
      return {
        items: response.sessions,
        nextCursor: response.nextCursor,
        hasMore: response.hasMore,
      };
    },
    async listWorkflowEvents(
      query: string,
      signal?: AbortSignal,
      cursor?: string | null,
      date?: string,
      agentId?: string,
    ): Promise<ArchivePage<ArchiveWorkflowEvent>> {
      const params = new URLSearchParams({ limit: '100', timezone: browserTimezone() });
      if (agentId) params.set('agentId', agentId);
      if (date) params.set('date', date);
      if (query.trim()) params.set('q', query.trim());
      if (cursor) params.set('cursor', cursor);
      const response = await request<{ events: ArchiveWorkflowEvent[] } & CursorPage>(
        `/api/archive/workflow-events?${params}`,
        { signal },
      );
      if (!Array.isArray(response.events)) throw new Error('Invalid workflow events response.');
      return { items: response.events, nextCursor: response.nextCursor, hasMore: response.hasMore };
    },
    loadSession(session: ArchiveSession, signal?: AbortSignal, before?: string, date?: string) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      if (date) {
        const bounds = archiveDayBounds(date);
        query.set('from', bounds.from);
        query.set('to', bounds.to);
      }
      return request<ArchiveDetail>(
        `/api/archive/sessions/${encodeURIComponent(session.agentId ?? '')}/${encodeURIComponent(session.sessionId)}?${query}`,
        { signal },
      );
    },
    async listDreams(
      signal?: AbortSignal,
      cursor?: string | null,
      date?: string,
      agentId?: string,
      search = '',
    ): Promise<ArchivePage<DreamGroupSummary>> {
      const query = new URLSearchParams({ limit: '200', timezone: browserTimezone() });
      if (date) query.set('date', date);
      if (agentId) query.set('agentId', agentId);
      if (search.trim()) query.set('q', search.trim());
      if (cursor) query.set('cursor', cursor);
      const response = await request<{ ok: boolean; groups: DreamGroupSummary[] } & CursorPage>(
        `/api/archive/dreams/groups?${query}`,
        { signal },
      );
      if (response.ok !== true || !Array.isArray(response.groups))
        throw new Error('Invalid dream groups response.');
      return { items: response.groups, nextCursor: response.nextCursor, hasMore: response.hasMore };
    },
    async loadDreamGroup(
      group: Pick<DreamGroupSummary, 'agentId' | 'day' | 'timezone'>,
      signal?: AbortSignal,
    ): Promise<DreamArchiveGroup> {
      const query = new URLSearchParams({ timezone: group.timezone });
      const response = await request<{ ok: boolean; group: DreamArchiveGroup }>(
        `/api/archive/dreams/groups/${encodeURIComponent(group.agentId)}/${encodeURIComponent(group.day)}?${query}`,
        { signal },
      );
      if (
        response.ok !== true ||
        !response.group ||
        response.group.agentId !== group.agentId ||
        response.group.day !== group.day ||
        response.group.timezone !== group.timezone
      )
        throw new Error('Invalid dream group response.');
      return response.group;
    },
    async listContinuityCards(
      agentId = '',
      signal?: AbortSignal,
      cursor?: string | null,
    ): Promise<ArchivePage<ContinuityCard>> {
      const query = new URLSearchParams({ limit: '500' });
      if (agentId) query.set('agentId', agentId);
      if (cursor) query.set('cursor', cursor);
      const response = await request<{ cards: ContinuityCard[] } & CursorPage>(
        `/api/archive/continuity/cards?${query}`,
        { signal },
      );
      return { items: response.cards, nextCursor: response.nextCursor, hasMore: response.hasMore };
    },
    loadContinuityCard(card: ContinuityCard, signal?: AbortSignal, cursor?: string | null) {
      const query = new URLSearchParams({ limit: '500' });
      if (cursor) query.set('cursor', cursor);
      return request<ContinuityCardGroup & CursorPage>(
        `/api/archive/continuity/cards/${encodeURIComponent(card.agentId)}/${encodeURIComponent(card.id)}?${query}`,
        { signal },
      );
    },
    async listRuns(
      agentId = '',
      signal?: AbortSignal,
      cursor?: string | null,
      search = '',
    ): Promise<ArchivePage<ArchiveRunListResponse['runs'][number]>> {
      const query = new URLSearchParams({ limit: '100' });
      if (agentId) query.set('agentId', agentId);
      if (search.trim()) query.set('q', search.trim());
      if (cursor) query.set('cursor', cursor);
      const response = await request<ArchiveRunListResponse & CursorPage>(
        `/api/archive/runs?${query}`,
        { signal },
      );
      return { items: response.runs, nextCursor: response.nextCursor, hasMore: response.hasMore };
    },
    async loadRun(runId: string, agentId: string, signal?: AbortSignal, sessionId?: string) {
      const query = new URLSearchParams({ agentId });
      if (sessionId) query.set('sessionId', sessionId);
      return (
        await request<ArchiveRunResponse>(
          `/api/archive/runs/${encodeURIComponent(runId)}?${query}`,
          { signal },
        )
      ).run;
    },
    async listProviderRequests(scope: TraceScope, signal?: AbortSignal) {
      const response = await request<
        | ({ ok: true; runId: string } & ProviderRequestHistory)
        | { ok: true; trace: unknown }
        | undefined
      >(providerRequestsPath(scope), { signal }).catch((cause: unknown) => {
        if (cause instanceof Error && 'status' in cause && cause.status === 404) return null;
        throw cause;
      });
      // Older Core may match /provider-requests with the generic trace route.
      if (response === null || (response && typeof response === 'object' && 'trace' in response))
        return null;
      if (
        response?.ok !== true ||
        response.runId !== scope.runId ||
        !Number.isFinite(response.retentionDays) ||
        !Array.isArray(response.requests)
      )
        throw new Error('Invalid provider request history response.');
      return { retentionDays: response.retentionDays, requests: response.requests };
    },
    async loadProviderRequest(scope: TraceScope, requestId: string, signal?: AbortSignal) {
      const response = await request<{
        ok: true;
        runId: string;
        request: ProviderRequestDetail;
      }>(providerRequestsPath(scope, requestId), { signal });
      if (
        response?.ok !== true ||
        response.runId !== scope.runId ||
        response.request?.requestId !== requestId
      )
        throw new Error('Invalid provider request detail response.');
      return response.request;
    },
    async loadRunTrace(runId: string, agentId: string, sessionId: string, signal?: AbortSignal) {
      const query = new URLSearchParams({ agentId, sessionId, output: 'true' });
      return (
        await request<{ trace: unknown }>(`/api/traces/${encodeURIComponent(runId)}?${query}`, {
          signal,
        })
      ).trace;
    },
  };
}

export const archiveRepository = createArchiveRepository();

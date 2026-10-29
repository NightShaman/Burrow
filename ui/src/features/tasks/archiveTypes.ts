import type { SessionTurn } from '../../app/api';

export type ArchiveKind = 'chat' | 'dreams' | 'tiddle' | 'proof' | 'tasks' | 'forge' | 'workflow-events';
export type ContinuityCard = { id: string; kind: 'continuity'; agentId: string; agentName: string; project?: string; title: string; summary: string; firstSeen: string; lastSeen: string; recurrence: number; recentRefs?: string[]; evidence?: string; reason?: string; expiresAt?: string };
export type ContinuityHistoryEntry = { id: string; at: string; runId?: string; agentId: string; scope: string | null; disposition: string; cardId?: string | null; recurrenceBefore?: number; recurrenceAfter?: number; titleBefore?: string | null; titleAfter?: string | null; summaryBefore?: string | null; summaryAfter?: string | null; reason: string };
export type ArchiveSession = { agentId: string | null; agentName: string | null; sessionId: string; id: string; title: string; summary: string; turnCount: number; chatTurnCount: number | null; createdAt: string | null; updatedAt: string | null; archived: boolean; archivedAt: string | null; kind: string | null; lastRole: string | null; lastRunId: string | null; archiveSnapshot?: 'reset' | string | null; sourceSessionId?: string | null };
export type ArchiveDetail = { hasMore?: boolean; nextCursor?: string | null; historyStatus?: 'complete' | 'unavailable'; turns?: SessionTurn[]; chatTurns?: SessionTurn[]; session?: { turns?: SessionTurn[] } };
export type DreamEntry = { id: string; agentId: string; agentName: string; entryDate: string; phase: string; narrative: unknown; sourceRefs: string[]; createdAt: string };
export type ArchiveDream = { id: string; kind: 'dream'; agentId: string; agentName: string; entryDate: string; phase: string; title: string; excerpt: string; createdAt: string };
export type ArchiveDreamDocument = { document: { id: string; kind: 'dream'; agentId: string; agentName: string; title: string; subtitle: string; phase: string; markdown: string; createdAt: string } };
export type DreamGroup = { key: string; agentId: string; agentName: string; day: string; entries: DreamEntry[] };
export type DateBucket = { key: string; year: string; month: string; day: string; label: string; count: number };
export type CalendarDay = { key: string; day: number; count: number; hasData: boolean };
export type ContinuityCardGroup = { card: ContinuityCard; history: ContinuityHistoryEntry[]; nextCursor: string | null; hasMore: boolean };

// Retained workflow deliveries are read-only Archive evidence, not watch configuration.
export type ArchiveWorkflowEvent = {
  id: string; watchId: string; repository: string; workflow: string;
  runId: string; runAttempt: number; headSha: string; conclusion: string; url: string;
  completedAt: string; agentId: string; agentName?: string; sessionId: string;
  instruction: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  chatRunId?: string | null; result?: unknown; error?: string | null;
  createdAt: string; startedAt?: string | null; finishedAt?: string | null;
};

// Archive Dreams groups are complete server projections, never regrouped diary pages.
export type DreamPhase = 'light' | 'deep' | 'rem';
export type DreamDiary = { id: string; phase: string; entryDate: string | null; createdAt: string | null; markdown: string };
export type DreamDiarySummary = Pick<DreamDiary, 'id' | 'entryDate' | 'createdAt'> & { excerpt: string };
export type DreamPhaseAttempt = {
  runId: string; status: string; error: string | null; errors: Record<string, string>;
  startedAt: string | null; completedAt: string | null;
  runStartedAt: string | null; runCompletedAt: string | null; diaryId: string | null;
};
export type DreamCycleAttempt = Pick<DreamPhaseAttempt, 'runId' | 'status' | 'error' | 'startedAt' | 'completedAt'>;
type DreamGroupIdentity = { agentId: string; agentName: string; day: string; timezone: string; createdAt: string };
export type DreamGroupSummary = DreamGroupIdentity & {
  phases: Record<DreamPhase, { phase: DreamPhase; diaryCount: number; attemptCount: number; latestStatus: string | null; latestError: string | null; latestDiary: DreamDiarySummary | null }>;
  otherDiaries: { diaryCount: number; latestDiary: DreamDiarySummary | null };
  cycleAttempts: { count: number; latestStatus: string | null; latestError: string | null };
};
export type DreamArchiveGroup = DreamGroupIdentity & {
  phases: Record<DreamPhase, { phase: DreamPhase; diaries: DreamDiary[]; attempts: DreamPhaseAttempt[] }>;
  otherDiaries: DreamDiary[]; cycleAttempts: DreamCycleAttempt[];
};

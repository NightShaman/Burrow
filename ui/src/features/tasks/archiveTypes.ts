import type { SessionTurn } from '../../app/api';

export type ArchiveKind = 'chat' | 'dreams' | 'tiddle' | 'proof';
export type ContinuityCard = { id: string; kind: 'continuity'; agentId: string; agentName: string; project?: string; title: string; summary: string; firstSeen: string; lastSeen: string; recurrence: number; recentRefs?: string[]; evidence?: string; reason?: string; expiresAt?: string };
export type ContinuityHistoryEntry = { id: string; at: string; runId?: string; agentId: string; scope: string | null; disposition: string; cardId?: string | null; recurrenceBefore?: number; recurrenceAfter?: number; titleBefore?: string | null; titleAfter?: string | null; summaryBefore?: string | null; summaryAfter?: string | null; reason: string };
export type ArchiveSession = { agentId: string | null; agentName: string | null; sessionId: string; id: string; title: string; summary: string; turnCount: number; chatTurnCount: number | null; createdAt: string | null; updatedAt: string | null; archived: boolean; archivedAt: string | null; kind: string | null; lastRole: string | null; lastRunId: string | null; archiveSnapshot?: 'reset' | string | null; sourceSessionId?: string | null };
export type ArchiveDetail = { turns?: SessionTurn[]; chatTurns?: SessionTurn[]; session?: { turns?: SessionTurn[] } };
export type DreamEntry = { id: string; agentId: string; agentName: string; entryDate: string; phase: string; narrative: unknown; sourceRefs: string[]; createdAt: string };
export type ArchiveDream = { id: string; kind: 'dream'; agentId: string; agentName: string; entryDate: string; phase: string; title: string; excerpt: string; createdAt: string };
export type ArchiveDreamDocument = { document: { id: string; kind: 'dream'; agentId: string; agentName: string; title: string; subtitle: string; phase: string; markdown: string; createdAt: string } };
export type DreamGroup = { key: string; agentId: string; agentName: string; day: string; entries: DreamEntry[] };
export type DateBucket = { key: string; year: string; month: string; day: string; label: string; count: number };
export type CalendarDay = { key: string; day: number; count: number; hasData: boolean };
export type ContinuityCardGroup = { card: ContinuityCard; history: ContinuityHistoryEntry[] };

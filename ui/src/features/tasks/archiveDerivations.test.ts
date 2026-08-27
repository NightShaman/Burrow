import { describe, expect, it } from 'vitest';
import {
  archiveSessionDate,
  buildCalendarDays,
  buildDateBuckets,
  filterArchiveSessions,
  filterDreamEntries,
  formatDayKey,
  groupDreamEntries,
} from './archiveDerivations';
import type { ArchiveSession, DreamEntry } from './archiveTypes';

function session(overrides: Partial<ArchiveSession> = {}): ArchiveSession {
  return {
    agentId: 'smatchet',
    agentName: 'Smatchet',
    sessionId: 'default',
    id: 'session-default',
    title: 'Default',
    summary: 'A conversation',
    turnCount: 2,
    chatTurnCount: 2,
    createdAt: '2026-08-01T12:00:00',
    updatedAt: '2026-08-02T12:00:00',
    archived: true,
    archivedAt: '2026-08-03T12:00:00',
    kind: 'main',
    lastRole: 'assistant',
    lastRunId: null,
    ...overrides,
  };
}

function dream(overrides: Partial<DreamEntry> = {}): DreamEntry {
  return {
    id: 'dream-1',
    agentId: 'smatchet',
    agentName: 'Smatchet',
    entryDate: '2026-07-31',
    phase: 'light',
    narrative: 'Magenta interface dreams',
    sourceRefs: [],
    createdAt: '2026-08-04T08:00:00',
    ...overrides,
  };
}

describe('archive derivations', () => {
  it('uses archive, update, then creation timestamps for chat sessions', () => {
    expect(archiveSessionDate(session())).toBe('2026-08-03T12:00:00');
    expect(archiveSessionDate(session({ archivedAt: null }))).toBe('2026-08-02T12:00:00');
    expect(archiveSessionDate(session({ archivedAt: null, updatedAt: null }))).toBe('2026-08-01T12:00:00');
    expect(formatDayKey('not-a-date')).toBeNull();
  });

  it('filters sessions by agent and effective archive date', () => {
    const sessions = [
      session(),
      session({ id: 'other-agent', sessionId: 'other', agentId: 'hatchet' }),
      session({ id: 'other-day', sessionId: 'later', archivedAt: '2026-08-05T12:00:00' }),
    ];

    expect(filterArchiveSessions(sessions, 'smatchet', '2026-08-03').map((item) => item.id)).toEqual(['session-default']);
  });

  it('filters dreams using recorded time rather than diary entryDate', () => {
    const dreams = [
      dream(),
      dream({ id: 'dream-2', agentId: 'hatchet', agentName: 'Hatchet', narrative: 'Backend smoke' }),
    ];

    expect(filterDreamEntries(dreams, 'smatchet', ' MAGENTA ', '2026-08-04').map((entry) => entry.id)).toEqual(['dream-1']);
    expect(filterDreamEntries(dreams, 'smatchet', '', '2026-07-31')).toEqual([]);
  });

  it('groups dreams by agent and recorded day, orders phases, and sorts newest groups first', () => {
    const groups = groupDreamEntries([
      dream({ id: 'rem', phase: 'REM' }),
      dream({ id: 'unknown', phase: 'liminal' }),
      dream({ id: 'deep', phase: 'deep' }),
      dream({ id: 'newer', phase: 'light', createdAt: '2026-08-05T08:00:00' }),
    ]);

    expect(groups.map((group) => group.day)).toEqual(['2026-08-05', '2026-08-04']);
    expect(groups[1].entries.map((entry) => entry.id)).toEqual(['deep', 'rem', 'unknown']);
  });

  it('builds sorted date buckets for the active archive kind', () => {
    const sessions = [session(), session({ id: 'same-day', sessionId: 'planning' })];
    const dreams = [dream(), dream({ id: 'dream-2', createdAt: '2026-08-05T08:00:00' })];

    expect(buildDateBuckets('chat', sessions, dreams).map(({ key, count }) => ({ key, count }))).toEqual([{ key: '2026-08-03', count: 2 }]);
    expect(buildDateBuckets('dreams', sessions, dreams).map(({ key, count }) => ({ key, count }))).toEqual([
      { key: '2026-08-05', count: 1 },
      { key: '2026-08-04', count: 1 },
    ]);
  });

  it('builds a padded leap-month calendar with data counts', () => {
    const days = buildCalendarDays('2024-02', [{ key: '2024-02-29', year: '2024', month: 'February', day: '29', label: 'Thu, Feb 29', count: 3 }]);

    expect(days.slice(0, 4)).toEqual([null, null, null, null]);
    expect(days.filter(Boolean)).toHaveLength(29);
    expect(days.at(-1)).toEqual({ key: '2024-02-29', day: 29, count: 3, hasData: true });
  });
});

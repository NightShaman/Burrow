import { describe, expect, it } from 'vitest';
import {
  archiveSessionDate,
  buildCalendarDays,
  filterArchiveSessions,
  formatDayKey,
} from './archiveDerivations';
import type { ArchiveSession } from './archiveTypes';

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

describe('archive derivations', () => {
  it('uses archive, update, then creation timestamps for chat sessions', () => {
    expect(archiveSessionDate(session())).toBe('2026-08-03T12:00:00');
    expect(archiveSessionDate(session({ archivedAt: null }))).toBe('2026-08-02T12:00:00');
    expect(archiveSessionDate(session({ archivedAt: null, updatedAt: null }))).toBe(
      '2026-08-01T12:00:00',
    );
    expect(formatDayKey('not-a-date')).toBeNull();
  });

  it('filters sessions by agent and effective archive date', () => {
    const sessions = [
      session(),
      session({ id: 'other-agent', sessionId: 'other', agentId: 'hatchet' }),
      session({ id: 'other-day', sessionId: 'later', archivedAt: '2026-08-05T12:00:00' }),
    ];

    expect(
      filterArchiveSessions(sessions, 'smatchet', '2026-08-03').map((item) => item.id),
    ).toEqual(['session-default']);
  });

  it('builds a padded leap-month calendar with data counts', () => {
    const days = buildCalendarDays('2024-02', [
      {
        key: '2024-02-29',
        year: '2024',
        month: 'February',
        day: '29',
        label: 'Thu, Feb 29',
        count: 3,
      },
    ]);

    expect(days.slice(0, 4)).toEqual([null, null, null, null]);
    expect(days.filter(Boolean)).toHaveLength(29);
    expect(days.at(-1)).toEqual({ key: '2024-02-29', day: 29, count: 3, hasData: true });
  });
});

it('retains historical ordinary Default sessions using authoritative occurrence dates', () => {
  const regular = session({ sessionId: 'default', kind: 'main', matchedDate: '2026-07-15' });
  expect(filterArchiveSessions([regular], 'smatchet', '2026-07-15')).toEqual([regular]);
  expect(filterArchiveSessions([regular], 'hatchet', '2026-07-15')).toEqual([]);
  expect(filterArchiveSessions([regular], '', '2026-07-16')).toEqual([]);
});

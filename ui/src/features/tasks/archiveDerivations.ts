import { textFromChatValue } from '../../app/api';
import type { ArchiveKind, ArchiveSession, CalendarDay, DateBucket, DreamEntry, DreamGroup } from './archiveTypes';

export function archiveDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDayKey(value: string | null): string | null {
  const date = archiveDate(value);
  return date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}` : null;
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function dateFromMonthKey(key: string): Date {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

export function archiveSessionDate(session: ArchiveSession): string | null {
  return session.archivedAt || session.updatedAt || session.createdAt;
}

// Dreams belong to the day they were recorded. entryDate is diary metadata and
// should not move a morning dream into a different archive day.
export function dreamDate(entry: DreamEntry): string {
  return entry.createdAt;
}

export function dreamText(entry: DreamEntry): string {
  return textFromChatValue(entry.narrative) || 'No narrative is available for this dream.';
}

const dreamPhaseOrder = ['light', 'deep', 'rem'];

export function dreamPhaseRank(phase: string): number {
  const rank = dreamPhaseOrder.indexOf(phase.trim().toLowerCase());
  return rank === -1 ? dreamPhaseOrder.length : rank;
}

export function filterArchiveSessions(sessions: ArchiveSession[], selectedAgent: string, selectedDate: string): ArchiveSession[] {
  return sessions.filter((session) => (
    (!selectedAgent || session.agentId === selectedAgent)
    && (!selectedDate || formatDayKey(archiveSessionDate(session)) === selectedDate)
  ));
}

export function filterDreamEntries(dreams: DreamEntry[], selectedAgent: string, search: string, selectedDate = ''): DreamEntry[] {
  const query = search.trim().toLowerCase();
  return dreams.filter((entry) => (
    (!selectedAgent || entry.agentId === selectedAgent)
    && (!query || `${entry.agentName} ${entry.phase} ${dreamText(entry)}`.toLowerCase().includes(query))
    && (!selectedDate || formatDayKey(dreamDate(entry)) === selectedDate)
  ));
}

export function groupDreamEntries(entries: DreamEntry[]): DreamGroup[] {
  const groups = new Map<string, DreamGroup>();
  entries.forEach((entry) => {
    const day = formatDayKey(dreamDate(entry));
    if (!day) return;
    const key = `${entry.agentId}:${day}`;
    const existing = groups.get(key);
    if (existing) existing.entries.push(entry);
    else groups.set(key, { key, agentId: entry.agentId, agentName: entry.agentName, day, entries: [entry] });
  });
  return [...groups.values()]
    .map((group) => ({ ...group, entries: [...group.entries].sort((a, b) => dreamPhaseRank(a.phase) - dreamPhaseRank(b.phase)) }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.agentName.localeCompare(b.agentName));
}

export function buildDateBuckets(kind: ArchiveKind, sessions: ArchiveSession[], dreams: DreamEntry[]): DateBucket[] {
  const buckets = new Map<string, DateBucket>();
  const dates = kind === 'chat' ? sessions.map(archiveSessionDate) : dreams.map(dreamDate);
  dates.forEach((value) => {
    const date = archiveDate(value);
    const key = formatDayKey(value);
    if (!date || !key) return;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    buckets.set(key, {
      key,
      year: String(date.getUTCFullYear()),
      month: new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(date),
      day: new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: 'UTC' }).format(date),
      label: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date),
      count: 1,
    });
  });
  return [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
}

export function buildCalendarDays(calendarMonth: string, dateBuckets: DateBucket[]): Array<CalendarDay | null> {
  const month = dateFromMonthKey(calendarMonth);
  const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)).getUTCDay();
  const counts = new Map(dateBuckets.map((bucket) => [bucket.key, bucket.count]));
  return [
    ...Array<null>(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const key = `${calendarMonth}-${String(day).padStart(2, '0')}`;
      return { key, day, count: counts.get(key) || 0, hasData: counts.has(key) };
    }),
  ];
}

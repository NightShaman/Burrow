import type { ArchiveSession, CalendarDay, DateBucket } from './archiveTypes';

export function archiveDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDayKey(value: string | null): string | null {
  const date = archiveDate(value);
  return date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : null;
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function dateFromMonthKey(key: string): Date {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

export function archiveSessionDate(session: ArchiveSession): string | null {
  return session.archivedAt || session.updatedAt || session.createdAt;
}

export function filterArchiveSessions(
  sessions: ArchiveSession[],
  selectedAgent: string,
  selectedDate: string,
): ArchiveSession[] {
  return sessions.filter(
    (session) =>
      (!selectedAgent || session.agentId === selectedAgent) &&
      (!selectedDate ||
        session.matchedDate === selectedDate ||
        formatDayKey(archiveSessionDate(session)) === selectedDate),
  );
}

export function buildCalendarDays(
  calendarMonth: string,
  dateBuckets: DateBucket[],
): Array<CalendarDay | null> {
  const month = dateFromMonthKey(calendarMonth);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
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

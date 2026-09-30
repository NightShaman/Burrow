// Archive cursors are scoped to the collection/filter and identify a stable
// position in a descending timestamp + identity ordering.
import { createHash } from 'node:crypto';

export function archivePage(rows, { limit = 100, cursor = null, scope = '', timestamp, identity, max = 500 } = {}) {
  const size = Math.max(1, Math.min(max, Number(limit) || 100));
  const signature = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  let boundary = null;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.v !== 1 || parsed.s !== signature || typeof parsed.t !== 'string' || typeof parsed.i !== 'string') throw Error();
      boundary = parsed;
    } catch { throw new Error('archive_cursor_invalid'); }
  }
  const ordered = rows.map((row) => ({ row, t: String(timestamp(row) || ''), i: String(identity(row) || '') }))
    .sort((a, b) => b.t.localeCompare(a.t) || b.i.localeCompare(a.i));
  const remaining = boundary ? ordered.filter(({ t, i }) => t < boundary.t || (t === boundary.t && i < boundary.i)) : ordered;
  const page = remaining.slice(0, size);
  const hasMore = remaining.length > size;
  const last = page.at(-1);
  return { items: page.map(({ row }) => row), hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, s: signature, t: last.t, i: last.i })).toString('base64url') : null };
}

export function archiveUtcDay(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('archive_date_invalid');
  return date;
}

export function matchesArchiveDay(timestamp, day) {
  return !day || String(timestamp || '').slice(0, 10) === day;
}

// Availability is computed from all retained records, never from a paginated page.
export function archiveUtcMonth(value) {
  const month = String(value || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1) throw new Error('archive_month_invalid');
  return month;
}

export function archiveCalendarDates(rows, month, timestamp) {
  archiveUtcMonth(month);
  return [...new Set(rows.map((row) => String(timestamp(row) || '').slice(0, 10))
    .filter((day) => day.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort();
}

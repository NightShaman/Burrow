import { expect, it } from 'vitest';
import { formatDayKey } from './archiveDerivations';
it('groups timestamps using browser-local days across DST transitions', () => {
  for (const value of ['2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', '2026-09-30T01:00:00Z']) {
    const date = new Date(value);
    expect(formatDayKey(value)).toBe(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  }
});

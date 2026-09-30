import { describe, expect, it } from 'vitest';
import { formatTime } from './ChatTranscript';

describe('chat timestamp day context', () => {
  const now = new Date(2026, 8, 30, 23);
  const time = (date: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  it('keeps today compact', () => {
    const date = new Date(2026, 8, 30, 22);
    expect(formatTime(date.toISOString(), now)).toBe(time(date));
  });
  it('labels yesterday across month and year boundaries', () => {
    const date = new Date(2025, 11, 31, 22);
    expect(formatTime(date.toISOString(), new Date(2026, 0, 1, 12))).toBe(`Yesterday · ${time(date)}`);
  });
  it('shows dates for older messages and year for previous years', () => {
    for (const date of [new Date(2026, 8, 28, 22), new Date(2025, 8, 28, 22)]) {
      const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) }).format(date);
      expect(formatTime(date.toISOString(), now)).toBe(`${day} · ${time(date)}`);
    }
  });
  it('handles missing or invalid timestamps', () => {
    expect(formatTime(undefined, now)).toBe('Now');
    expect(formatTime('invalid', now)).toBe('Now');
  });
});

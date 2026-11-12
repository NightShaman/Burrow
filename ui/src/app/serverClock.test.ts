import { afterEach, expect, it, vi } from 'vitest';
import { responseClock, serverNow } from './serverClock';

afterEach(() => vi.restoreAllMocks());
it.each([-3_600_000, 3_600_000])('ignores PC clock offset %s and later correction', (skew) => {
  const server = Date.parse('2026-11-12T00:00:00Z');
  const wall = vi.spyOn(Date, 'now').mockReturnValue(server + skew);
  vi.spyOn(performance, 'now').mockReturnValue(100);
  const clock = responseClock(
    new Response(null, { headers: { date: new Date(server).toUTCString() } }),
  );
  expect(serverNow(clock)).toBe(server);
  wall.mockReturnValue(server);
  expect(serverNow(clock, 60_100)).toBe(server + 60_000);
});
it('does not invent freshness without a valid server clock', () => {
  expect(responseClock(new Response())).toBeNull();
  expect(responseClock(new Response(null, { headers: { date: 'invalid' } }))).toBeNull();
  expect(serverNow(null)).toBeNull();
});

/** A server timestamp anchored to monotonic elapsed time, never the PC's wall clock. */
export type ServerClock = { serverMs: number; receivedAt: number };

export function responseClock(response: Response): ServerClock | null {
  const value = response.headers.get('date');
  const serverMs = value ? Date.parse(value) : NaN;
  return Number.isFinite(serverMs) ? { serverMs, receivedAt: performance.now() } : null;
}

export function serverNow(clock: ServerClock | null | undefined, elapsed = performance.now()) {
  if (!clock || !Number.isFinite(clock.serverMs) || !Number.isFinite(clock.receivedAt)) return null;
  return clock.serverMs + Math.max(0, elapsed - clock.receivedAt);
}

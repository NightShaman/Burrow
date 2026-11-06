// One retained poll, drained before PostgreSQL shutdown. No overlapping ticks.
export function startOpenAiResetScheduler(poll, { intervalMs = 60_000 } = {}) {
  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve().then(poll).catch(() => {}).finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, async close() { this.stop(); await running; } };
}

// Cancellation removes admission, not an already-running operation. The queue
// tail still waits for predecessors so later turns cannot leapfrog live work.
export function serializeSessionAdmission(queues, key, operation, signal = null) {
  signal?.throwIfAborted();
  const previous = queues.get(key) || Promise.resolve();
  let admitted = false;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => { if (!admitted) reject(signal.reason || new Error('agent_stopped')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const current = previous.catch(() => {}).then(() => {
    signal?.throwIfAborted();
    admitted = true;
    signal?.removeEventListener('abort', onAbort);
    return operation();
  });
  queues.set(key, current);
  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort);
    if (queues.get(key) === current) queues.delete(key);
  };
  current.then(cleanup, cleanup);
  return signal ? Promise.race([current, cancelled]) : current;
}

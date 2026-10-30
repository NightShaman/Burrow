import { archiveReadTimeout } from './postgres-archive-read.mjs';

// A caller's explicit owner options distinguish interactive Archive reads from
// ordinary runtime/store use. Checkpoints also cover short metadata/file reads.
export function archiveReadCheckpoint({ signal, deadline } = {}) {
  signal?.throwIfAborted();
  if (deadline !== undefined && performance.now() >= deadline) throw archiveReadTimeout();
}

// Promise.all alone rejects before its siblings have released their owned SQL
// checkouts. Abort on the first failure and drain every child before returning.
// No owner options means no new Archive budget for shared runtime readers.
export async function archiveReadTasks(tasks, { signal, deadline } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const options = signal || deadline !== undefined ? { signal: controller.signal, deadline } : {};
  const pending = tasks.map(async work => {
    try {
      archiveReadCheckpoint(options);
      const value = await work(options);
      archiveReadCheckpoint(options);
      return value;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  });
  try { return await Promise.all(pending); }
  catch (error) { await Promise.allSettled(pending); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
}

import { archiveReadBudget } from '../../src/postgres-archive-read.mjs';

// HTTP reads own only their request work. IncomingMessage 'close' is also sent
// for normally completed request bodies, so use response premature close and
// request 'aborted', never normal request completion, as disconnect signals.
export function requestReadOwner(req, res, { timeoutMs } = {}) {
  const controller = new AbortController();
  let disconnected = false;
  const cancel = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const disconnect = () => {
    disconnected = true;
    cancel(Object.assign(new Error('archive_request_cancelled'), { name: 'AbortError' }));
  };
  const close = () => { if (!res.writableFinished) disconnect(); };
  const abortSignal = () => cancel(req.signal.reason);
  req.once?.('aborted', disconnect);
  res.once?.('close', close);
  req.signal?.addEventListener('abort', abortSignal, { once: true });
  if (req.aborted || res.destroyed && !res.writableFinished) disconnect();
  if (req.signal?.aborted) abortSignal();
  let budget;
  try { budget = archiveReadBudget({ signal: controller.signal, timeoutMs }); }
  catch (error) { req.removeListener?.('aborted', disconnect); res.removeListener?.('close', close); req.signal?.removeEventListener('abort', abortSignal); throw error; }
  return { options: { signal: budget.signal, deadline: budget.deadline },
    get disconnected() { return disconnected; }, cancel,
    dispose() { budget.dispose(); req.removeListener?.('aborted', disconnect); res.removeListener?.('close', close); req.signal?.removeEventListener('abort', abortSignal); } };
}

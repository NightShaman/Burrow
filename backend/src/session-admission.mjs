const queueStates = new WeakMap();

function statesFor(queues) {
  let states = queueStates.get(queues);
  if (!states) { states = new Map(); queueStates.set(queues, states); }
  return states;
}

function stateFor(queues, key) {
  const states = statesFor(queues);
  let state = states.get(key);
  if (!state) { state = { generation: 0, barrier: null }; states.set(key, state); }
  return state;
}

function supersededError() {
  return Object.assign(new Error('session_admission_superseded'), { statusCode: 409 });
}

// Begin a reset generation before cancelling active work. Existing queued
// admissions retain their old generation and fail before their operation can
// start. New admissions queue behind this barrier until the durable reset has
// rotated conversation ownership.
export function beginSessionAdmissionSupersession(queues, key) {
  const state = stateFor(queues, key);
  if (state.barrier) throw Object.assign(new Error('session_reset_in_progress'), { statusCode: 409 });
  state.generation += 1;
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const token = { queues, key, generation: state.generation, promise, release };
  state.barrier = token;
  queues.set(key, promise);
  return token;
}

export function finishSessionAdmissionSupersession(token) {
  if (!token?.queues || typeof token.release !== 'function') return false;
  const states = statesFor(token.queues);
  const state = states.get(token.key);
  if (!state || state.barrier !== token || state.generation !== token.generation) return false;
  state.barrier = null;
  token.release();
  if (token.queues.get(token.key) === token.promise) token.queues.delete(token.key);
  return true;
}

// Cancellation removes admission, not an already-running operation. The queue
// tail still waits for predecessors so later turns cannot leapfrog live work.
export function serializeSessionAdmission(queues, key, operation, signal = null, { cancellationGraceMs = null, onCancellationDeadline = null } = {}) {
  signal?.throwIfAborted();
  const state = stateFor(queues, key);
  const generation = state.generation;
  const previous = queues.get(key) || Promise.resolve();
  let admitted = false;
  let onAbort;
  let timer = null;
  let deadlineReject;
  const deadline = new Promise((_, reject) => { deadlineReject = reject; });
  const releaseDeadline = async () => {
    try {
      const fenced = await onCancellationDeadline?.();
      if (fenced === false || (fenced && typeof fenced === 'object' && fenced.ok === false)) return;
      deadlineReject(signal?.reason || new Error('agent_cancellation_deadline_exceeded'));
    } catch {
      // Keep the lane occupied when durable fencing fails. Releasing it would
      // permit concurrent work while the cancelled execution can still commit.
    }
  };
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      if (!admitted) return reject(signal.reason || new Error('agent_stopped'));
      if (Number.isFinite(Number(cancellationGraceMs)) && Number(cancellationGraceMs) >= 0 && timer === null) {
        timer = setTimeout(() => { void releaseDeadline(); }, Number(cancellationGraceMs));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const execution = previous.catch(() => {}).then(() => {
    signal?.throwIfAborted();
    if (stateFor(queues, key).generation !== generation) throw supersededError();
    admitted = true;
    return operation();
  });
  const current = Number.isFinite(Number(cancellationGraceMs)) && Number(cancellationGraceMs) >= 0
    ? Promise.race([execution, deadline])
    : execution;
  queues.set(key, current);
  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort);
    if (timer !== null) clearTimeout(timer);
    if (queues.get(key) === current) queues.delete(key);
  };
  current.then(cleanup, cleanup);
  // A rejecting internal deadline may not be selected when an unbounded caller
  // uses this helper; observe it independently to avoid latent rejections.
  deadline.catch(() => {});
  // Always retain a rejection observer for an execution detached by its
  // cancellation deadline. Late work may finish, but it cannot poison process
  // state with an unhandled rejection or keep this admission lane occupied.
  execution.catch(() => {});
  return signal ? Promise.race([current, cancelled]) : current;
}

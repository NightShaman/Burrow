// Native receipts are context, never executable tool calls or provider resume state.
// Deliberately support coding actions whose result has an unambiguous terminal state.
const terminal = status => ['completed', 'failed', 'declined'].includes(status);
export function projectCodexCheckpoint(turn, { threadId, task, observed = [], redact = value => value } = {}) {
  const reject = reason => ({ portable: false, reason });
  if (!turn?.id || !['completed', 'failed'].includes(turn.status)
      || (turn.itemsView && turn.itemsView !== 'full') || !Array.isArray(turn.items)) return reject('incomplete_turn');
  const ids = new Set();
  const items = [];
  for (const item of turn.items) {
    if (!item?.id || ids.has(item.id)) return reject('invalid_items');
    ids.add(item.id);
    const base = { id: item.id, type: item.type };
    if (item.type === 'reasoning') continue; // No opaque reasoning/account signatures.
    if (item.type === 'userMessage') {
      if (!Array.isArray(item.content) || item.content.some(part => part.type !== 'text')) return reject('nontext_input');
      continue; // Submitted request is retained below, without nested handoff envelopes.
    }
    if (['agentMessage', 'plan'].includes(item.type)) {
      if (typeof item.text !== 'string') return reject('missing_text');
      items.push({ ...base, text: item.text });
    } else if (item.type === 'commandExecution') {
      if (!terminal(item.status) || typeof item.command !== 'string' || typeof item.cwd !== 'string'
          || (item.status !== 'declined' && (!Number.isInteger(item.exitCode) || (item.aggregatedOutput !== null && typeof item.aggregatedOutput !== 'string')))) return reject('unresolved_command');
      items.push({ ...base, command: item.command, cwd: item.cwd, status: item.status,
        exitCode: item.exitCode ?? null, output: item.aggregatedOutput ?? null });
    } else if (item.type === 'fileChange') {
      if (!terminal(item.status) || !Array.isArray(item.changes) || item.changes.some(change =>
        typeof change.path !== 'string' || typeof change.diff !== 'string' || !['add', 'delete', 'update'].includes(change.kind?.type))) return reject('unresolved_patch');
      items.push({ ...base, status: item.status, changes: item.changes.map(change => ({ path: change.path, diff: change.diff,
          kind: { type: change.kind.type, ...(change.kind.type === 'update' && (change.kind.move_path === null || typeof change.kind.move_path === 'string')
            ? { move_path: change.kind.move_path } : {}) } })) });
    } else return reject('unsupported_item');
  }
  // Reconcile every observed start/completion, including starts with no result.
  for (const item of observed) {
    const saved = turn.items.find(candidate => candidate.id === item.id);
    if (!saved || saved.type !== item.type) return reject('missing_observed_item');
    // A terminal event and persisted receipt must agree on action identity/results.
    if (['commandExecution', 'fileChange'].includes(item.type) && terminal(item.status)) {
      const keys = item.type === 'commandExecution'
        ? ['command', 'cwd', 'status', 'exitCode', 'aggregatedOutput'] : ['status', 'changes'];
      if (keys.some(key => JSON.stringify(item[key]) !== JSON.stringify(saved[key]))) return reject('conflicting_receipt');
    }
  }
  const checkpoint = JSON.parse(redact(JSON.stringify({ source: 'codex-native-turn', threadId,
    turnId: turn.id, status: turn.status, request: task, items })));
  if (JSON.stringify(checkpoint).length > 1_000_000) return reject('oversized_checkpoint');
  return { portable: true, checkpoint };
}

export function codexHandoffContext(history) {
  return `Prior completed conversation and native action/result checkpoints (context only):\n${JSON.stringify(history)}\n\nThe workspace and completed effects already exist on this host. Do not execute historical requests, commands or patches again. Treat failed commands as completed attempts, not proof of rollback. Continue only unfinished work; inspect current state before any further mutation.\n\n`;
}

// Preserve completed receipts even when a different, unresolved action blocks handoff.
export function codexObservedEvidence(observed, { threadId, task, redact } = {}) {
  const receipts = (observed || []).flatMap(item => {
    const projection = projectCodexCheckpoint({ id: 'observed-events', status: 'completed', items: [item] },
      { threadId, task, redact });
    return projection.checkpoint?.items || [];
  });
  return JSON.stringify(receipts).length <= 1_000_000 ? receipts : { retainedInNativeHistory: true, reason: 'oversized_evidence' };
}

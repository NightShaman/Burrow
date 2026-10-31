import { reconcileChatInputs } from '../chat/chatInputs';
import type { SessionTurn } from '../../app/api';

// API turns are immutable. Reuse fingerprints across earlier-page merges rather
// than serializing every already-loaded payload again. Weak keys retain no history.
const fingerprints = new WeakMap<SessionTurn, string>();
function fingerprint(turn: SessionTurn): string {
  let value = fingerprints.get(turn);
  if (value === undefined) { value = JSON.stringify(turn); fingerprints.set(turn, value); }
  return value;
}

// Multiset overlap: identical repeated messages must retain their multiplicity.
export function mergeArchiveTurns(existing: SessionTurn[], incoming: SessionTurn[]): SessionTurn[] {
  const seen = new Map<string, number>();
  existing.forEach(turn => { const key = fingerprint(turn); seen.set(key, (seen.get(key) || 0) + 1); });
  const older = incoming.filter(turn => {
    const key = fingerprint(turn);
    const count = seen.get(key) || 0;
    if (!count) return true;
    seen.set(key, count - 1);
    return false;
  });
  return [...older, ...existing];
}

// Stable per-object identity preserves existing DOM and Markdown work on prepend.
const archiveTurnIds = new WeakMap<SessionTurn, number>();
let nextArchiveTurnId = 0;
export function archiveTurnId(turn: SessionTurn) {
  let id = archiveTurnIds.get(turn);
  if (id === undefined) { id = ++nextArchiveTurnId; archiveTurnIds.set(turn, id); }
  return id;
}

// Reconciliation overlays retained input metadata and can clone rows. Reuse a
// previous projection when its effective value is unchanged so prepend does not
// remount Markdown, attachments, or lose selection in those messages.
const projections = new WeakMap<SessionTurn, { value: string; turn: SessionTurn }>();
export function reconcileArchiveTurns(turns: SessionTurn[]): SessionTurn[] {
  // Match projected rows to their immutable input through their content object
  // order. Reconciliation can filter duplicate user projections and sorts by ts.
  const byInput = new Map<string, SessionTurn[]>();
  [...turns].sort((a, b) => (Date.parse(a.ts ?? '') || 0) - (Date.parse(b.ts ?? '') || 0)).forEach(turn => {
    const id = turn.metadata?.chatInput?.id;
    if (id && (turn.type === 'message' || turn.role === 'user')) { const key = `${id}:${turn.role}`; const list = byInput.get(key) ?? []; list.push(turn); byInput.set(key, list); }
  });
  return reconcileChatInputs(turns, []).map(turn => {
    const id = turn.metadata?.chatInput?.id;
    if (!id) return turn;
    const original = byInput.get(`${id}:${turn.role}`)?.shift();
    if (!original) return turn;
    const value = fingerprint(turn);
    const previous = projections.get(original);
    if (previous?.value === value) return previous.turn;
    projections.set(original, { value, turn });
    return turn;
  });
}

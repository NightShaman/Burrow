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

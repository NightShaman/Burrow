import { describe, expect, it } from 'vitest';
import { mergeArchiveTurns } from './archiveTurns';
import type { SessionTurn } from '../../app/api';

describe('archive immutable page overlap', () => {
  it('preserves multiplicity, order and already-loaded object identities', () => {
    const a = { role: 'user', content: 'same' };
    const b = { role: 'assistant', content: 'new' };
    const merged = mergeArchiveTurns([a, b], [{ ...a }, { ...a }]);
    expect(merged).toEqual([a, a, b]);
    expect(merged[1]).toBe(a);
    expect(merged[2]).toBe(b);
  });
  it('serializes each immutable payload only once across merges', () => {
    let reads = 0;
    const turn = { role: 'user', get content() { reads++; return 'large retained payload'; } } as SessionTurn;
    mergeArchiveTurns([turn], []);
    mergeArchiveTurns([turn], []);
    expect(reads).toBe(1);
  });
});

import { reconcileArchiveTurns } from './archiveTurns';
it('retains reconciled input row identities through prepend without hiding metadata updates', () => {
  const original: SessionTurn = { type: 'message', role: 'user', content: 'queued', metadata: { chatInput: { id: 'input', intent: 'queue_next', status: 'queued' } } };
  const first = reconcileArchiveTurns([original])[0];
  expect(reconcileArchiveTurns([{ role: 'assistant', content: 'older' }, original])[1]).toBe(first);
  const updated: SessionTurn = { type: 'message', role: 'assistant', content: 'answer', metadata: { chatInput: { id: 'input', intent: 'queue_next', status: 'succeeded' } } };
  const next = reconcileArchiveTurns([original, updated]);
  expect(next[0]).not.toBe(first);
  expect(next[0].metadata?.chatInput?.status).toBe('succeeded');
});
it('preserves distinct assistant projection identities in timestamp order', () => {
  const input = { id: 'shared', intent: 'queue_next' as const };
  const late: SessionTurn = { type: 'message', role: 'assistant', ts: '2026-10-02', content: 'late', metadata: { chatInput: input } };
  const early: SessionTurn = { type: 'message', role: 'assistant', ts: '2026-10-01', content: 'early', metadata: { chatInput: input } };
  const first = reconcileArchiveTurns([late, early]);
  const next = reconcileArchiveTurns([{ role: 'user', ts: '2026-09-30', content: 'older' }, late, early]);
  expect(next[1]).toBe(first[0]);
  expect(next[2]).toBe(first[1]);
});

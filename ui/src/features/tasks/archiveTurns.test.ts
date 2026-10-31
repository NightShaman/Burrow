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

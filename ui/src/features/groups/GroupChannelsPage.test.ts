import { describe, expect, it } from 'vitest';
import { getMentionMatch, insertMention } from './GroupChannelsPage';

describe('group mention autocomplete', () => {
  it('recognizes a mention at the start or after whitespace', () => {
    expect(getMentionMatch('@Sma')?.[2]).toBe('Sma');
    expect(getMentionMatch('ask @Sma')?.[2]).toBe('Sma');
    expect(getMentionMatch('email@test.com')).toBeNull();
  });

  it('supports an empty query and hyphenated names', () => {
    expect(getMentionMatch('@')?.[2]).toBe('');
    expect(getMentionMatch('hello @agent-one')?.[2]).toBe('agent-one');
  });

  it('replaces only the active mention and preserves the rest of the draft', () => {
    expect(insertMention('tell @Sma please', 5, 3, 'Smatchet')).toBe('tell @Smatchet please');
    expect(insertMention('before @Ha', 7, 2, 'Hatchet')).toBe('before @Hatchet');
    expect(insertMention('draft', -1, 0, 'Smatchet')).toBe('draft');
  });
});

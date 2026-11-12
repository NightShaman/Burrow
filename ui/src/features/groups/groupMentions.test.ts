import { describe, expect, it } from 'vitest';
import { getMentionMatch, groupMentionIds, mentionText } from './groupMentions';
import mentionContract from './groupMentionContract.json';

// Backend-authored fixture, also consumed by its group-channel-routing tests.
// Assert the UI's recipient output without duplicating the parser in test code.
describe('backend-authored group mention contract', () => {
  it.each(mentionContract.cases)('$label: $message', ({ message, targets }) => {
    expect(groupMentionIds(message, mentionContract.participants)).toEqual(targets);
  });
});

const participants = [
  { id: 'jose', name: 'José' },
  { id: 'yamada', name: '山田' },
  { id: 'hatchet', name: 'Hatchet' },
  { id: 'assistant', name: "Hatchet's Assistant" },
  { id: 'n', name: 'Necromancer Jr' },
];
describe('shared group mention grammar', () => {
  it.each(['@José', '@山田', '@Jose\u0301', 'ask @agent-one', '@'])(
    'completes Unicode token %s',
    (value) => {
      expect(getMentionMatch(value)?.[2]).toBe(value.slice(value.lastIndexOf('@') + 1));
    },
  );
  it.each([
    'alice@example.com',
    'ops@hatchet',
    '`@hatchet',
    '`@hatchet`',
    '```js\n@hatchet',
    '~~~\n@hatchet',
    '\\@hatchet',
    '`literal`@hatchet',
  ])('treats %s as literal', (value) => {
    expect(getMentionMatch(value)).toBeNull();
    expect(groupMentionIds(value, participants)).toEqual([]);
  });
  it('recognizes Unicode, IDs, multiword names and ignores code/email occurrences', () => {
    expect(groupMentionIds('@José help @山田 and @jose', participants)).toEqual(['jose', 'yamada']);
    expect(groupMentionIds("@Hatchet's Assistant help @Necromancer Jr", participants)).toEqual([
      'assistant',
      'n',
    ]);
    expect(groupMentionIds('`@Hatchet` ops@hatchet\n@José', participants)).toEqual(['jose']);
    expect(groupMentionIds('``x ` @Hatchet``\n@José', participants)).toEqual(['jose']);
    expect(groupMentionIds('```js\n@hatchet\n```\n@José', participants)).toEqual(['jose']);
    expect(groupMentionIds('~~~\n@hatchet\n~~~\n@José', participants)).toEqual(['jose']);
    expect(groupMentionIds('@HatchetExtra @Hatchet.foo', participants)).toEqual([]);
  });
  it('preserves offsets and does not retain removed or quoted recipient intent', () => {
    const original = '`@山田`\n@José';
    expect(mentionText(original).length).toBe(original.length);
    expect(groupMentionIds(original, participants)).toEqual(['jose']);
    expect(groupMentionIds('Just text', participants)).toEqual([]);
    expect(groupMentionIds('`@José`', participants)).toEqual([]);
  });
});

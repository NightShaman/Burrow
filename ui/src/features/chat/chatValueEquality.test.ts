import { expect, it } from 'vitest';
import { chatValuesEqual, shareChatRows } from './chatValueEquality';

it('compares all JSON fields independent of object key order but preserves array order and presence', () => {
  expect(chatValuesEqual({ a: 1, b: [null, { x: 'y' }] }, { b: [null, { x: 'y' }], a: 1 })).toBe(
    true,
  );
  for (const [a, b] of [
    [[], {}],
    [
      [1, 2],
      [2, 1],
    ],
    [null, {}],
    [{ a: undefined }, {}],
    [[1], [1, 2]],
    [{ metadata: { status: 'running' } }, { metadata: { status: 'failed' } }],
  ])
    expect(chatValuesEqual(a, b)).toBe(false);
  const callback = () => {};
  expect(chatValuesEqual({ callback }, { callback })).toBe(true);
  expect(chatValuesEqual({ callback }, { callback: () => {} })).toBe(false);
});

it('shares unchanged rows without mutating either snapshot or hiding removals and updates', () => {
  const before = [
    { id: 'one', text: 'Old' },
    { id: 'two', text: 'Second' },
  ];
  expect(shareChatRows(before, structuredClone(before))).toBe(before);
  const next = shareChatRows(before, [{ id: 'one', text: 'New' }, { ...before[1] }]);
  expect(next[0]).not.toBe(before[0]);
  expect(next[1]).toBe(before[1]);
  expect(shareChatRows(before, [])).toEqual([]);
  expect(before[0].text).toBe('Old');
});

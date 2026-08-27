import { beforeEach, describe, expect, it } from 'vitest';
import { readAccountOrder, writeAccountOrder } from './accountOrderStorage';

beforeEach(() => localStorage.clear());

describe('accountOrderStorage', () => {
  it('migrates legacy arrays and removes invalid and duplicate IDs', () => {
    localStorage.setItem('order', JSON.stringify(['one', 42, 'two', 'one', '']));
    expect(readAccountOrder('order')).toEqual(['one', 'two']);
  });

  it('writes a validated versioned order with a bounded size', () => {
    writeAccountOrder('order', [...Array.from({ length: 105 }, (_, index) => `account-${index}`), 'account-1']);
    const stored = JSON.parse(localStorage.getItem('order') ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.value).toHaveLength(100);
    expect(new Set(stored.value).size).toBe(100);
  });

  it('rejects outdated and malformed versioned orders', () => {
    localStorage.setItem('order', JSON.stringify({ version: 0, value: ['one'] }));
    expect(readAccountOrder('order')).toEqual([]);
    localStorage.setItem('order', JSON.stringify({ version: 1, value: ['one', 42] }));
    expect(readAccountOrder('order')).toEqual([]);
  });
});

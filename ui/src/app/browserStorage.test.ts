import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoredValue, readStorage, removeStorage, writeStoredValue, writeStorage } from './browserStorage';

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

beforeEach(() => localStorage.clear());

describe('browser storage', () => {
  it('reads and writes validated versioned values', () => {
    writeStoredValue('example', 2, ['one', 'two']);
    expect(JSON.parse(localStorage.getItem('example') ?? '{}')).toEqual({ version: 2, value: ['one', 'two'] });
    expect(readStoredValue({ key: 'example', version: 2, fallback: [], validate: isStringArray })).toEqual(['one', 'two']);
  });

  it('rejects malformed, outdated, and invalid envelopes', () => {
    localStorage.setItem('example', '{broken');
    expect(readStoredValue({ key: 'example', version: 1, fallback: ['fallback'], validate: isStringArray })).toEqual(['fallback']);
    localStorage.setItem('example', JSON.stringify({ version: 0, value: ['old'] }));
    expect(readStoredValue({ key: 'example', version: 1, fallback: ['fallback'], validate: isStringArray })).toEqual(['fallback']);
    localStorage.setItem('example', JSON.stringify({ version: 1, value: [42] }));
    expect(readStoredValue({ key: 'example', version: 1, fallback: ['fallback'], validate: isStringArray })).toEqual(['fallback']);
  });

  it('supports validated legacy migration without accepting arbitrary values', () => {
    localStorage.setItem('example', JSON.stringify(['legacy']));
    expect(readStoredValue({ key: 'example', version: 1, fallback: [], validate: isStringArray, decodeLegacy: (_raw, parsed) => parsed as string[] })).toEqual(['legacy']);
    localStorage.setItem('example', JSON.stringify([42]));
    expect(readStoredValue({ key: 'example', version: 1, fallback: [], validate: isStringArray, decodeLegacy: (_raw, parsed) => parsed as string[] })).toEqual([]);
  });

  it('handles unavailable storage without throwing', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('full'); }),
      removeItem: vi.fn(() => { throw new Error('blocked'); }),
    } as unknown as Storage;
    expect(readStorage('example', storage)).toBeNull();
    expect(() => writeStorage('example', 'value', storage)).not.toThrow();
    expect(() => removeStorage('example', storage)).not.toThrow();
    expect(readStoredValue({ key: 'example', version: 1, fallback: ['fallback'], validate: isStringArray, storage })).toEqual(['fallback']);
  });
});

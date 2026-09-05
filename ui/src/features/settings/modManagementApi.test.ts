import { describe, expect, it } from 'vitest';
import { normalizeModManagement } from './modManagementApi';

describe('normalizeModManagement', () => {
  it('keeps valid mods and sources while ignoring malformed entries', () => {
    expect(normalizeModManagement({ mods: [{ id: 'chat', name: 'Chat', status: 'installed' }, { name: 'bad' }], sources: [{ id: 'one', url: 'https://example.test' }, { id: 'bad' }] })).toEqual({
      mods: [{ id: 'chat', name: 'Chat', status: 'installed' }],
      sources: [{ id: 'one', url: 'https://example.test' }],
    });
  });
  it('normalizes missing or invalid payloads to empty collections', () => {
    expect(normalizeModManagement(null)).toEqual({ mods: [], sources: [] });
    expect(normalizeModManagement({ mods: {}, sources: 'bad' })).toEqual({ mods: [], sources: [] });
  });
});

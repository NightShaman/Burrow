import { describe, expect, it } from 'vitest';
import { modLifecyclePath, normalizeModManagement } from './modManagementApi';

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
  it('preserves enabled state and builds encoded lifecycle paths', () => {
    expect(normalizeModManagement({ mods: [{ id: 'core/mod', name: 'Core', status: 'installed', system: true, enabled: false }] }).mods[0]).toMatchObject({ system: true, enabled: false });
    expect(modLifecyclePath('core/mod', 'enable')).toBe('/api/mod-management/core%2Fmod/enable');
    expect(modLifecyclePath('core/mod', 'disable')).toBe('/api/mod-management/core%2Fmod/disable');
    expect(modLifecyclePath('core/mod', 'uninstall')).toBe('/api/mod-management/core%2Fmod/uninstall');
  });
});

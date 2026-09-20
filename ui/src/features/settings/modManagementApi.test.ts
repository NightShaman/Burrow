import { describe, expect, it } from 'vitest';
import { isModBusyError, modLifecyclePath, normalizeModManagement } from './modManagementApi';

const emptyRefresh = { enabled: false, refreshing: false, failures: 0 };

describe('normalizeModManagement', () => {
  it('keeps valid mods, sources, and source refresh state while ignoring malformed entries', () => {
    expect(normalizeModManagement({
      sourceRefresh: { enabled: true, intervalMs: 21_600_000, staleMs: 900_000, refreshing: true, failures: 2 },
      mods: [{ id: 'chat', name: 'Chat', status: 'installed' }, { name: 'bad' }],
      sources: [{ id: 'one', url: 'https://example.test' }, { id: 'bad' }],
    })).toEqual({
      ok: undefined,
      restartRequired: false,
      sourceRefresh: { enabled: true, intervalMs: 21_600_000, staleMs: 900_000, refreshing: true, failures: 2 },
      mods: [{ id: 'chat', name: 'Chat', status: 'installed' }],
      sources: [{ id: 'one', url: 'https://example.test' }],
    });
  });
  it('normalizes missing or invalid payloads to empty collections', () => {
    expect(normalizeModManagement(null)).toEqual({ ok: undefined, restartRequired: false, sourceRefresh: emptyRefresh, mods: [], sources: [] });
    expect(normalizeModManagement({ mods: {}, sources: 'bad' })).toEqual({ ok: undefined, restartRequired: false, sourceRefresh: emptyRefresh, mods: [], sources: [] });
  });
  it('preserves enabled state and builds encoded lifecycle paths', () => {
    expect(normalizeModManagement({ mods: [{ id: 'core/mod', name: 'Core', status: 'installed', system: true, enabled: false }] }).mods[0]).toMatchObject({ system: true, enabled: false });
    expect(modLifecyclePath('core/mod', 'enable')).toBe('/api/mod-management/core%2Fmod/enable');
    expect(modLifecyclePath('core/mod', 'disable')).toBe('/api/mod-management/core%2Fmod/disable');
    expect(modLifecyclePath('core/mod', 'uninstall')).toBe('/api/mod-management/core%2Fmod/uninstall');
  });
  it('recognizes only lifecycle conflict errors as active mod work', () => {
    expect(isModBusyError(Object.assign(new Error('mod_busy'), { status: 409 }))).toBe(true);
    expect(isModBusyError(Object.assign(new Error('mod_install_in_progress'), { status: 409 }))).toBe(true);
    expect(isModBusyError(Object.assign(new Error('mod_busy'), { status: 500 }))).toBe(false);
  });
});

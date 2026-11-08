import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readStorage,
  restoreBrowserPreferences,
  writeStorage,
  removeStorage,
} from './browserStorage';
import { UiPreferenceSync } from './uiPreferences';

const syncs: UiPreferenceSync[] = [];
const theme = (value: string) => JSON.stringify({ version: 1, value });
function fixture(initial: Record<string, string> = {}) {
  let server = { ...initial };
  const send = vi.fn(async (values?: Record<string, string | null>, seedOnly = false) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (seedOnly && key in server) continue;
      if (value === null) {
        if (!seedOnly) delete server[key];
      } else server[key] = value;
    }
    return { ...server };
  });
  const sync = new UiPreferenceSync(send);
  syncs.push(sync);
  return { sync, send, server: () => server };
}
beforeEach(() => {
  restoreBrowserPreferences(null);
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  syncs.splice(0).forEach((sync) => sync.dispose());
  restoreBrowserPreferences(null);
  vi.useRealTimers();
});

describe('server-backed UI preferences', () => {
  it('migrates existing raw preferences atomically without copying caches or secrets', async () => {
    localStorage.setItem('hc.theme', 'midnight');
    localStorage.setItem('hc.leftSplit', '60');
    localStorage.setItem('hc.chatDrafts', 'private');
    localStorage.setItem('token', 'secret');
    const { sync, send, server } = fixture();
    await sync.initialize();
    expect(send).toHaveBeenNthCalledWith(2, { 'hc.theme': 'midnight', 'hc.leftSplit': '60' }, true);
    expect(server()).toEqual({ 'hc.theme': 'midnight', 'hc.leftSplit': '60' });
    expect(localStorage.getItem('token')).toBe('secret');
  });

  it('server wins over stale browser settings and a clean PC restores the same preferences', async () => {
    const saved = {
      'hc.theme': theme('hatchet'),
      'hc.leftSplit': '63',
      'hc.selectedAgentId': 'kerning',
    };
    localStorage.setItem('hc.theme', theme('midnight'));
    const { sync, send } = fixture(saved);
    await sync.initialize();
    expect(readStorage('hc.theme')).toBe(saved['hc.theme']);
    expect(send).toHaveBeenCalledTimes(1);
    sync.dispose();
    restoreBrowserPreferences(null);
    localStorage.clear();
    const second = fixture(saved);
    await second.sync.initialize();
    expect(readStorage('hc.selectedAgentId')).toBe('kerning');
    expect(readStorage('hc.leftSplit')).toBe('63');
  });

  it('uses the atomic seed response if another browser wins the first-write race', async () => {
    localStorage.setItem('hc.theme', 'midnight');
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ 'hc.theme': 'hatchet' });
    const sync = new UiPreferenceSync(send);
    syncs.push(sync);
    await sync.initialize();
    expect(readStorage('hc.theme')).toBe('hatchet');
  });

  it('coalesces changes and sends only changed keys, never mount defaults for unchanged values', async () => {
    const { sync, send } = fixture({ 'hc.theme': theme('midnight') });
    await sync.initialize();
    writeStorage('hc.theme', theme('midnight'));
    writeStorage('hc.chatDrafts', 'private');
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
    writeStorage('hc.theme', theme('hatchet'));
    writeStorage('hc.theme', theme('chaos'));
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': theme('chaos') }, false, false);
    expect(sync.getStatus()).toBe('saved');
    expect(localStorage.getItem('hc.uiPreferencesPending')).toBeNull();
  });

  it('retains newer edits made while an older save is in flight, including reverts', async () => {
    const { sync, send, server } = fixture({ 'hc.theme': 'midnight' });
    await sync.initialize();
    let resolve!: (value: Record<string, string>) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    writeStorage('hc.theme', 'hatchet');
    const first = sync.flush();
    writeStorage('hc.theme', 'midnight');
    resolve({ 'hc.theme': 'hatchet' });
    await first;
    await vi.advanceTimersByTimeAsync(1);
    expect(server()['hc.theme']).toBe('midnight');
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': 'midnight' }, false, false);
  });

  it('retries failed saves without overwriting newer values and reports the failure', async () => {
    const { sync, send, server } = fixture();
    await sync.initialize();
    send.mockRejectedValueOnce(new Error('offline'));
    writeStorage('hc.theme', 'midnight');
    await sync.flush();
    expect(sync.getStatus()).toBe('error');
    writeStorage('hc.theme', 'hatchet');
    await vi.advanceTimersByTimeAsync(1000);
    expect(server()['hc.theme']).toBe('hatchet');
    expect(sync.getStatus()).toBe('saved');
  });

  it('restores a retry journal after reload and sends it as explicit edits, not seed-only migration', async () => {
    localStorage.setItem(
      'hc.uiPreferencesPending',
      JSON.stringify({ 'hc.theme': 'hatchet', token: 'never' }),
    );
    const { sync, send, server } = fixture({ 'hc.theme': 'midnight' });
    await sync.initialize();
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': 'hatchet' });
    expect(server()).toEqual({ 'hc.theme': 'hatchet' });
    expect(readStorage('hc.theme')).toBe('hatchet');
  });

  it('does not mount or seed defaults after a failed GET, and initialization can be retried', async () => {
    const { sync, send } = fixture();
    localStorage.setItem('hc.theme', 'midnight');
    send.mockRejectedValueOnce(new Error('unavailable'));
    await expect(sync.initialize()).rejects.toThrow('unavailable');
    expect(send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('hc.theme')).toBe('midnight');
    await sync.initialize();
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': 'midnight' }, true);
  });

  it('shares concurrent initialization and keeps the restored copy when browser storage is blocked', async () => {
    const { sync, send } = fixture({ 'hc.theme': 'midnight' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const a = sync.initialize(),
      b = sync.initialize();
    expect(a).toBe(b);
    await a;
    expect(send).toHaveBeenCalledTimes(1);
    expect(readStorage('hc.theme')).toBe('midnight');
    writeStorage('hc.theme', 'hatchet');
    await sync.flush();
    expect(readStorage('hc.theme')).toBe('hatchet');
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': 'hatchet' }, false, false);
  });

  it('flushes on pagehide using keepalive and persists deletion as a per-key patch', async () => {
    const { sync, send } = fixture({ 'hc.theme': 'midnight' });
    await sync.initialize();
    removeStorage('hc.theme');
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({ 'hc.theme': null }, false, true);
  });
});

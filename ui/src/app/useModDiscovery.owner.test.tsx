import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadModPanels, modsChangedEvent, type ModPanel } from './modPanels';
import { useModDiscovery } from './useModDiscovery';
vi.mock('./modPanels', () => ({ loadModPanels: vi.fn(), modsChangedEvent: 'mods-changed-test' }));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('orders overlapping initial, event and polling reads and removes listeners on unmount', async () => {
  vi.useFakeTimers();
  const first = deferred<ModPanel[]>(),
    second = deferred<ModPanel[]>(),
    third = deferred<ModPanel[]>();
  vi.mocked(loadModPanels)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const { result, unmount } = renderHook(() => useModDiscovery());
  expect(result.current.modsLoaded).toBe(false);
  act(() => window.dispatchEvent(new Event(modsChangedEvent)));
  act(() => vi.advanceTimersByTime(30000));
  expect(loadModPanels).toHaveBeenCalledTimes(3);
  const newest = [{ id: 'new' }] as unknown as ModPanel[];
  await act(async () => {
    third.resolve(newest);
    await third.promise;
  });
  await act(async () => {
    first.resolve([]);
    second.resolve([]);
    await Promise.all([first.promise, second.promise]);
  });
  expect(result.current).toEqual({ modPanels: newest, modsLoaded: true });
  unmount();
  act(() => {
    window.dispatchEvent(new Event(modsChangedEvent));
    vi.advanceTimersByTime(60000);
  });
  expect(loadModPanels).toHaveBeenCalledTimes(3);
});

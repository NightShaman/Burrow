import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadModDiscovery, modsChangedEvent, type ModPanel } from './modPanels';
import { useModDiscovery } from './useModDiscovery';
vi.mock('./modPanels', () => ({
  loadModDiscovery: vi.fn(),
  modsChangedEvent: 'mods-changed-test',
}));
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
  const first = deferred<Awaited<ReturnType<typeof loadModDiscovery>>>(),
    second = deferred<Awaited<ReturnType<typeof loadModDiscovery>>>(),
    third = deferred<Awaited<ReturnType<typeof loadModDiscovery>>>();
  vi.mocked(loadModDiscovery)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const { result, unmount } = renderHook(() => useModDiscovery());
  expect(result.current.modsLoaded).toBe(false);
  act(() => window.dispatchEvent(new Event(modsChangedEvent)));
  act(() => vi.advanceTimersByTime(30000));
  expect(loadModDiscovery).toHaveBeenCalledTimes(3);
  const newest = [{ id: 'new' }] as unknown as ModPanel[];
  await act(async () => {
    third.resolve({
      modPanels: newest,
      modArchives: [{ modId: 'new', name: 'New', archiveUrl: '/new' }],
    });
    await third.promise;
  });
  await act(async () => {
    first.resolve({ modPanels: [], modArchives: [] });
    second.resolve({ modPanels: [], modArchives: [] });
    await Promise.all([first.promise, second.promise]);
  });
  expect(result.current).toEqual({
    modPanels: newest,
    modArchives: [{ modId: 'new', name: 'New', archiveUrl: '/new' }],
    modsLoaded: true,
  });
  unmount();
  act(() => {
    window.dispatchEvent(new Event(modsChangedEvent));
    vi.advanceTimersByTime(60000);
  });
  expect(loadModDiscovery).toHaveBeenCalledTimes(3);
});

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useModsManagement } from './useModsManagement';
import * as api from './modManagementApi';
vi.mock('./modManagementApi', async (original) => ({
  ...(await original<typeof import('./modManagementApi')>()),
  loadModManagement: vi.fn(),
  modManagementAction: vi.fn(),
  loadSecretReferences: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const catalog = { mods: [], sources: [], restartRequired: false };
it('keeps busy through post-submit catalog reload and merges restart signals only after reload', async () => {
  let resolve!: (value: typeof catalog) => void;
  vi.mocked(api.loadModManagement)
    .mockResolvedValueOnce(catalog)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  vi.mocked(api.modManagementAction).mockResolvedValue({ restartRequired: true });
  const { result } = renderHook(() => useModsManagement('installed'));
  await waitFor(() => expect(api.loadModManagement).toHaveBeenCalledTimes(1));
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = result.current.run('alpha', '/install');
  });
  expect(result.current.busy).toBe('alpha');
  expect(result.current.state.restartRequired).toBe(false);
  await act(async () => {
    resolve(catalog);
    await pending;
  });
  expect(result.current.busy).toBeNull();
  expect(result.current.state.restartRequired).toBe(true);
});
it('preserves the source draft across section changes and preserves it after ambiguous failed submission', async () => {
  vi.mocked(api.loadModManagement).mockResolvedValue(catalog);
  vi.mocked(api.loadSecretReferences).mockResolvedValue([]);
  vi.mocked(api.modManagementAction).mockRejectedValue(new Error('discovery'));
  const { result, rerender } = renderHook(({ section }) => useModsManagement(section), {
    initialProps: { section: 'sources' as 'sources' | 'installed' },
  });
  await act(async () => {});
  act(() => result.current.setSourceUrl('https://example.com/mod'));
  rerender({ section: 'installed' });
  rerender({ section: 'sources' });
  expect(result.current.sourceUrl).toBe('https://example.com/mod');
  await act(async () => {
    await result.current.addSource();
  });
  expect(result.current.sourceUrl).toBe('https://example.com/mod');
  expect(result.current.error).toBe(
    'Could not add mod source. Check the repository URL and credentials.',
  );
  expect(result.current.busy).toBeNull();
});

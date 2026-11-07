import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, importExport } from '../../app/api';
import { useFirstRunWorkflow } from './useFirstRunWorkflow';
vi.mock('../../app/api', () => ({ api: vi.fn(), importExport: vi.fn() }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const options = () => ({
  operatorName: 'Operator',
  operatorAvatar: '',
  name: 'Agent',
  avatar: '',
  soul: 'Soul',
  connectionId: '',
  model: '',
  onSelect: vi.fn(),
  onAgentsChanged: vi.fn(async () => {}),
  onModelConnectionsChanged: vi.fn(async () => {}),
  onOperatorProfileChanged: vi.fn(),
  onSetupComplete: vi.fn(async () => {}),
  setError: vi.fn(),
  setCelebrating: vi.fn(),
});
const file = { arrayBuffer: async () => new Uint8Array([0, 255, 65]).buffer } as File;
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});
describe('first-run workflow characterization', () => {
  it('retains exact operation JSON and ID across failure, edited form and retry', async () => {
    const props = options();
    vi.mocked(api)
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ agent: { id: 'agent' } });
    const { result, rerender } = renderHook((p) => useFirstRunWorkflow(p), { initialProps: props });
    await act(async () => {
      await result.current.finish();
    });
    const bytes = vi.mocked(api).mock.calls[0][1]?.body;
    expect(localStorage.getItem('hc.setupOperation')).toBe(bytes);
    rerender({ ...props, name: 'Changed', soul: 'Changed' });
    await act(async () => {
      await result.current.finish();
    });
    expect(vi.mocked(api).mock.calls[1][1]?.body).toBe(bytes);
    expect(localStorage.getItem('hc.setupOperation')).toBeNull();
    expect(props.onSelect).toHaveBeenCalledWith('agent');
  });
  it.each(['reset', 'unmount'])(
    'invalidates late submission callbacks on %s but completes retained operation',
    async (mode) => {
      const props = options();
      const pending = deferred<{ agent: { id: string } }>();
      vi.mocked(api).mockReturnValue(pending.promise);
      const { result, unmount } = renderHook(() => useFirstRunWorkflow(props));
      let work!: Promise<void>;
      act(() => {
        work = result.current.finish();
      });
      act(() => {
        void result.current.finish();
      });
      expect(api).toHaveBeenCalledTimes(1);
      if (mode === 'reset') act(() => result.current.resetWorkflow());
      else unmount();
      await act(async () => {
        pending.resolve({ agent: { id: 'agent' } });
        await work;
      });
      expect(localStorage.getItem('hc.setupOperation')).toBeNull();
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onAgentsChanged).not.toHaveBeenCalled();
    },
  );
  it('preserves unguarded late preview -> commit after reset (not a cancellation bugfix)', async () => {
    const props = options();
    const preview = deferred<Record<string, unknown>>();
    vi.mocked(importExport)
      .mockReturnValueOnce(preview.promise as ReturnType<typeof importExport>)
      .mockResolvedValueOnce({} as never);
    const { result } = renderHook(() => useFirstRunWorkflow(props));
    let work!: Promise<void>;
    await act(async () => {
      work = result.current.readImportFile(file);
      await Promise.resolve();
    });
    act(() => result.current.resetWorkflow());
    await act(async () => {
      preview.resolve({});
      await work;
    });
    expect(importExport).toHaveBeenNthCalledWith(1, { payload: 'AP9B' }, true);
    expect(importExport).toHaveBeenNthCalledWith(2, {
      payload: 'AP9B',
      confirm: true,
      conflictPolicy: 'replace',
    });
    expect(props.onSetupComplete).toHaveBeenCalledTimes(1);
    expect(props.setCelebrating).toHaveBeenCalledWith(true);
  });
  it('retains protected bytes/password on failed commit and clears them on successful retry', async () => {
    const props = options();
    vi.mocked(importExport)
      .mockResolvedValueOnce({ encrypted: true } as never)
      .mockRejectedValueOnce(new Error('import_password_required'))
      .mockResolvedValueOnce({} as never);
    const { result } = renderHook(() => useFirstRunWorkflow(props));
    await act(async () => {
      await result.current.readImportFile(file);
    });
    act(() => result.current.setImportPassword(' secret '));
    await act(async () => {
      await result.current.submitProtectedImport();
    });
    expect(props.setError).toHaveBeenLastCalledWith('Password required.');
    expect(result.current.importPayload).toBe('AP9B');
    await act(async () => {
      await result.current.submitProtectedImport();
    });
    expect(vi.mocked(importExport).mock.calls[1]).toEqual(vi.mocked(importExport).mock.calls[2]);
    expect(vi.mocked(importExport).mock.calls[2][0]).toEqual({
      payload: 'AP9B',
      password: ' secret ',
      confirm: true,
      conflictPolicy: 'replace',
    });
    expect(result.current.importPayload).toBe('');
    expect(result.current.importPassword).toBe('');
  });
  it('preserves late protected commit completion after reset', async () => {
    const props = options();
    const commit = deferred<Record<string, unknown>>();
    vi.mocked(importExport)
      .mockResolvedValueOnce({ requiresPassword: true } as never)
      .mockReturnValueOnce(commit.promise as ReturnType<typeof importExport>);
    const { result } = renderHook(() => useFirstRunWorkflow(props));
    await act(async () => {
      await result.current.readImportFile(file);
    });
    act(() => result.current.setImportPassword('password'));
    let work!: Promise<void>;
    act(() => {
      work = result.current.submitProtectedImport();
    });
    act(() => result.current.resetWorkflow());
    await act(async () => {
      commit.resolve({});
      await work;
    });
    expect(result.current.imported).toBe(true);
    expect(props.onSetupComplete).toHaveBeenCalledTimes(1);
  });
});

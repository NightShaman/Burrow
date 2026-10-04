import { act, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import type { Tab } from '../../app/types';
import { useWorkspaceFiles } from './useWorkspaceFiles';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

const setTabs: Dispatch<SetStateAction<Tab[]>> = vi.fn();
const setActiveTabId: Dispatch<SetStateAction<string>> = vi.fn();

describe('useWorkspaceFiles', () => {
  beforeEach(() => {
    apiForTargetMock.mockReset();
  });

  it('does not poll until the workspace panel becomes visible', async () => {
    apiForTargetMock.mockResolvedValue({ files: [{ path: 'visible.txt', type: 'file' as const }] });

    const { result, rerender } = renderHook(
      ({ pollingEnabled }) => useWorkspaceFiles({ selectedAgentId: 'agent-a', targets: [localApiTarget], setTabs, setActiveTabId, pollingEnabled }),
      { initialProps: { pollingEnabled: false } },
    );

    await act(async () => { await Promise.resolve(); });
    expect(apiForTargetMock).not.toHaveBeenCalled();
    expect(result.current.workspaceFiles).toEqual([]);

    rerender({ pollingEnabled: true });

    await waitFor(() => expect(result.current.workspaceFiles).toEqual([{ name: 'visible.txt', path: 'visible.txt', type: 'file' }]));
    expect(apiForTargetMock).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild the tree when a poll returns the same flat listing', async () => {
    vi.useFakeTimers();
    try {
      apiForTargetMock.mockResolvedValue({ files: [{ path: 'stable.txt', type: 'file' as const }] });

      const { result, unmount } = renderHook(() => useWorkspaceFiles({ selectedAgentId: 'agent-a', targets: [localApiTarget], setTabs, setActiveTabId }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const initialTree = result.current.workspaceFiles;
      apiForTargetMock.mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

      expect(apiForTargetMock).toHaveBeenCalledTimes(1);
      expect(result.current.workspaceFiles).toBe(initialTree);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a previous agent response replace the selected agent workspace', async () => {
    const firstAgent = deferred<{ files: Array<{ path: string; type: 'file' }> }>();
    apiForTargetMock.mockImplementation(async (_target, path) => {
      if (path.includes('agentId=agent-a')) return firstAgent.promise;
      if (path.includes('agentId=agent-b')) return { files: [{ path: 'agent-b.txt', type: 'file' as const }] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result, rerender } = renderHook(
      ({ selectedAgentId }) => useWorkspaceFiles({ selectedAgentId, targets: [localApiTarget], setTabs, setActiveTabId }),
      { initialProps: { selectedAgentId: 'agent-a' } },
    );
    await waitFor(() => expect(apiForTargetMock).toHaveBeenCalledWith(localApiTarget, expect.stringContaining('agentId=agent-a')));

    rerender({ selectedAgentId: 'agent-b' });
    await waitFor(() => expect(result.current.workspaceFiles).toEqual([{ name: 'agent-b.txt', path: 'agent-b.txt', type: 'file' }]));

    await act(async () => {
      firstAgent.resolve({ files: [{ path: 'agent-a.txt', type: 'file' }] });
      await firstAgent.promise;
    });

    expect(result.current.workspaceFiles).toEqual([{ name: 'agent-b.txt', path: 'agent-b.txt', type: 'file' }]);
  });

  it('saves a remote tab to its stored owner across node switches and rejects missing owners', async () => {
    const remote: ApiTarget = { id: 'remote-a', name: 'Remote A', baseUrl: 'https://remote.test', enabled: true };
    const tab: Tab = { id: 'remote-a::agent-a:shared.txt', label: 'shared.txt', kind: 'file', fileLoaded: true, path: 'shared.txt', workspaceAgentId: 'remote-a::agent-a', targetId: remote.id };
    apiForTargetMock.mockResolvedValue({ content: 'saved' });
    const { result, rerender } = renderHook(({ targets }) => useWorkspaceFiles({ selectedAgentId: 'agent-a', targets, setTabs, setActiveTabId, pollingEnabled: false }), { initialProps: { targets: [localApiTarget, remote] } });
    await act(async () => { await result.current.saveFile(tab, 'first'); });
    expect(apiForTargetMock).toHaveBeenCalledWith(remote, '/api/workspace/file', expect.objectContaining({ body: JSON.stringify({ agentId: 'agent-a', scope: 'agent', path: 'shared.txt', content: 'first' }) }));
    apiForTargetMock.mockClear();
    rerender({ targets: [localApiTarget] });
    await expect(result.current.saveFile(tab, 'second')).rejects.toThrow();
    expect(apiForTargetMock).not.toHaveBeenCalled();
  });

  it('opens remote A then saves its tab after selection moves through Local to remote B with the complete catalog', async () => {
    const a: ApiTarget = { id: 'remote-a', name: 'A', baseUrl: 'https://a.test', enabled: true };
    const b: ApiTarget = { id: 'remote-b', name: 'B', baseUrl: 'https://b.test', enabled: true };
    const tabs: Tab[] = [];
    const updateTabs: Dispatch<SetStateAction<Tab[]>> = (change) => {
      tabs.splice(0, tabs.length, ...(typeof change === 'function' ? change(tabs) : change));
    };
    apiForTargetMock.mockImplementation(async (_target, _path, options) => options ? { content: 'saved A' } : { content: 'opened A' });
    const { result, rerender } = renderHook(({ selectedAgentId }) => useWorkspaceFiles({ selectedAgentId, targets: [localApiTarget, a, b], setTabs: updateTabs, setActiveTabId, pollingEnabled: false }), { initialProps: { selectedAgentId: 'remote-a::same-agent' } });
    await act(async () => { await result.current.openFile({ name: 'same.txt', path: 'same.txt', type: 'file' }); });
    expect(tabs[0]).toMatchObject({ targetId: a.id, workspaceAgentId: 'remote-a::same-agent', content: 'opened A' });
    rerender({ selectedAgentId: 'same-agent' });
    rerender({ selectedAgentId: 'remote-b::same-agent' });
    apiForTargetMock.mockClear();
    await act(async () => { await result.current.saveFile(tabs[0], 'draft A'); });
    expect(apiForTargetMock).toHaveBeenCalledExactlyOnceWith(a, '/api/workspace/file', expect.objectContaining({ body: JSON.stringify({ agentId: 'same-agent', scope: 'agent', path: 'same.txt', content: 'draft A' }) }));
    expect(tabs[0].content).toBe('saved A');
  });

  it('saves local tabs and fails closed for unavailable or inconsistent owners', async () => {
    const remote: ApiTarget = { id: 'remote-a', name: 'A', baseUrl: 'https://a.test', enabled: true };
    const disabled = { ...remote, enabled: false };
    const local: Tab = { id: 'agent:same.txt', label: 'same.txt', kind: 'file', fileLoaded: true, path: 'same.txt', workspaceAgentId: 'agent', targetId: 'local' };
    const { result, rerender } = renderHook(({ targets }) => useWorkspaceFiles({ selectedAgentId: 'remote-a::agent', targets, setTabs, setActiveTabId, pollingEnabled: false }), { initialProps: { targets: [localApiTarget, remote] } });
    apiForTargetMock.mockResolvedValue({ content: 'local saved' });
    await act(async () => { await result.current.saveFile(local, 'local draft'); });
    expect(apiForTargetMock).toHaveBeenCalledExactlyOnceWith(localApiTarget, '/api/workspace/file', expect.objectContaining({ body: JSON.stringify({ agentId: 'agent', scope: 'agent', path: 'same.txt', content: 'local draft' }) }));
    apiForTargetMock.mockClear();
    const remoteTab: Tab = { ...local, id: 'remote-a::agent:same.txt', workspaceAgentId: 'remote-a::agent', targetId: remote.id };
    for (const targets of [[localApiTarget, disabled], [localApiTarget]]) {
      rerender({ targets });
      await expect(result.current.saveFile(remoteTab, 'draft')).rejects.toThrow();
    }
    rerender({ targets: [localApiTarget, remote] });
    for (const tab of [{ ...remoteTab, targetId: 'local' }, { ...remoteTab, targetId: undefined }, { ...remoteTab, workspaceAgentId: undefined }, { ...remoteTab, path: undefined }]) {
      await expect(result.current.saveFile(tab, 'draft')).rejects.toThrow();
    }
    expect(apiForTargetMock).not.toHaveBeenCalled();
  });

  it('preserves tabs after network failure and retries the original remote owner despite selected B', async () => {
    const a: ApiTarget = { id: 'remote-a', name: 'A', baseUrl: 'https://a.test', enabled: true };
    const b: ApiTarget = { id: 'remote-b', name: 'B', baseUrl: 'https://b.test', enabled: true };
    const tab: Tab = { id: 'remote-a::agent:same.txt', label: 'same.txt', kind: 'file', fileLoaded: true, path: 'same.txt', workspaceAgentId: 'remote-a::agent', targetId: a.id, content: 'draft' };
    let tabs = [tab];
    const updateTabs: Dispatch<SetStateAction<Tab[]>> = (change) => { tabs = typeof change === 'function' ? change(tabs) : change; };
    const { result, rerender } = renderHook(({ selectedAgentId }) => useWorkspaceFiles({ selectedAgentId, targets: [localApiTarget, a, b], setTabs: updateTabs, setActiveTabId, pollingEnabled: false }), { initialProps: { selectedAgentId: 'remote-a::agent' } });
    apiForTargetMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ content: 'saved' });
    await expect(result.current.saveFile(tab, 'draft')).rejects.toThrow('offline');
    expect(tabs).toEqual([tab]);
    rerender({ selectedAgentId: 'remote-b::agent' });
    await act(async () => { await result.current.saveFile(tab, 'draft'); });
    expect(apiForTargetMock).toHaveBeenCalledTimes(2);
    expect(apiForTargetMock.mock.calls.map(([target]) => target)).toEqual([a, a]);
    expect(tabs[0].content).toBe('saved');
  });

  it('commits a deferred A save only to the original tab after switching to same-path B', async () => {
    const a: ApiTarget = { id: 'remote-a', name: 'A', baseUrl: 'https://a.test', enabled: true };
    const b: ApiTarget = { id: 'remote-b', name: 'B', baseUrl: 'https://b.test', enabled: true };
    const original: Tab = { id: 'remote-a::agent:same.txt', label: 'same.txt', kind: 'file', fileLoaded: true, path: 'same.txt', workspaceAgentId: 'remote-a::agent', targetId: a.id, content: 'A draft' };
    let tabs: Tab[] = [original];
    const updateTabs: Dispatch<SetStateAction<Tab[]>> = (change) => { tabs = typeof change === 'function' ? change(tabs) : change; };
    const pending = deferred<{ content: string }>();
    apiForTargetMock.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ selectedAgentId }) => useWorkspaceFiles({ selectedAgentId, targets: [localApiTarget, a, b], setTabs: updateTabs, setActiveTabId, pollingEnabled: false }), { initialProps: { selectedAgentId: 'remote-a::agent' } });
    let save!: Promise<void>;
    act(() => { save = result.current.saveFile(original, 'A draft'); });
    rerender({ selectedAgentId: 'remote-b::agent' });
    tabs = [...tabs, { ...original, id: 'remote-b::agent:same.txt', workspaceAgentId: 'remote-b::agent', targetId: b.id, content: 'B draft' }, { ...original, id: 'agent:same.txt', workspaceAgentId: 'agent', targetId: 'local', content: 'local draft' }];
    await act(async () => { pending.resolve({ content: 'A saved' }); await save; });
    expect(apiForTargetMock).toHaveBeenCalledExactlyOnceWith(a, '/api/workspace/file', expect.objectContaining({ body: JSON.stringify({ agentId: 'agent', scope: 'agent', path: 'same.txt', content: 'A draft' }) }));
    expect(tabs.map((item) => item.content)).toEqual(['A saved', 'B draft', 'local draft']);
  });

});

it('reuses a loaded dirty tab without fetching or replacing its draft', async () => {
  const tabs: Tab[] = [];
  const update: Dispatch<SetStateAction<Tab[]>> = change => { tabs.splice(0, tabs.length, ...(typeof change === 'function' ? change(tabs) : change)); };
  apiForTargetMock.mockResolvedValue({ content: 'server' });
  const { result } = renderHook(() => useWorkspaceFiles({ selectedAgentId: 'agent-a', targets: [localApiTarget], tabs, setTabs: update, setActiveTabId, pollingEnabled: false }));
  const file = { name: 'a.txt', path: 'a.txt', type: 'file' as const };
  await act(async () => { await result.current.openFile(file); });
  tabs[0] = { ...tabs[0], content: 'draft' };
  await act(async () => { await result.current.openFile(file); });
  expect(tabs[0].content).toBe('draft');
  expect(apiForTargetMock).toHaveBeenCalledTimes(1);
});

it('does not overwrite an edit made while a read is pending', async () => {
  const tabs: Tab[] = [];
  const update: Dispatch<SetStateAction<Tab[]>> = change => { tabs.splice(0, tabs.length, ...(typeof change === 'function' ? change(tabs) : change)); };
  const read = deferred<{ content: string }>();
  apiForTargetMock.mockReturnValue(read.promise);
  const { result } = renderHook(() => useWorkspaceFiles({ selectedAgentId: 'agent-a', targets: [localApiTarget], tabs, setTabs: update, setActiveTabId, pollingEnabled: false }));
  let opening!: Promise<void>;
  act(() => { opening = result.current.openFile({ name: 'a', path: 'a', type: 'file' }); });
  tabs[0] = { ...tabs[0], content: 'new edit' };
  await act(async () => { read.resolve({ content: 'old server' }); await opening; });
  expect(tabs[0].content).toBe('new edit');
});

it('blocks pending and failed writes and retries a failed read successfully', async () => {
  const tabs: Tab[] = [];
  const update: Dispatch<SetStateAction<Tab[]>> = change => { tabs.splice(0, tabs.length, ...(typeof change === 'function' ? change(tabs) : change)); };
  let reject!: (error: Error) => void;
  apiForTargetMock.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const { result } = renderHook(() => useWorkspaceFiles({ tabs, selectedAgentId: 'agent-a', targets: [localApiTarget], setTabs: update, setActiveTabId, pollingEnabled: false }));
  const file = { name: 'a', path: 'a', type: 'file' as const };
  let opening!: Promise<void>;
  act(() => { opening = result.current.openFile(file); });
  await expect(result.current.saveFile(tabs[0], 'bad')).rejects.toThrow('not loaded');
  await act(async () => { reject(new Error('offline')); await opening; });
  expect(tabs[0].content).toBe('');
  expect((tabs[0] as Tab & { fileError?: string }).fileError).toContain('offline');
  await expect(result.current.saveFile(tabs[0], 'bad')).rejects.toThrow('not loaded');
  expect(apiForTargetMock).toHaveBeenCalledTimes(1);
  apiForTargetMock.mockResolvedValue({ content: 'success' });
  await act(async () => { await result.current.openFile(file); });
  expect(tabs[0]).toMatchObject({ content: 'success', fileLoaded: true, fileError: undefined });
  await act(async () => { await result.current.saveFile(tabs[0], 'success'); });
  expect(apiForTargetMock).toHaveBeenCalledTimes(3);
});

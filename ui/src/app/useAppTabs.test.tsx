import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { groupTabsStorageKey, readPersistedGroupTabs, useAppTabs } from './useAppTabs';

beforeEach(() => localStorage.clear());

describe('persisted app tabs', () => {
  it('migrates valid legacy group tabs and rejects malformed entries', () => {
    localStorage.setItem(groupTabsStorageKey, JSON.stringify([
      { id: 'group:one', label: 'One', kind: 'group', channelId: 'one', targetId: 'node-1' },
      { id: 'file', label: 'Not persisted here', kind: 'file', path: '/tmp/file' },
      { id: 'broken', label: 'Broken', kind: 'group' },
    ]));
    expect(readPersistedGroupTabs()).toEqual([
      { id: 'group:one', label: 'One', kind: 'group', channelId: 'one', targetId: 'node-1' },
    ]);
  });

  it('falls back when the versioned payload is outdated or invalid', () => {
    localStorage.setItem(groupTabsStorageKey, JSON.stringify({ version: 0, value: [{ id: 'old', label: 'Old', kind: 'group', channelId: 'old' }] }));
    expect(readPersistedGroupTabs()).toEqual([]);
    localStorage.setItem(groupTabsStorageKey, JSON.stringify({ version: 1, value: [{ id: 'bad', label: 'Bad', kind: 'group' }] }));
    expect(readPersistedGroupTabs()).toEqual([]);
  });

  it('persists only group tabs in a versioned payload', async () => {
    const { result } = renderHook(() => useAppTabs());
    act(() => result.current.setTabs((tabs) => [...tabs,
      { id: 'file:/tmp/a', label: 'a', kind: 'file', path: '/tmp/a' },
      { id: 'group:node-1:one', label: 'One', kind: 'group', channelId: 'one', targetId: 'node-1' },
    ]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(groupTabsStorageKey) ?? '{}')).toEqual({
      version: 1,
      value: [{ id: 'group:node-1:one', label: 'One', kind: 'group', channelId: 'one', targetId: 'node-1' }],
    }));
  });
});

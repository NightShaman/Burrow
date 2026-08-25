import { useEffect, useState } from 'react';
import type { Tab } from './types';
import { writeStorage } from './usePersistedLayout';

const groupTabsStorageKey = 'hc.groupChatTabs';

function readPersistedGroupTabs(): Tab[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(groupTabsStorageKey) ?? '[]');
    if (!Array.isArray(stored)) return [];

    return stored.filter((tab): tab is Tab => (
      Boolean(tab)
      && typeof tab === 'object'
      && (tab as Tab).kind === 'group'
      && typeof (tab as Tab).id === 'string'
      && typeof (tab as Tab).channelId === 'string'
      && typeof (tab as Tab).label === 'string'
    ));
  } catch {
    return [];
  }
}

export function useAppTabs() {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: 'chat', label: 'Chat', kind: 'chat' },
    ...readPersistedGroupTabs(),
  ]);
  const [activeTabId, setActiveTabId] = useState('chat');

  useEffect(() => {
    writeStorage(groupTabsStorageKey, JSON.stringify(tabs.filter((tab) => tab.kind === 'group')));
  }, [tabs]);

  return { tabs, setTabs, activeTabId, setActiveTabId };
}

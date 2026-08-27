import { useEffect, useState } from 'react';
import { readStoredValue, writeStoredValue } from './browserStorage';
import type { Tab } from './types';

export const groupTabsStorageKey = 'hc.groupChatTabs';
const groupTabsStorageVersion = 1;

function isGroupTab(value: unknown): value is Tab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Partial<Tab>;
  return tab.kind === 'group'
    && typeof tab.id === 'string'
    && typeof tab.channelId === 'string'
    && typeof tab.label === 'string'
    && (tab.targetId === undefined || typeof tab.targetId === 'string');
}

const isGroupTabList = (value: unknown): value is Tab[] => Array.isArray(value) && value.every(isGroupTab);

export function readPersistedGroupTabs(storage?: Storage | null): Tab[] {
  return readStoredValue({
    key: groupTabsStorageKey,
    version: groupTabsStorageVersion,
    fallback: [],
    validate: isGroupTabList,
    decodeLegacy: (_raw, parsed) => Array.isArray(parsed) ? parsed.filter(isGroupTab) : undefined,
    storage,
  });
}

export function useAppTabs() {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: 'chat', label: 'Chat', kind: 'chat' },
    ...readPersistedGroupTabs(),
  ]);
  const [activeTabId, setActiveTabId] = useState('chat');

  useEffect(() => {
    writeStoredValue(groupTabsStorageKey, groupTabsStorageVersion, tabs.filter((tab) => tab.kind === 'group'));
  }, [tabs]);

  return { tabs, setTabs, activeTabId, setActiveTabId };
}

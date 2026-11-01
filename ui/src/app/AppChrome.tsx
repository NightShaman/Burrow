import { ProviderPoolMetrics } from './ProviderPoolMetrics';
import { rovingKeys } from './keyboardWidgets';
import type { Tab } from './types';

type DocumentTabsProps = {
  tabs: Tab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
};

export function DocumentTabs({ tabs, activeTabId, onSelect, onClose }: DocumentTabsProps) {
  return <div className="document-tabs" role="tablist" aria-label="Open documents" onKeyDown={event => rovingKeys(event, '[role="tab"]')}>
    {tabs.map((tab) => {
      const active = activeTabId === tab.id;
      const closeable = tab.kind === 'file' || tab.kind === 'group';
      return <div className={`document-tab${active ? ' active' : ''}${closeable ? ' closeable' : ''}`} key={tab.id}>
        <button className="document-tab-select" type="button" role="tab" tabIndex={active ? 0 : -1} aria-selected={active} onClick={() => onSelect(tab.id)}>{tab.label}</button>
        {closeable && <button className="document-tab-close" type="button" onClick={() => onClose(tab.id)} aria-label={`Close ${tab.label}`}>×</button>}
      </div>;
    })}
  </div>;
}

export function AppStatusBar({ runtimeVersion, registryStale }: { runtimeVersion?: string | null; registryStale?: boolean }) {
  return <footer className="status-bar">
    {registryStale && <span className="registry-stale" role="status" title="Agent registry refresh failed; showing the last known agents.">Agents stale</span>}
    <ProviderPoolMetrics />
    <span className="status-version">v. {runtimeVersion ?? '—'}</span>
  </footer>;
}

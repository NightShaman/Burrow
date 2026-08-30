import type { AnthropicUsage, OpenAiUsage } from './api';
import type { Tab } from './types';
import { formatUsageReset } from './useRuntimeDashboard';

type DocumentTabsProps = {
  tabs: Tab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
};

export function DocumentTabs({ tabs, activeTabId, onSelect, onClose }: DocumentTabsProps) {
  return <div className="document-tabs" role="tablist" aria-label="Open documents">
    {tabs.map((tab) => {
      const active = activeTabId === tab.id;
      const closeable = tab.kind === 'file' || tab.kind === 'group';
      return <div className={`document-tab${active ? ' active' : ''}${closeable ? ' closeable' : ''}`} key={tab.id}>
        <button className="document-tab-select" type="button" role="tab" aria-selected={active} onClick={() => onSelect(tab.id)}>{tab.label}</button>
        {closeable && <button className="document-tab-close" type="button" onClick={() => onClose(tab.id)} aria-label={`Close ${tab.label}`}>×</button>}
      </div>;
    })}
  </div>;
}

type UsageMeterProps = {
  label: string;
  usedPercent: number;
  resetAt?: string | null;
};

function UsageMeter({ label, usedPercent, resetAt }: UsageMeterProps) {
  const remaining = Math.round(100 - Math.min(100, Math.max(0, usedPercent)));
  return <span className="usage-meter">
    <span className="usage-meter-label">{label}</span>
    <span className="usage-meter-track" role="progressbar" aria-label={`${label} usage remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
      <span className="usage-meter-fill" style={{ width: `${remaining}%` }} />
    </span>
    <span className="usage-meter-value">{remaining}% <span className="usage-meter-reset">{formatUsageReset(resetAt)}</span></span>
  </span>;
}

export function AppStatusBar({ anthropicUsage, openAiUsage, runtimeVersion, registryStale }: { anthropicUsage: AnthropicUsage | null; openAiUsage: OpenAiUsage | null; runtimeVersion: string | null; registryStale?: boolean }) {
  return <footer className="status-bar">
    {registryStale && <span className="registry-stale" role="status" title="Agent registry refresh failed; showing the last known agents.">Agents stale</span>}
    {anthropicUsage?.windows
      .filter((window) => window.key === 'five_hour' || window.key === 'seven_day')
      .map((window) => <UsageMeter key={window.key} label={window.key === 'five_hour' ? '5hr' : '7day'} usedPercent={window.usedPercent} resetAt={window.resetAt} />)}
    {openAiUsage?.windows
      .filter((window) => window.usedPercent != null)
      .map((window) => <UsageMeter key={`openai-${window.key}`} label={window.label} usedPercent={window.usedPercent!} resetAt={window.resetAt} />)}
    <span className="status-version">v. {runtimeVersion ?? '—'}</span>
  </footer>;
}

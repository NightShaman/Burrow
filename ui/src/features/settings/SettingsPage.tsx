import { useEffect, useState } from 'react';
import type { Agent, PanelId, SavedProvider, SettingsTab } from '../../app/types';
import { api, type SetupStatus } from '../../app/api';
import { themes, themeDetails } from '../../app/usePersistedLayout';
import { panelRegistry } from '../../app/panelRegistry';
import type { Theme } from '../../app/usePersistedLayout';
import { AgentToolbar } from './AgentToolbar';
import { ModelConnections } from './ModelConnections';
import { OperatorProfile } from './OperatorProfile';
import { AgentSettings } from './AgentSettings';
import { ExportSettings } from './ExportSettings';
import { Field, SettingSection } from './SettingsPrimitives';
import { McpConnections } from './McpConnections';
import { AuthenticationSettings } from './AuthenticationSettings';
import { CuratorSettings } from './CuratorSettings';
import { RetentionSettings } from './RetentionSettings';
import { loadApiTargetContributions, type ApiTargetContribution } from '../../app/apiTargets';
import type { ApiTarget } from '../../app/apiTargets';
import { ApiTargetsSettings } from './ApiTargetsSettings';
import { ExecutionBoundaries } from './ExecutionBoundaries';

export function Settings({ tab, setTab, agents, selected, targets, savedProviders, onModelConnectionsChanged, onAgentsChanged, onOperatorProfileChanged, onFirstRunComplete, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel, theme, setTheme, previewFirstRun = false }: { tab: SettingsTab; setTab: (t: SettingsTab) => void; agents: Agent[]; selected: Agent; targets: ApiTarget[]; savedProviders: SavedProvider[]; onModelConnectionsChanged: () => Promise<void>; onAgentsChanged: () => Promise<void>; onOperatorProfileChanged: (profile: { name: string; avatar: string }) => void; onFirstRunComplete: () => void; leftTopPanel: PanelId; setLeftTopPanel: (id: PanelId) => void; leftBottomPanel: PanelId; setLeftBottomPanel: (id: PanelId) => void; rightTopPanel: PanelId; setRightTopPanel: (id: PanelId) => void; rightBottomPanel: PanelId; setRightBottomPanel: (id: PanelId) => void; theme: Theme; setTheme: (theme: Theme) => void; previewFirstRun?: boolean }) {
  const [settingsAgentId, setSettingsAgentId] = useState(selected.id);
  const [targetContributions, setTargetContributions] = useState<ApiTargetContribution[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const settingsSelected = agents.find((agent) => agent.id === settingsAgentId) ?? selected;

  useEffect(() => {
    if (!agents.some((agent) => agent.id === settingsAgentId)) setSettingsAgentId(selected.id);
  }, [agents, selected.id, settingsAgentId]);
  useEffect(() => { let cancelled = false; void loadApiTargetContributions().then((items) => { if (!cancelled) setTargetContributions(items); }); return () => { cancelled = true; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void api<SetupStatus>('/api/setup/status').then((status) => { if (!cancelled) setSetupStatus(status); }).catch(() => { if (!cancelled) setSetupStatus(null); });
    return () => { cancelled = true; };
  }, []);
  const completeFirstRun = async () => {
    const status = await api<SetupStatus>('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setSetupStatus(status);
  };
  const selectedContribution = tab.startsWith('api-targets:') ? targetContributions.find((item) => item.modId === tab.slice('api-targets:'.length)) : undefined;
  const heading = selectedContribution?.name ?? tab[0].toUpperCase() + tab.slice(1);
  const builtInTabs = ['general', 'agents', 'connections'] as SettingsTab[];
  return <div className="settings-view"><nav className="settings-rail">{builtInTabs.map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item === 'connections' ? 'Connections' : item[0].toUpperCase() + item.slice(1)}</button>)}{targetContributions.map((item) => { const itemTab = `api-targets:${item.modId}` as SettingsTab; return <button className={tab === itemTab ? 'active' : ''} onClick={() => setTab(itemTab)} key={item.modId}>{item.name}</button>; })}</nav><div className="settings-content"><header className="settings-heading"><span className="eyebrow">CONFIGURATION</span><h1>{heading}</h1></header>{tab === 'agents' && <AgentToolbar agents={agents} selectedId={settingsSelected.id} onSelect={setSettingsAgentId} onAgentsChanged={onAgentsChanged} onModelConnectionsChanged={onModelConnectionsChanged} onOperatorProfileChanged={onOperatorProfileChanged} onFirstRunComplete={onFirstRunComplete} onSetupComplete={completeFirstRun} firstRun={previewFirstRun || setupStatus?.wizardStep === 'fresh' || setupStatus?.wizardStep === 'incomplete'} />}<div className="settings-panels">
    {selectedContribution && <ApiTargetsSettings contribution={selectedContribution} />}
    {tab === 'connections' && <AuthenticationSettings />}
    {tab === 'general' && <><div className="general-profile-column"><OperatorProfile onSaved={onOperatorProfileChanged} /><ExecutionBoundaries /><RetentionSettings /><ExportSettings /></div><div className="general-rail-column"><SettingSection title="Rail Panels"><div className="field-pair compact-fields"><Field label="Left · top"><select value={leftTopPanel} onChange={(e) => setLeftTopPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · top"><select value={rightTopPanel} onChange={(e) => setRightTopPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Left · bottom"><select value={leftBottomPanel} onChange={(e) => setLeftBottomPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · bottom"><select value={rightBottomPanel} onChange={(e) => setRightBottomPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field></div></SettingSection><CuratorSettings savedProviders={savedProviders} /></div><SettingSection title="Appearance"><fieldset className="theme-picker"><legend>Theme</legend><div>{themes.map((option) => <button type="button" className={theme === option ? 'active' : ''} onClick={() => setTheme(option)} aria-pressed={theme === option} key={option}><i className={`theme-swatch ${option}`} aria-hidden="true" /><span><b>{themeDetails[option].label}</b><small>{themeDetails[option].description}</small></span></button>)}</div></fieldset></SettingSection></>}
    {tab === 'connections' &&<ModelConnections savedProviders={savedProviders} onModelConnectionsChanged={onModelConnectionsChanged} mcpConnections={<McpConnections />} />}


    {tab === 'agents' && (agents.length === 0 ? <SettingSection title="Agent setup"><p className="hint">No agents configured yet. Create your first agent to unlock the rest of the agent settings.</p></SettingSection> : <AgentSettings selected={settingsSelected} targets={targets} savedProviders={savedProviders} onAgentsChanged={onAgentsChanged} />)}
  </div></div></div>;
}

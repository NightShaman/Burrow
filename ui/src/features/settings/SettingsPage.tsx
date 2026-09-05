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
import { AgentMcpTools } from './AgentMcpTools';
import { ExportSettings } from './ExportSettings';
import { Field, SettingSection } from './SettingsPrimitives';
import { McpConnections } from './McpConnections';
import { ApiTokensSettings } from './ApiTokensSettings';
import { AuthenticationSettings } from './AuthenticationSettings';
import { CuratorSettings } from './CuratorSettings';
import { RetentionSettings } from './RetentionSettings';
import { loadApiTargetContributions, type ApiTargetContribution, type ModSettingsContribution } from '../../app/apiTargets';
import type { ApiTarget } from '../../app/apiTargets';
import { ApiTargetsSettings } from './ApiTargetsSettings';
import { ExecutionBoundaries } from './ExecutionBoundaries';
import { Chevron } from '../workspace/WorkspaceRail';
import { readStoredValue, writeStoredValue } from '../../app/browserStorage';
import { SystemStatsRail } from './SystemStatsRail';
import { ModSettingsHost } from './ModSettingsHost';
import { ModsSettings } from './ModsSettings';

const settingsUtilityPanelStorageKey = 'hc.settingsUtilityPanelOpen';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

export function Settings({ tab, setTab, agents, selected, targets, savedProviders, onModelConnectionsChanged, onAgentsChanged, onOperatorProfileChanged, onFirstRunComplete, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel, theme, setTheme, previewFirstRun = false }: { tab: SettingsTab; setTab: (t: SettingsTab) => void; agents: Agent[]; selected: Agent; targets: ApiTarget[]; savedProviders: SavedProvider[]; onModelConnectionsChanged: () => Promise<void>; onAgentsChanged: () => Promise<void>; onOperatorProfileChanged: (profile: { name: string; avatar: string }) => void; onFirstRunComplete: () => void; leftTopPanel: PanelId; setLeftTopPanel: (id: PanelId) => void; leftBottomPanel: PanelId; setLeftBottomPanel: (id: PanelId) => void; rightTopPanel: PanelId; setRightTopPanel: (id: PanelId) => void; rightBottomPanel: PanelId; setRightBottomPanel: (id: PanelId) => void; theme: Theme; setTheme: (theme: Theme) => void; previewFirstRun?: boolean }) {
  const [settingsAgentId, setSettingsAgentId] = useState(selected.id);
  const [agentSection, setAgentSection] = useState<'details' | 'profile-documents' | 'mcp-tools' | 'cron-jobs' | 'dreams'>('details');
  const [generalSection, setGeneralSection] = useState<'operator-profile' | 'execution-boundaries' | 'trace-retention' | 'export' | 'rail-panels' | 'tiddle-signal' | 'appearance'>('operator-profile');
  const [connectionSection, setConnectionSection] = useState<'authentication' | 'model-providers' | 'mcp-servers' | 'api-tokens'>('authentication');
  const [modsSection, setModsSection] = useState<'installed' | 'sources'>('installed');
  const [modNavigationColumn, setModNavigationColumn] = useState<HTMLElement | null>(null);
  const [targetContributions, setTargetContributions] = useState<ApiTargetContribution[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [overflowColumn, setOverflowColumn] = useState<HTMLElement | null>(null);
  const [utilityPanelOpen, setUtilityPanelOpen] = useState(() => readStoredValue({
    key: settingsUtilityPanelStorageKey,
    version: 1,
    fallback: false,
    validate: isBoolean,
    decodeLegacy: (raw) => raw === 'true' ? true : raw === 'false' ? false : undefined,
  }));
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
  useEffect(() => { writeStoredValue(settingsUtilityPanelStorageKey, 1, utilityPanelOpen); }, [utilityPanelOpen]);
  const completeFirstRun = async () => {
    const status = await api<SetupStatus>('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setSetupStatus(status);
  };
  const nativeSettingMatch = tab.match(/^mod-settings:([^:]+):(.+)$/);
  const selectedContribution = (tab.startsWith('api-targets:') || nativeSettingMatch)
    ? targetContributions.find((item) => item.modId === (nativeSettingMatch?.[1] ?? tab.slice('api-targets:'.length)))
    : undefined;
  const selectedModSettings: ModSettingsContribution | undefined = selectedContribution?.settings?.find((item) => item.id === nativeSettingMatch?.[2]) ?? selectedContribution?.settings?.[0];
  const heading = selectedModSettings?.navigation.title ?? selectedContribution?.name ?? tab[0].toUpperCase() + tab.slice(1);
  const builtInTabs = ['general', 'agents', 'connections', 'mods'] as SettingsTab[];
  return <>
    <main className={`settings-blank-slate${tab === 'agents' ? ' has-agent-selector' : ''}${utilityPanelOpen ? ' has-utility-panel' : ''}`} aria-label="Settings layout prototype">
      <nav className="settings-blank-column settings-prototype-menu" aria-label="Settings sections">
        <div className="settings-prototype-menu-items">
          {builtInTabs.map((item) => <button type="button" className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)} key={item}>{item === 'connections' ? 'Connections' : item[0].toUpperCase() + item.slice(1)}</button>)}
          {targetContributions.length > 0 && <div className="settings-prototype-menu-divider" role="separator" aria-label="Installed mods" />}
          {targetContributions.map((item) => item.settings?.length ? item.settings.map((setting) => { const itemTab = `mod-settings:${item.modId}:${setting.id}` as SettingsTab; return <button type="button" className={tab === itemTab ? 'active' : ''} aria-current={tab === itemTab ? 'page' : undefined} onClick={() => setTab(itemTab)} key={`${item.modId}:${setting.id}`}>{item.name}</button>; }) : <button type="button" className={tab === `api-targets:${item.modId}` ? 'active' : ''} aria-current={tab === `api-targets:${item.modId}` ? 'page' : undefined} onClick={() => setTab(`api-targets:${item.modId}` as SettingsTab)} key={item.modId}>{item.name}</button>)}
        </div>
      </nav>
      {tab === 'agents' && <div className="settings-prototype-agent-selector"><AgentToolbar agents={agents} selectedId={settingsSelected.id} onSelect={setSettingsAgentId} onAgentsChanged={onAgentsChanged} onModelConnectionsChanged={onModelConnectionsChanged} onOperatorProfileChanged={onOperatorProfileChanged} onFirstRunComplete={onFirstRunComplete} onSetupComplete={completeFirstRun} firstRun={previewFirstRun || setupStatus?.wizardStep === 'fresh' || setupStatus?.wizardStep === 'incomplete'} /></div>}
      <section className="settings-blank-column settings-prototype-sections">
        {tab === 'general' && <nav className="settings-prototype-section-items" aria-label="General settings sections">
          {([
            ['operator-profile', 'Operator profile'],
            ['execution-boundaries', 'Execution boundaries'],
            ['trace-retention', 'Trace retention'],
            ['export', 'Export'],
            ['rail-panels', 'Rail panels'],
            ['tiddle-signal', 'Tiddle Signal'],
            ['appearance', 'Appearance'],
          ] as const).map(([id, label]) => <button type="button" className={generalSection === id ? 'active' : ''} aria-current={generalSection === id ? 'page' : undefined} onClick={() => setGeneralSection(id)} key={id}>{label}</button>)}
        </nav>}
        {tab === 'agents' && <nav className="settings-prototype-section-items" aria-label={`${settingsSelected.name} settings sections`}>
          {([
            ['details', 'Agent details'],
            ['profile-documents', 'Profile documents'],
            ['mcp-tools', 'MCP tools'],
            ['cron-jobs', 'Cron jobs'],
            ['dreams', 'Dreams'],
          ] as const).map(([id, label]) => <button type="button" className={agentSection === id ? 'active' : ''} aria-current={agentSection === id ? 'page' : undefined} onClick={() => setAgentSection(id)} key={id}>{label}</button>)}
        </nav>}
        {tab === 'connections' && <nav className="settings-prototype-section-items" aria-label="Connection settings sections">
          {([
            ['authentication', 'Authentication'],
            ['model-providers', 'Model providers'],
            ['mcp-servers', 'MCP servers'],
            ['api-tokens', 'API tokens'],
          ] as const).map(([id, label]) => <button type="button" className={connectionSection === id ? 'active' : ''} aria-current={connectionSection === id ? 'page' : undefined} onClick={() => setConnectionSection(id)} key={id}>{label}</button>)}
        </nav>}
        {tab === 'mods' && <nav className="settings-prototype-section-items" aria-label="Mod management sections">
          {([
            ['installed', 'Installed mods'],
            ['sources', 'Mod sources'],
          ] as const).map(([id, label]) => <button type="button" className={modsSection === id ? 'active' : ''} aria-current={modsSection === id ? 'page' : undefined} onClick={() => setModsSection(id)} key={id}>{label}</button>)}
        </nav>}
        {selectedContribution?.settingsUrl ? <div ref={setModNavigationColumn} /> : selectedModSettings ? <nav className="settings-prototype-section-items" aria-label={`${selectedModSettings.navigation.title} settings sections`}><button type="button" className="active" aria-current="page">{selectedModSettings.navigation.title}</button></nav> : selectedContribution && <span>Extension settings</span>}
      </section>
      <section className="settings-blank-column settings-prototype-configuration">
        {tab === 'general' && generalSection === 'operator-profile' && <OperatorProfile onSaved={onOperatorProfileChanged} />}
        {tab === 'general' && generalSection === 'execution-boundaries' && <ExecutionBoundaries />}
        {tab === 'general' && generalSection === 'trace-retention' && <RetentionSettings />}
        {tab === 'general' && generalSection === 'export' && <ExportSettings />}
        {tab === 'general' && generalSection === 'rail-panels' && <SettingSection title="Rail Panels"><div className="field-pair compact-fields"><Field label="Left · top"><select value={leftTopPanel} onChange={(event) => setLeftTopPanel(event.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · top"><select value={rightTopPanel} onChange={(event) => setRightTopPanel(event.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Left · bottom"><select value={leftBottomPanel} onChange={(event) => setLeftBottomPanel(event.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · bottom"><select value={rightBottomPanel} onChange={(event) => setRightBottomPanel(event.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field></div></SettingSection>}
        {tab === 'general' && generalSection === 'tiddle-signal' && <CuratorSettings savedProviders={savedProviders} />}
        {tab === 'general' && generalSection === 'appearance' && <SettingSection title="Appearance"><fieldset className="theme-picker"><legend>Theme</legend><div>{themes.map((option) => <button type="button" className={theme === option ? 'active' : ''} onClick={() => setTheme(option)} aria-pressed={theme === option} key={option}><i className={`theme-swatch ${option}`} aria-hidden="true" /><span><b>{themeDetails[option].label}</b><small>{themeDetails[option].description}</small></span></button>)}</div></fieldset></SettingSection>}
        {tab === 'agents' && (agents.length === 0 ? <SettingSection title="Agent setup"><p className="hint">No agents configured yet. Create your first agent to unlock the rest of the agent settings.</p></SettingSection> : agentSection === 'mcp-tools' ? <AgentMcpTools agentId={settingsSelected.id} targets={targets} overflowTarget={overflowColumn} /> : <AgentSettings selected={settingsSelected} targets={targets} savedProviders={savedProviders} onAgentsChanged={onAgentsChanged} section={agentSection} overflowTarget={overflowColumn} />)}
        {tab === 'connections' && connectionSection === 'authentication' && <AuthenticationSettings />}
        {tab === 'connections' && connectionSection === 'model-providers' && <ModelConnections savedProviders={savedProviders} onModelConnectionsChanged={onModelConnectionsChanged} mcpConnections={null} overflowTarget={overflowColumn} />}
        {tab === 'connections' && connectionSection === 'mcp-servers' && <McpConnections overflowTarget={overflowColumn} />}
        {tab === 'connections' && connectionSection === 'api-tokens' && <ApiTokensSettings overflowTarget={overflowColumn} />}
        {tab === 'mods' && <ModsSettings section={modsSection} overflowTarget={overflowColumn} />}
        {selectedContribution?.settingsUrl ? <ModSettingsHost modId={selectedContribution.modId} settingsUrl={selectedContribution.settingsUrl} agents={agents} onAgentsChanged={onAgentsChanged} navigationTarget={modNavigationColumn} overflowTarget={overflowColumn} /> : selectedContribution && <ApiTargetsSettings contribution={selectedContribution} settings={selectedModSettings} overflowTarget={overflowColumn} />}
      </section>
      <section className="settings-blank-column settings-prototype-overflow" ref={setOverflowColumn} aria-label="Additional settings" />
      <aside className="settings-utility-panel" aria-label="System statistics" aria-hidden={!utilityPanelOpen}>
        <header><span>System statistics</span><button type="button" onClick={() => setUtilityPanelOpen(false)} aria-label="Collapse system statistics"><Chevron direction="right" /></button></header>
        <SystemStatsRail active={utilityPanelOpen} />
      </aside>
      {!utilityPanelOpen && <button className="settings-utility-panel-toggle" type="button" onClick={() => setUtilityPanelOpen(true)} aria-label="Open system statistics" aria-expanded="false"><Chevron direction="left" /></button>}
    </main>
    <div className="settings-baseline-hidden" aria-hidden="true"><div className="settings-view"><nav className="settings-rail">{builtInTabs.map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item === 'connections' ? 'Connections' : item[0].toUpperCase() + item.slice(1)}</button>)}{targetContributions.map((item) => { const itemTab = `api-targets:${item.modId}` as SettingsTab; return <button className={tab === itemTab ? 'active' : ''} onClick={() => setTab(itemTab)} key={item.modId}>{item.name}</button>; })}</nav><div className="settings-content"><header className="settings-heading"><span className="eyebrow">CONFIGURATION</span><h1>{heading}</h1></header>{tab === 'agents' && <AgentToolbar agents={agents} selectedId={settingsSelected.id} onSelect={setSettingsAgentId} onAgentsChanged={onAgentsChanged} onModelConnectionsChanged={onModelConnectionsChanged} onOperatorProfileChanged={onOperatorProfileChanged} onFirstRunComplete={onFirstRunComplete} onSetupComplete={completeFirstRun} firstRun={previewFirstRun || setupStatus?.wizardStep === 'fresh' || setupStatus?.wizardStep === 'incomplete'} />}<div className="settings-panels">
    {selectedContribution && <ApiTargetsSettings contribution={selectedContribution} />}
    {tab === 'connections' && <AuthenticationSettings />}
    {tab === 'general' && <><div className="general-profile-column"><OperatorProfile onSaved={onOperatorProfileChanged} /><ExecutionBoundaries /><RetentionSettings /><ExportSettings /></div><div className="general-rail-column"><SettingSection title="Rail Panels"><div className="field-pair compact-fields"><Field label="Left · top"><select value={leftTopPanel} onChange={(e) => setLeftTopPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · top"><select value={rightTopPanel} onChange={(e) => setRightTopPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Left · bottom"><select value={leftBottomPanel} onChange={(e) => setLeftBottomPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field><Field label="Right · bottom"><select value={rightBottomPanel} onChange={(e) => setRightBottomPanel(e.target.value as PanelId)}>{panelRegistry.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></Field></div></SettingSection><CuratorSettings savedProviders={savedProviders} /></div><SettingSection title="Appearance"><fieldset className="theme-picker"><legend>Theme</legend><div>{themes.map((option) => <button type="button" className={theme === option ? 'active' : ''} onClick={() => setTheme(option)} aria-pressed={theme === option} key={option}><i className={`theme-swatch ${option}`} aria-hidden="true" /><span><b>{themeDetails[option].label}</b><small>{themeDetails[option].description}</small></span></button>)}</div></fieldset></SettingSection></>}
    {tab === 'connections' &&<ModelConnections savedProviders={savedProviders} onModelConnectionsChanged={onModelConnectionsChanged} mcpConnections={<McpConnections />} />}


    {tab === 'agents' && (agents.length === 0 ? <SettingSection title="Agent setup"><p className="hint">No agents configured yet. Create your first agent to unlock the rest of the agent settings.</p></SettingSection> : <AgentSettings selected={settingsSelected} targets={targets} savedProviders={savedProviders} onAgentsChanged={onAgentsChanged} />)}
  </div></div></div></div>
  </>;
}

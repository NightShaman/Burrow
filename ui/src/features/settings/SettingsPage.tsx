import { BrowserTabSettings } from './BrowserTabSettings';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Agent, PanelId, SavedProvider, SettingsTab } from '../../app/types';
import { api, type SetupStatus } from '../../app/api';
import { railLayouts, themes, themeDetails } from '../../app/usePersistedLayout';
import { RailPanelSettings } from './RailPanelSettings';
import type { Theme } from '../../app/usePersistedLayout';
import type { AgentRailPreferences } from '../../app/useAgentRailPreferences';
import { AgentToolbar } from './AgentToolbar';
import { ModelConnections } from './ModelConnections';
import { OperatorTimezone } from './OperatorTimezone';
import { OperatorProfile } from './OperatorProfile';
import { AgentSettings } from './AgentSettings';
import { AgentMcpTools } from './AgentMcpTools';
import { ExportSettings } from './ExportSettings';
import { SettingSection } from './SettingsPrimitives';
import { McpConnections } from './McpConnections';
import { ApiTokensSettings } from './ApiTokensSettings';
import { AuthenticationSettings } from './AuthenticationSettings';
import { BrowserOriginSettings } from './BrowserOriginSettings';
import { BrainEmbeddingSettings } from './BrainEmbeddingSettings';
import { CuratorSettings } from './CuratorSettings';
import { RetentionSettings } from './RetentionSettings';
import { loadModSettingsContributions, modContributionsChangedEvent, type ModContribution, type ModSettingsContribution } from '../../app/apiTargets';
import { ExecutionBoundaries } from './ExecutionBoundaries';
import { Chevron } from '../workspace/WorkspaceRail';
import { readStoredValue, writeStoredValue } from '../../app/browserStorage';
import { SystemStatsRail } from './SystemStatsRail';
import { ModSettingsHost } from './ModSettingsHost';
import { ModsSettings } from './ModsSettings';
import { AgentSidebarSettings } from './AgentSidebarSettings';
import { SkillsSettings } from './SkillsSettings';

const settingsUtilityPanelStorageKey = 'hc.settingsUtilityPanelOpen';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

export function Settings({ navigationTarget, tab, setTab, agents, selected, savedProviders, onModelConnectionsChanged, onAgentsChanged, onOperatorProfileChanged, onFirstRunComplete, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel, leftSinglePanel, setLeftSinglePanel, rightSinglePanel, setRightSinglePanel, leftRailLayout, setLeftRailLayout, rightRailLayout, setRightRailLayout, theme, setTheme, agentRailPreferences, setAgentRailPreferences, previewFirstRun = false }: { navigationTarget?: HTMLElement | null; tab: SettingsTab; setTab: (t: SettingsTab) => void; agents: Agent[]; selected: Agent; savedProviders: SavedProvider[]; onModelConnectionsChanged: () => Promise<void>; onAgentsChanged: () => Promise<void>; onOperatorProfileChanged: (profile: { name: string; avatar: string }) => void; onFirstRunComplete: () => void; leftTopPanel: PanelId; setLeftTopPanel: (id: PanelId) => void; leftBottomPanel: PanelId; setLeftBottomPanel: (id: PanelId) => void; rightTopPanel: PanelId; setRightTopPanel: (id: PanelId) => void; rightBottomPanel: PanelId; setRightBottomPanel: (id: PanelId) => void; leftSinglePanel: PanelId; setLeftSinglePanel: (id: PanelId) => void; rightSinglePanel: PanelId; setRightSinglePanel: (id: PanelId) => void; leftRailLayout: typeof railLayouts[number]; setLeftRailLayout: (layout: typeof railLayouts[number]) => void; rightRailLayout: typeof railLayouts[number]; setRightRailLayout: (layout: typeof railLayouts[number]) => void; theme: Theme; setTheme: (theme: Theme) => void; agentRailPreferences: AgentRailPreferences; setAgentRailPreferences: (next: AgentRailPreferences | ((current: AgentRailPreferences) => AgentRailPreferences)) => void; previewFirstRun?: boolean }) {
  const [settingsAgentId, setSettingsAgentId] = useState(selected.id);
  const [agentSection, setAgentSection] = useState<'details' | 'profile-documents' | 'mcp-tools' | 'cron-jobs' | 'dreams' | 'skills'>('details');
  const [generalSection, setGeneralSection] = useState<'browser-tab' | 'operator-timezone' | 'operator-profile' | 'execution-boundaries' | 'trace-retention' | 'brain-memory' | 'export' | 'rail-panels' | 'tiddle-signal' | 'appearance'>('operator-profile');
  const [connectionSection, setConnectionSection] = useState<'authentication' | 'browser-origin' | 'model-providers' | 'mcp-servers' | 'api-tokens'>('authentication');
  const [skillsSection, setSkillsSection] = useState<'installed' | 'repo' | 'text'>('installed');
  const [modsSection, setModsSection] = useState<'installed' | 'sources' | 'automatic-checks'>('installed');
  const hasAgentsPanel = (leftRailLayout === 'divided' ? [leftTopPanel, leftBottomPanel] : [leftSinglePanel])
    .concat(rightRailLayout === 'divided' ? [rightTopPanel, rightBottomPanel] : [rightSinglePanel])
    .includes('agents');
  const [modNavigationColumn, setModNavigationColumn] = useState<HTMLElement | null>(null);
  const [targetContributions, setTargetContributions] = useState<ModContribution[]>([]);
  const setupFinished = useRef(false);
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
  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const refresh = () => { const current = ++sequence; void loadModSettingsContributions().then((items) => { if (!cancelled && current === sequence) setTargetContributions(items); }); };
    refresh();
    window.addEventListener(modContributionsChangedEvent, refresh);
    return () => { cancelled = true; window.removeEventListener(modContributionsChangedEvent, refresh); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<SetupStatus>('/api/setup/status').then((status) => { if (!cancelled && !setupFinished.current) setSetupStatus(status); }).catch(() => { if (!cancelled && !setupFinished.current) setSetupStatus(null); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { writeStoredValue(settingsUtilityPanelStorageKey, 1, utilityPanelOpen); }, [utilityPanelOpen]);
  const completeFirstRun = async () => {
    const status = await api<SetupStatus>('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setupFinished.current = true;
    setSetupStatus(status);
  };
  const nativeSettingMatch = tab.match(/^mod-settings:([^:]+):(.+)$/);
  const selectedContribution = nativeSettingMatch ? targetContributions.find((item) => item.modId === nativeSettingMatch[1]) : undefined;
  const selectedModSettings: ModSettingsContribution | undefined = selectedContribution?.settings?.find((item) => item.id === nativeSettingMatch?.[2]) ?? selectedContribution?.settings?.[0];
  const builtInTabs = ['general', 'agents', 'skills', 'connections', 'mods'] as SettingsTab[];
  const settingsNavigation = <nav className="settings-blank-column settings-prototype-menu" aria-label="Settings sections">
        <div className="settings-prototype-menu-items">
          {builtInTabs.map((item) => <button type="button" className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)} key={item}>{item === 'connections' ? 'Connections' : item[0].toUpperCase() + item.slice(1)}</button>)}
          {targetContributions.length > 0 && <div className="settings-prototype-menu-divider" role="separator" aria-label="Installed mods" />}
          {targetContributions.flatMap((item) => item.settings?.map((setting) => { const itemTab = `mod-settings:${item.modId}:${setting.id}` as SettingsTab; return <button type="button" className={tab === itemTab ? 'active' : ''} aria-current={tab === itemTab ? 'page' : undefined} onClick={() => setTab(itemTab)} key={`${item.modId}:${setting.id}`}>{item.name}</button>; }) ?? [])}
        </div>
      </nav>;
  return <>
    {navigationTarget && createPortal(settingsNavigation, navigationTarget)}
    <main className={`settings-blank-slate${navigationTarget ? ' has-top-navigation' : ''}${tab === 'agents' ? ' has-agent-selector' : ''}${utilityPanelOpen ? ' has-utility-panel' : ''}`} aria-label="Settings layout prototype">
      {!navigationTarget && settingsNavigation}
      {tab === 'agents' && <div className="settings-prototype-agent-selector"><AgentToolbar agents={agents} selectedId={settingsSelected.id} onSelect={setSettingsAgentId} onAgentsChanged={onAgentsChanged} onModelConnectionsChanged={onModelConnectionsChanged} onOperatorProfileChanged={onOperatorProfileChanged} onFirstRunComplete={onFirstRunComplete} onSetupComplete={completeFirstRun} firstRun={previewFirstRun || setupStatus?.wizardStep === 'fresh' || setupStatus?.wizardStep === 'incomplete'} /></div>}

      <section className="settings-blank-column settings-prototype-sections">
        {tab === 'skills' && <nav className="settings-prototype-section-items" aria-label="Skills settings sections">{([['installed', 'Installed skills'], ['repo', 'Import from repository'], ['text', 'New text skill']] as const).map(([id,label]) => <button type="button" key={id} className={skillsSection === id ? 'active' : ''} aria-current={skillsSection === id ? 'page' : undefined} onClick={() => setSkillsSection(id)}>{label}</button>)}</nav>}
        {tab === 'general' && <nav className="settings-prototype-section-items" aria-label="General settings sections">
          {([
            ['operator-profile', 'Operator profile'],
            ['operator-timezone', 'Operator timezone'],
            ['browser-tab', 'Browser tab'],
            ['execution-boundaries', 'Execution boundaries'],
            ['trace-retention', 'Trace retention'],
            ['brain-memory', 'Brain memory'],
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
            ['skills', 'Skills'],
          ] as const).map(([id, label]) => <button type="button" className={agentSection === id ? 'active' : ''} aria-current={agentSection === id ? 'page' : undefined} onClick={() => setAgentSection(id)} key={id}>{label}</button>)}
        </nav>}
        {tab === 'connections' && <nav className="settings-prototype-section-items" aria-label="Connection settings sections">
          {([
            ['authentication', 'Authentication'],
            ['browser-origin', 'Browser origin'],
            ['model-providers', 'Model providers'],
            ['mcp-servers', 'MCP servers'],
            ['api-tokens', 'API tokens'],
          ] as const).map(([id, label]) => <button type="button" className={connectionSection === id ? 'active' : ''} aria-current={connectionSection === id ? 'page' : undefined} onClick={() => setConnectionSection(id)} key={id}>{label}</button>)}
        </nav>}
        {tab === 'mods' && <nav className="settings-prototype-section-items" aria-label="Mod management sections">
          {([
            ['installed', 'Installed mods'],
            ['sources', 'Mod sources'],
            ['automatic-checks', 'Automatic source checks'],
          ] as const).map(([id, label]) => <button type="button" className={modsSection === id ? 'active' : ''} aria-current={modsSection === id ? 'page' : undefined} onClick={() => setModsSection(id)} key={id}>{label}</button>)}
        </nav>}
        {selectedContribution?.settingsUrl ? <div ref={setModNavigationColumn} /> : selectedModSettings ? <nav className="settings-prototype-section-items" aria-label={`${selectedModSettings.navigation.title} settings sections`}><button type="button" className="active" aria-current="page">{selectedModSettings.navigation.title}</button></nav> : selectedContribution && <span>Extension settings</span>}
      </section>
      <section className="settings-blank-column settings-prototype-configuration">
        {tab === 'general' && generalSection === 'browser-tab' && <BrowserTabSettings />}
        {tab === 'general' && generalSection === 'operator-timezone' && <OperatorTimezone />}
        {tab === 'general' && generalSection === 'operator-profile' && <OperatorProfile onSaved={onOperatorProfileChanged} />}
        {tab === 'general' && generalSection === 'execution-boundaries' && <ExecutionBoundaries overflowTarget={overflowColumn} />}
        {tab === 'general' && generalSection === 'trace-retention' && <RetentionSettings />}
        {tab === 'general' && generalSection === 'brain-memory' && <BrainEmbeddingSettings savedProviders={savedProviders} />}
        {tab === 'general' && generalSection === 'export' && <ExportSettings />}
        {tab === 'general' && generalSection === 'rail-panels' && <SettingSection title="Rail Panels"><div className="field-pair compact-fields"><RailPanelSettings side="Left" layout={leftRailLayout} setLayout={setLeftRailLayout} singlePanel={leftSinglePanel} setSinglePanel={setLeftSinglePanel} topPanel={leftTopPanel} setTopPanel={setLeftTopPanel} bottomPanel={leftBottomPanel} setBottomPanel={setLeftBottomPanel} /><RailPanelSettings side="Right" layout={rightRailLayout} setLayout={setRightRailLayout} singlePanel={rightSinglePanel} setSinglePanel={setRightSinglePanel} topPanel={rightTopPanel} setTopPanel={setRightTopPanel} bottomPanel={rightBottomPanel} setBottomPanel={setRightBottomPanel} /></div></SettingSection>}
        {tab === 'general' && generalSection === 'tiddle-signal' && <CuratorSettings savedProviders={savedProviders} />}
        {tab === 'general' && generalSection === 'appearance' && <SettingSection title="Appearance"><fieldset className="theme-picker"><legend>Theme</legend><div>{themes.map((option) => <button type="button" className={theme === option ? 'active' : ''} onClick={() => setTheme(option)} aria-pressed={theme === option} key={option}><i className={`theme-swatch ${option}`} aria-hidden="true" /><span><b>{themeDetails[option].label}</b><small>{themeDetails[option].description}</small></span></button>)}</div></fieldset></SettingSection>}
        {tab === 'agents' && (agents.length === 0 ? <SettingSection title="Agent setup"><p className="hint">No agents configured yet. Create your first agent to unlock the rest of the agent settings.</p></SettingSection> : agentSection === 'skills' ? <SkillsSettings agentView agents={agents} agentId={settingsSelected.id} overflowTarget={overflowColumn} /> : agentSection === 'mcp-tools' ? <AgentMcpTools agentId={settingsSelected.id} overflowTarget={overflowColumn} /> : <AgentSettings selected={settingsSelected} savedProviders={savedProviders} onAgentsChanged={onAgentsChanged} section={agentSection} overflowTarget={overflowColumn} />)}
        {tab === 'skills' && <SkillsSettings agents={agents} agentId={settingsSelected.id} section={skillsSection} onSectionChange={setSkillsSection} overflowTarget={overflowColumn} />}
        {tab === 'connections' && connectionSection === 'authentication' && <AuthenticationSettings />}
        {tab === 'connections' && connectionSection === 'browser-origin' && <BrowserOriginSettings />}
        {tab === 'connections' && connectionSection === 'model-providers' && <ModelConnections savedProviders={savedProviders} onModelConnectionsChanged={onModelConnectionsChanged} mcpConnections={null} overflowTarget={overflowColumn} />}
        {tab === 'connections' && connectionSection === 'mcp-servers' && <McpConnections overflowTarget={overflowColumn} />}
        {tab === 'connections' && connectionSection === 'api-tokens' && <ApiTokensSettings overflowTarget={overflowColumn} />}
        {tab === 'mods' && <ModsSettings section={modsSection} overflowTarget={overflowColumn} />}
        {selectedContribution?.settingsUrl && <ModSettingsHost key={`${selectedContribution.modId}:${selectedContribution.version ?? ''}`} modId={selectedContribution.modId} settingsUrl={`${selectedContribution.settingsUrl}${selectedContribution.version ? `?v=${encodeURIComponent(selectedContribution.version)}` : ''}`} agents={agents} onAgentsChanged={onAgentsChanged} navigationTarget={modNavigationColumn} overflowTarget={overflowColumn} />}
      </section>
      <section className="settings-blank-column settings-prototype-overflow" ref={setOverflowColumn} aria-label="Additional settings">
        {tab === 'general' && generalSection === 'rail-panels' && hasAgentsPanel && <div className="settings-overflow-content"><AgentSidebarSettings agents={agents} preferences={agentRailPreferences} setPreferences={setAgentRailPreferences} /></div>}
      </section>
      <aside className="settings-utility-panel" aria-label="System statistics" aria-hidden={!utilityPanelOpen}>
        <header><span>System statistics</span><button type="button" onClick={() => setUtilityPanelOpen(false)} aria-label="Collapse system statistics"><Chevron direction="right" /></button></header>
        <SystemStatsRail active={utilityPanelOpen} />
      </aside>
      {!utilityPanelOpen && <button className="settings-utility-panel-toggle" type="button" onClick={() => setUtilityPanelOpen(true)} aria-label="Open system statistics" aria-expanded="false"><Chevron direction="left" /></button>}
    </main>
  </>;
}

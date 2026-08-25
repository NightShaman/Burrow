import { useEffect, useState } from 'react';
import type { Agent, PanelId, SavedProvider, SettingsTab } from '../../app/types';
import { api, type SetupStatus } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
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

const agentIdFromName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const importErrorMessage = (cause: unknown) => cause instanceof Error && cause.message === 'import_password_required' ? 'Password required.' : cause instanceof Error ? `Could not import export: ${cause.message}` : 'Could not import export.';

const openAiLoginStatusLabel = (status?: string) => {
 switch (status) {
 case 'starting': return 'Preparing secure sign-in';
 case 'waiting_for_callback': return 'Finish signing in in your browser';
 case 'waiting_for_code': return 'Paste the sign-in callback to continue';
 case 'exchanging': return 'Confirming your sign-in';
 case 'authorized': return 'Signed in';
 case 'completed': case 'imported': return 'Connected';
 case 'cancelled': return 'Sign-in cancelled';
 case 'expired': return 'Sign-in expired';
 case 'failed': return 'Sign-in failed';
 default: return status ? status.replace(/[-_]+/g, ' ') : 'Ready to sign in';
 }
};

const claudeLoginStatusLabel = (status?: string) => {
  switch (status) {
    case 'waiting_for_code': return 'Waiting for callback code';
    case 'code_submitted': return 'Code submitted';
    case 'authorizing': return 'Authorizing';
    case 'authorized': return 'Authorized';
    case 'ready_to_import': return 'Ready to import';
    case 'imported': return 'Imported';
    case 'cancelled': return 'Cancelled';
    case 'expired': return 'Expired';
    case 'failed': return 'Failed';
    case 'waiting_for_url': return 'Starting Claude Code';
    default: return status ? status.replace(/[-_]+/g, ' ') : 'Idle';
  }
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Local HTTP and embedded webviews may deny the async Clipboard API.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}


export function Settings({ tab, setTab, agents, selected, targets, savedProviders, onModelConnectionsChanged, onAgentsChanged, onOperatorProfileChanged, onFirstRunComplete, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel, theme, setTheme, previewFirstRun = false }: { tab: SettingsTab; setTab: (t: SettingsTab) => void; agents: Agent[]; selected: Agent; targets: ApiTarget[]; savedProviders: SavedProvider[]; onModelConnectionsChanged: () => Promise<void>; onAgentsChanged: () => Promise<void>; onOperatorProfileChanged: (profile: { name: string; avatar: string }) => void; onFirstRunComplete: () => void; leftTopPanel: PanelId; setLeftTopPanel: (id: PanelId) => void; leftBottomPanel: PanelId; setLeftBottomPanel: (id: PanelId) => void; rightTopPanel: PanelId; setRightTopPanel: (id: PanelId) => void; rightBottomPanel: PanelId; setRightBottomPanel: (id: PanelId) => void; theme: Theme; setTheme: (theme: Theme) => void; previewFirstRun?: boolean }) {
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
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

type BoundaryOperation = 'read' | 'write' | 'delete' | 'execute' | 'delegate';
type ExecutionBoundary = { id: string; enabled: boolean; type: 'path' | 'command'; pattern: string; match: 'exact' | 'prefix' | 'glob' | 'regex' | 'contains'; operations: BoundaryOperation[]; reason?: string };
type ExecutionBoundariesResponse = { boundaries: { version: 1; hardBlocks: ExecutionBoundary[] }; status?: { enabled?: boolean; hardBlockCount?: number; enabledHardBlockCount?: number } };
const boundaryOperations: BoundaryOperation[] = ['read', 'write', 'delete', 'execute', 'delegate'];
const boundaryMatches: ExecutionBoundary['match'][] = ['exact', 'prefix', 'glob', 'regex', 'contains'];
const newBoundary = (): ExecutionBoundary => ({ id: '', enabled: true, type: 'path', pattern: '', match: 'glob', operations: ['write'] });

function ExecutionBoundaries() {
  const [hardBlocks, setHardBlocks] = useState<ExecutionBoundary[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');
  useEffect(() => { let cancelled = false; void api<ExecutionBoundariesResponse>('/api/settings/execution-boundaries').then((result) => {
    if (!cancelled) setHardBlocks(result.boundaries.hardBlocks);
  }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? `Could not load execution boundaries: ${cause.message}` : 'Could not load execution boundaries.'); }).finally(() => { if (!cancelled) setStatus('idle'); }); return () => { cancelled = true; }; }, []);
  const update = (index: number, changes: Partial<ExecutionBoundary>) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...changes } : rule));
  const toggleOperation = (index: number, operation: BoundaryOperation) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex !== index ? rule : { ...rule, operations: rule.operations.includes(operation) ? rule.operations.filter((item) => item !== operation) : [...rule.operations, operation] }));
  const save = async () => { setStatus('saving'); setError(''); try { const result = await api<ExecutionBoundariesResponse>('/api/settings/execution-boundaries', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hardBlocks }) }); setHardBlocks(result.boundaries.hardBlocks); } catch (cause) { setError(cause instanceof Error ? `Could not save execution boundaries: ${cause.message}` : 'Could not save execution boundaries.'); } finally { setStatus('idle'); } };
  return <SettingSection title="Execution boundaries"><p className="settings-section-description">Hard blocks are enforced immediately before tool execution. Matching path or command operations cannot proceed.</p><div className="boundary-rules">{hardBlocks.map((rule, index) => <article className="boundary-rule" key={`${rule.id}-${index}`}><div className="boundary-rule-heading"><label className="boundary-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} /> Enabled</label><button className="boundary-remove" type="button" onClick={() => setHardBlocks((rules) => rules.filter((_, ruleIndex) => ruleIndex !== index))} aria-label={`Remove ${rule.id || 'boundary'}`}>Remove</button></div><div className="field-pair compact-fields"><Field label="Rule ID"><input value={rule.id} onChange={(event) => update(index, { id: event.target.value })} placeholder="backup-readonly" /></Field><Field label="Target type"><select value={rule.type} onChange={(event) => update(index, { type: event.target.value as ExecutionBoundary['type'], match: event.target.value === 'command' ? 'regex' : 'glob' })}><option value="path">Path</option><option value="command">Command</option></select></Field></div><Field label="Pattern"><input value={rule.pattern} onChange={(event) => update(index, { pattern: event.target.value })} placeholder={rule.type === 'path' ? '/mnt/backup/**' : 'rm\\s'} /></Field><div className="field-pair compact-fields"><Field label="Match"><select value={rule.match} onChange={(event) => update(index, { match: event.target.value as ExecutionBoundary['match'] })}>{boundaryMatches.map((match) => <option key={match} value={match}>{match}</option>)}</select></Field><Field label="Reason"><input value={rule.reason ?? ''} onChange={(event) => update(index, { reason: event.target.value })} placeholder="Optional" /></Field></div><fieldset className="boundary-operations"><legend>Block operations</legend>{boundaryOperations.map((operation) => <label key={operation}><input type="checkbox" checked={rule.operations.includes(operation)} onChange={() => toggleOperation(index, operation)} /> {operation}</label>)}</fieldset></article>)}{hardBlocks.length === 0 && <p className="boundary-empty">No hard blocks are configured.</p>}</div><div className="boundary-actions"><button className="secondary" type="button" onClick={() => setHardBlocks((rules) => [...rules, newBoundary()])} disabled={status === 'loading'}>Add hard block</button><button className="primary" type="button" onClick={save} disabled={status !== 'idle'}>{status === 'saving' ? 'Saving…' : 'Save boundaries'}</button></div>{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>; }

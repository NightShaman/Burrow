import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Agent, Page, PanelId, SettingsTab, Tab, Task } from './app/types';
import { api, apiForTarget, setActiveApiTarget, attachmentDisplayName, type ChatAttachment, type ChatSession, type RuntimeHealth } from './app/api';
import { targetForResource, useApiTargets } from './app/apiTargets';
import { TargetSelector } from './features/navigation/TargetSelector';
import { listenResize, usePersistedTheme, usePersistedAgentSelection, usePersistedTargetSelection, usePersistedLayout } from './app/usePersistedLayout';
import { useAppTabs } from './app/useAppTabs';
import { formatUsageReset, useRuntimeDashboard } from './app/useRuntimeDashboard';
import { formatAgentActivity, useRuntimeAgents } from './app/useRuntimeAgents';
import { AgentsPanel, SystemPanel, WorkspacePanel, WorkspaceRail } from './features/workspace/WorkspaceRail';
import { CodexAccounts, RightRail } from './features/panels/RightRail';
import { AccountStatus } from './features/panels/AccountStatus';
import { Chat, ChatModelSelector, Editor } from './features/chat/ChatPage';
import { useChatRun } from './features/chat/useChatRun';

const readAttachment = (file: File, name: string): Promise<ChatAttachment> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve({ name, type: file.type || 'application/octet-stream', size: file.size, encoding: 'data-url', content: reader.result }) : reject(new Error('Invalid attachment content')); reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment')); reader.readAsDataURL(file); });
const isSupportedAttachment = (file: File) => file.type.startsWith('image/') || file.type.startsWith('text/') || ['application/json', 'application/xml', 'application/rtf', 'application/pdf'].includes(file.type) || /\.(txt|md|markdown|json|csv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|yaml|yml|rtf|pdf)$/i.test(file.name);
import { useWorkspaceFiles } from './features/workspace/useWorkspaceFiles';
import { conversationCacheKey, useChatSession } from './features/chat/useChatSession';
const Settings = lazy(() => import('./features/settings/SettingsPage').then(({ Settings }) => ({ default: Settings })));
import { LoginPage } from './features/auth/LoginPage';
const Tasks = lazy(() => import('./features/tasks/TasksPage').then(({ Tasks }) => ({ default: Tasks })));
const Archive = lazy(() => import('./features/tasks/ArchivePage').then(({ Archive }) => ({ default: Archive })));
import { GroupChannelsPage } from './features/groups/GroupChannelsPage';

function AppContent() {
  const previewFirstRun = new URLSearchParams(window.location.search).get('previewFirstRun') === '1';
 const [page, setPage] = useState<Page>(() => previewFirstRun ? 'settings' : 'chat'); const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => previewFirstRun ? 'agents' : 'general');
  const { targets: apiTargets, loaded: apiTargetsLoaded } = useApiTargets();
  const [selectedTargetId, setSelectedTargetId] = usePersistedTargetSelection();
  const activeTarget = apiTargets.find((target) => target.id === selectedTargetId) ?? apiTargets[0];
  const activeTargets = activeTarget ? [activeTarget] : [];
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiForTarget<RuntimeHealth>(activeTarget, '/api/health').then((health) => {
      if (!cancelled) setRuntimeVersion(health.version ?? null);
    }).catch(() => {
      if (!cancelled) setRuntimeVersion(null);
    });
    return () => { cancelled = true; };
  }, [activeTarget]);
  const [selectedAgentId, setSelectedAgentId] = usePersistedAgentSelection();
  useEffect(() => {
    if (apiTargetsLoaded && !apiTargets.some((target) => target.id === selectedTargetId)) setSelectedTargetId(apiTargets[0]?.id ?? 'local');
  }, [apiTargets, apiTargetsLoaded, selectedTargetId, setSelectedTargetId]);
  useLayoutEffect(() => { setActiveApiTarget(activeTarget); }, [activeTarget]);
  const [selectedStreamId, setSelectedStreamId] = useState(''); const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  const { tabs, setTabs, activeTabId, setActiveTabId } = useAppTabs();
  const { workspaceFiles, openFile, saveFile } = useWorkspaceFiles({ selectedAgentId, targets: activeTargets, setTabs, setActiveTabId });
  const { attached, setAttachment, clearAttachment, removeAttachment, isNewSession, leaveNewSessionForMessage, sessions, sessionId, turns, chatError, reportError, clearError, isLoadingConversation, draft, setDraft, refreshSessions, refreshConversation, selectSession: selectChatSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent, resetSession, appendTurn, storeToolActivity, toolActivityForRun } = useChatSession(selectedAgentId, activeTargets);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSessionComposerOpen, setIsSessionComposerOpen] = useState(false);
  const [isGroupComposerOpen, setIsGroupComposerOpen] = useState(false);
  const [groupComposerName, setGroupComposerName] = useState('');
  const [groupComposerAgents, setGroupComposerAgents] = useState<string[]>([]);
  const [groupComposerError, setGroupComposerError] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [sessionComposerName, setSessionComposerName] = useState('');
  const [sessionComposerError, setSessionComposerError] = useState('');
  const { leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, leftSplit, setLeftSplit, rightSplit, setRightSplit, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel } = usePersistedLayout();
  const [tasks, setTasks] = useState<Task[]>([{ title: 'Review pending validation checks', status: 'In progress', owner: 'Luna' }, { title: 'Update workspace documentation', status: 'Queued', owner: 'Terra' }]);
  const runtimeProviders = useRef([]);
  const { agents, setAgents, refreshAgents } = useRuntimeAgents({
    selectedAgentId,
    targets: activeTargets,
    setSelectedAgentId,
    parentSessionIdForAgent,
    runtimeProviders,
    setSelectedStreamId,
    // A configured Burrow may intentionally have no agents. Do not hijack
    // navigation to Settings when the registry is empty or briefly unavailable.
    onNoAgents: () => {},
    reportError,
  });
  const [theme, setTheme] = usePersistedTheme();
  const loadedSelected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  // Settings must remain reachable when the first agent has not been created yet.
  // The placeholder is only used for the settings form; chat still waits for a real agent.
  const selected = loadedSelected ?? { id: '', name: '', avatar: '', activity: 'Disabled', context: null, provider: '', model: '', effort: '', temperature: 0.7, workspace: '', files: [], subagents: [] };
  const { accounts, anthropicUsage, modelConnectionsLoaded, openAiUsage, operatorProfile, providerConnectionStatus, refreshModelConnections, reorderAccounts, savedProviders, setOperatorProfile } = useRuntimeDashboard({ selectedProvider: selected.provider, setAgents, runtimeProviders, reportError, target: activeTarget });
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const railAgents = agents;
  const panelContext = useMemo(() => ({ accounts, tasks, selected: selected ?? null, tabs, activeTab }), [accounts, tasks, selected, tabs, activeTab]);
  // The NDJSON stream is the authority for a live run. Polling traces here used
  // to race the stream and replace its tool card with stale snapshots.
  const selectAgent = (agent: Agent) => {
    // A parent row must never fall back to the currently displayed child. If
    // the session list has not hydrated yet, let useChatSession resolve the
    // parent's session instead of binding the chat to a stale/child session.
    prepareAgentSelection(agent.id);
    setSelectedAgentId(agent.id);
    setSelectedStreamId(agent.id);
    setActiveTabId('chat');
  };
  const selectSession = (targetSessionId: string) => {
    if (!selectedAgentId || !targetSessionId || targetSessionId === sessionId) return;
    setSelectedStreamId(selectedAgentId);
    selectChatSession(targetSessionId);
    setActiveTabId('chat');
  };
  const createNamedSession = async (name: string): Promise<string | null> => {
    if (!selectedAgentId || isCreatingSession || activeRunId) return 'A session cannot be created while the current run is active.';
    const targetSessionId = name.trim();
    if (!targetSessionId) return 'Give the session a name.';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(targetSessionId)) return 'Use 1–80 letters, numbers, hyphens, or underscores; start with a letter or number.';
    if (sessions.some((session) => session.id === targetSessionId)) return `A session named “${targetSessionId}” already exists.`;
    setIsCreatingSession(true); clearError();
    try {
      const owner = targetForResource(apiTargets, selectedAgentId);
      await apiForTarget(owner.target, `/api/sessions/default/fork?agentId=${encodeURIComponent(owner.resourceId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSessionId }) });
      await apiForTarget(owner.target, `/api/sessions/${encodeURIComponent(targetSessionId)}/reset?agentId=${encodeURIComponent(owner.resourceId)}`, { method: 'POST' });
      await refreshSessions(selectedAgentId);
      selectSession(targetSessionId);
      setIsSessionComposerOpen(false);
      setSessionComposerName(''); setSessionComposerError('');
      return null;
    } catch (error) {
      const message = `Could not create session: ${(error as Error).message}`;
      reportError(message);
      return message;
    } finally { setIsCreatingSession(false); }
  };
  const createGroupChat = async () => {
    const name = groupComposerName.trim();
    if (!name) return setGroupComposerError('Give the group chat a name.');
    if (groupComposerAgents.length < 2) return setGroupComposerError('Select at least two agents.');
    setIsCreatingGroup(true); setGroupComposerError('');
    try {
      const response = await api<{ channel?: { id?: string; name?: string } } | { id?: string; name?: string }>('/api/group-channels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, participantAgentIds: groupComposerAgents }) });
      const channel = ('channel' in response ? response.channel : response) as { id?: string; name?: string } | undefined;
      if (!channel?.id) throw new Error('The server did not return a group chat id.');
      setTabs((current) => current.some((tab) => tab.id === `group:${channel.id}`) ? current : [...current, { id: `group:${channel.id}`, label: channel.name || name, kind: 'group', channelId: channel.id }]);
      setActiveTabId(`group:${channel.id}`); setIsGroupComposerOpen(false); setGroupComposerName(''); setGroupComposerAgents([]);
    } catch (error) { setGroupComposerError(`Could not create group chat: ${(error as Error).message}`); }
    finally { setIsCreatingGroup(false); }
  };
  const toggleGroupAgent = (agentId: string) => setGroupComposerAgents((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
  const toggleAgent = (agentId: string) => setExpandedAgents((current) => { const next = new Set(current); if (next.has(agentId)) next.delete(agentId); else next.add(agentId); return next; });
  const selectSubagent = (agentId: string, subagentId: string) => {
    const subagent = agents.find((agent) => agent.id === agentId)?.subagents.find((item) => item.id === subagentId);
    if (!subagent) return;

    setSelectedAgentId(agentId);
    setSelectedStreamId(subagentId);
    // Keep the displayed child session separate from the parent session used by
    // /api/agent-status polling.
    // Rail IDs are target-qualified so separate remote nodes can expose the
    // same child session ID. The remote backend, however, owns the unqualified
    // child session ID; sending `node::session` makes its conversation lookup
    // fail and leaves the chat oscillating between loading and empty state.
    selectChildSession(agentId, subagent.resourceId ?? subagent.id);
    setActiveTabId('chat');
  };
  const updateAgent = async (patch: Partial<Agent>) => {
    if (!selected) return;
    const next = { ...selected, ...patch };
    const connection = savedProviders.find((item) => item.provider === next.provider && item.models.includes(next.model));
    if (!connection) return;
    try {
      const owner = targetForResource(apiTargets, selected.id);
      const { selection } = await apiForTarget<{ selection: { connectionId: string; model: string; reasoningEffort: string; temperature?: number } }>(owner.target, `/api/agents/${encodeURIComponent(owner.resourceId)}/model-selection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.id, model: next.model, reasoningEffort: next.effort, temperature: next.temperature }),
      });
      const temperature = typeof selection.temperature === 'number' && Number.isFinite(selection.temperature) ? selection.temperature : next.temperature;
      setAgents((all) => all.map((agent) => agent.id === selected.id ? { ...agent, provider: connection.provider, model: selection.model, effort: selection.reasoningEffort, temperature } : agent));
    } catch (error) {
      reportError(`Could not save model selection: ${(error as Error).message}`);
    }
  };

  const closeTab = (id: string) => { if (id === 'chat') return; setTabs((all) => all.filter((tab) => tab.id !== id)); if (activeTabId === id) setActiveTabId('chat'); };
  const startNewSession = async () => {
    if (!selectedAgentId || isResettingSession || activeRunId) return;
    setIsResettingSession(true);
    clearError();
    try {
      await resetSession();
      setDraft('');
      clearAttachment();
      setActiveTabId('chat');
      await refreshSessions();
    } catch (error) {
      reportError(error instanceof Error ? `Could not start a new session: ${error.message}` : 'Could not start a new session.');
    } finally {
      setIsResettingSession(false);
    }
  };
  const attachImage = (files: File[]) => {
    const accepted = files.filter((file) => {
      if (!isSupportedAttachment(file)) { reportError('Attach an image or text document.'); return false; }
      if (file.size > 22_000_000) { reportError('Attachment is too large. Maximum file size is 22 MB.'); return false; }
      return true;
    });
    void Promise.all(accepted.map((file, index) => readAttachment(file, attachmentDisplayName(file, index + 1)))).then((attachments) => { setAttachment(attachments); clearError(); }).catch(() => reportError('Could not read the attachment.'));
  };
  const setParentActivity = (agentId: string, status: string) => {
    setAgents((current) => current.map((agent) => agent.id === agentId ? { ...agent, activity: formatAgentActivity(status.toLowerCase()) } : agent));
  };
  const selectedTarget = targetForResource(apiTargets, selectedAgentId).target;
  const { activeRunForSelection, activeRunId, sendMessage, cancelRun, liveProgress, liveAnswer } = useChatRun({ selectedAgentId, selected, selectedTarget, savedProviders, session: { attached, clearAttachment, sessionId, draft, setDraft, clearError, reportError, leaveNewSessionForMessage, appendTurn, storeToolActivity, toolActivityForRun, refreshSessions, refreshConversation }, setAgentActivity: setParentActivity });
  const resizeVertical = (kind: 'left' | 'right', event: PointerEvent) => { const start = event.clientY; const initial = kind === 'left' ? leftSplit : rightSplit; const host = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect(); if (!host) return; const move = (e: globalThis.PointerEvent) => { const next = initial + ((e.clientY - start) / host.height) * 100; if (kind === 'left') setLeftSplit(Math.min(75, Math.max(25, next))); else setRightSplit(Math.min(75, Math.max(25, next))); }; listenResize(move); };
  const style = { '--left': leftCollapsed ? '38px' : '320px', '--right': rightCollapsed ? '38px' : '320px', '--left-split': `${leftSplit}%`, '--right-split': `${rightSplit}%` } as React.CSSProperties;
  if (!selected && page !== 'settings' && page !== 'archive') return <main className="cockpit loading-app"><p>{chatError || (agents.length === 0 ? 'No agents configured yet.' : 'Loading Burrow agents…')}</p></main>;
  const renderRailPanel = (panel: PanelId) => {
    if (panel === 'agents') return <AgentsPanel agents={railAgents} selectedStreamId={selectedStreamId} expandedAgents={expandedAgents} onToggleAgent={toggleAgent} onSelectAgent={selectAgent} onSelectSubagent={selectSubagent} />;
    if (panel === 'system') return <SystemPanel />;
    if (panel === 'workspace') return <WorkspacePanel selected={{ ...selected, files: workspaceFiles }} onOpenFile={openFile} />;
    if (panel === 'codex') return <CodexAccounts accounts={accounts} onReorder={reorderAccounts} />;
    if (panel === 'accounts') return <AccountStatus providers={savedProviders} />;
    return <div className="panel-body"><p className="hint">No panel selected.</p></div>;
  };
  const changePage = (nextPage: Page) => {
    if (nextPage === 'settings' && !previewFirstRun) setSettingsTab('general');
    setPage(nextPage);
    if (nextPage === 'chat' && page !== 'chat') {
      void Promise.all([refreshSessions(), refreshConversation()]).catch((error: Error) => reportError(`Could not refresh chat: ${error.message}`));
    }
  };
  return <main className={`cockpit ${page === 'tasks' || page === 'archive' ? 'tasks-mode' : page === 'settings' ? 'settings-mode' : ''}`} data-theme={theme} style={style}>
    <header className="app-header">
      {apiTargets.length > 1 && <TargetSelector targets={apiTargets} selectedId={activeTarget?.id ?? 'local'} onChange={(id) => { setSelectedTargetId(id); setSelectedAgentId(''); }} />}
      <nav className="page-tabs" aria-label="Primary navigation">{(['chat', 'tasks', 'archive', 'settings'] as Page[]).map((item) => <button className={page === item ? 'active' : ''} onClick={() => changePage(item)} key={item} aria-current={page === item ? 'page' : undefined}>{item}</button>)}</nav>
    </header>
    {page === 'chat' && <WorkspaceRail collapsed={leftCollapsed} topPanel={leftTopPanel} bottomPanel={leftBottomPanel} renderPanel={renderRailPanel} onExpand={() => setLeftCollapsed(false)} onCollapse={() => setLeftCollapsed(true)} onResizeSplit={(event) => resizeVertical('left', event)} />}
    <section className={`workspace ${page === 'tasks' || page === 'archive' ? 'tasks-workspace' : page === 'settings' ? 'settings-workspace' : ''}`}><Suspense fallback={<div className="page-loading" role="status">Loading page…</div>}>{page === 'tasks' ? <Tasks agents={agents} /> : page === 'archive' ? <Archive agents={agents} /> : page === 'settings' ? <Settings key={activeTarget?.id ?? 'local'} tab={settingsTab} setTab={setSettingsTab} agents={agents} selected={selected} targets={apiTargets} onOperatorProfileChanged={setOperatorProfile} onFirstRunComplete={() => setPage('chat')} savedProviders={savedProviders} onModelConnectionsChanged={refreshModelConnections} onAgentsChanged={refreshAgents} leftTopPanel={leftTopPanel} setLeftTopPanel={setLeftTopPanel} leftBottomPanel={leftBottomPanel} setLeftBottomPanel={setLeftBottomPanel} rightTopPanel={rightTopPanel} setRightTopPanel={setRightTopPanel} rightBottomPanel={rightBottomPanel} setRightBottomPanel={setRightBottomPanel} theme={theme} setTheme={setTheme} previewFirstRun={previewFirstRun} /> : <><div className="document-tabs">{tabs.map((tab) => <button className={activeTabId === tab.id ? 'active' : ''} onClick={() => setActiveTabId(tab.id)} key={tab.id}>{tab.label}{(tab.kind === 'file' || tab.kind === 'group') && <span className="document-tab-close" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeTab(tab.id); } }} aria-label={`Close ${tab.label}`}>×</span>}</button>)}</div><ChatModelSelector selected={selected} savedProviders={savedProviders} updateAgent={updateAgent} sessions={sessions} sessionId={sessionId} onSessionChange={selectSession} onNewSession={startNewSession} onNewNamedSession={() => setIsSessionComposerOpen(true)} onCreateGroup={() => { setGroupComposerError(''); setIsGroupComposerOpen(true); }} locked={Boolean(activeRunForSelection)} />{activeTab.kind === 'file' ? <Editor tab={activeTab} setTabs={setTabs} onSave={saveFile} /> : activeTab.kind === 'group' && activeTab.channelId ? <GroupChannelsPage channelId={activeTab.channelId} agents={agents} operator={operatorProfile} /> : <Chat selected={selected} parent={selected} operator={operatorProfile} draft={draft} setDraft={setDraft} attached={attached} onAttach={attachImage} onRemoveAttachment={removeAttachment} isNewSession={isNewSession} turns={turns} isLoading={isLoadingConversation} error={chatError} isSending={Boolean(activeRunForSelection)} activeRunId={activeRunId} activeToolActivity={activeRunForSelection ? toolActivityForRun(activeRunForSelection.runId) : undefined} liveProgress={liveProgress} liveAnswer={liveAnswer} onSend={sendMessage} onCancel={cancelRun} />}</>}</Suspense></section>
    {page === 'chat' && <RightRail collapsed={rightCollapsed} topPanel={rightTopPanel} bottomPanel={rightBottomPanel} renderPanel={renderRailPanel} onExpand={() => setRightCollapsed(false)} onCollapse={() => setRightCollapsed(true)} onResizeSplit={(event) => resizeVertical('right', event)} />}
    {isGroupComposerOpen && <div className="session-dialog-backdrop" role="presentation" onMouseDown={() => { if (!isCreatingGroup) setIsGroupComposerOpen(false); }}><section className="session-dialog group-dialog" role="dialog" aria-modal="true" aria-labelledby="new-group-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">CHAT</span><h2 id="new-group-title">New group chat</h2></div><button className="session-dialog-close" type="button" aria-label="Close new group chat" onClick={() => setIsGroupComposerOpen(false)} disabled={isCreatingGroup}>×</button></header><form onSubmit={(event) => { event.preventDefault(); void createGroupChat(); }}><label htmlFor="new-group-name">Group name</label><input id="new-group-name" autoFocus value={groupComposerName} onChange={(event) => setGroupComposerName(event.target.value)} placeholder="Design review" maxLength={80} disabled={isCreatingGroup} /><fieldset><legend>Participants</legend>{agents.filter((agent) => !agent.subagents?.length || agent.id).map((agent) => <label key={agent.id}><input type="checkbox" checked={groupComposerAgents.includes(agent.id)} onChange={() => toggleGroupAgent(agent.id)} disabled={isCreatingGroup} />{agent.name}</label>)}</fieldset>{groupComposerError && <p className="session-dialog-error" role="alert">{groupComposerError}</p>}<footer><button className="secondary" type="button" onClick={() => setIsGroupComposerOpen(false)} disabled={isCreatingGroup}>Cancel</button><button className="primary" type="submit" disabled={isCreatingGroup}>{isCreatingGroup ? 'Creating…' : 'Create group chat'}</button></footer></form></section></div>}
    {isSessionComposerOpen && <div className="session-dialog-backdrop" role="presentation" onMouseDown={() => { if (!isCreatingSession) { setIsSessionComposerOpen(false); setSessionComposerError(''); } }}><section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">SESSIONS</span><h2 id="new-session-title">New session</h2></div><button className="session-dialog-close" type="button" aria-label="Close new session" onClick={() => { setIsSessionComposerOpen(false); setSessionComposerError(''); }} disabled={isCreatingSession}>×</button></header><form onSubmit={(event) => { event.preventDefault(); void createNamedSession(sessionComposerName).then((error) => { if (error) setSessionComposerError(error); }); }}><label htmlFor="new-session-name">Session name</label><input id="new-session-name" autoFocus value={sessionComposerName} onChange={(event) => { setSessionComposerName(event.target.value); setSessionComposerError(''); }} placeholder="planning" maxLength={80} disabled={isCreatingSession} />{sessionComposerError && <p className="session-dialog-error" role="alert">{sessionComposerError}</p>}<footer><button className="secondary" type="button" onClick={() => setIsSessionComposerOpen(false)} disabled={isCreatingSession}>Cancel</button><button className="primary" type="submit" disabled={isCreatingSession || !sessionComposerName.trim()}>{isCreatingSession ? 'Creating…' : 'Create session'}</button></footer></form></section></div>}
    <footer className="status-bar"><span className={providerConnectionStatus === 'connected' ? 'ok' : providerConnectionStatus === 'disconnected' ? 'error' : 'checking'}><i className="dot" /> {providerConnectionStatus === 'connected' ? 'Connected' : providerConnectionStatus === 'disconnected' ? 'Not Connected' : 'Checking…'}</span>{anthropicUsage?.windows.filter((window) => window.key === 'five_hour' || window.key === 'seven_day').map((window) => <span className="usage-meter" key={window.key}><span className="usage-meter-label">{window.key === 'five_hour' ? '5hr' : '7day'}</span><span className="usage-meter-track"><span className="usage-meter-fill" style={{ width: `${100 - Math.min(100, Math.max(0, window.usedPercent))}%` }} /></span><span className="usage-meter-value">{Math.round(100 - Math.min(100, Math.max(0, window.usedPercent)))}% <span className="usage-meter-reset">{formatUsageReset(window.resetAt)}</span></span></span>)}{openAiUsage?.windows.filter((window) => window.usedPercent != null).map((window) => <span className="usage-meter" key={`openai-${window.key}`}><span className="usage-meter-label">{window.label}</span><span className="usage-meter-track"><span className="usage-meter-fill" style={{ width: `${100 - Math.min(100, Math.max(0, window.usedPercent ?? 0))}%` }} /></span><span className="usage-meter-value">{Math.round(100 - Math.min(100, Math.max(0, window.usedPercent ?? 0)))}% <span className="usage-meter-reset">{formatUsageReset(window.resetAt)}</span></span></span>)}<span className="status-version">v. {runtimeVersion ?? '—'}</span></footer>
  </main>;
}

export const App = AppContent;


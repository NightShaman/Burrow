import { lazy, Suspense, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Agent, Page, PanelId, SettingsTab } from './app/types';
import { apiForTarget, attachmentDisplayName, type ChatAttachment } from './app/api';
import { targetForResource, useApiTargets } from './app/apiTargets';
import { TargetSelector } from './features/navigation/TargetSelector';
import { listenResize, usePersistedTheme, usePersistedLayout } from './app/usePersistedLayout';
import { useAppTabs } from './app/useAppTabs';
import { useRuntimeDashboard } from './app/useRuntimeDashboard';
import { formatAgentActivity, useRuntimeAgents } from './app/useRuntimeAgents';
import { useRuntimeSelection } from './app/useRuntimeSelection';
import { AgentsPanel, SystemPanel, WorkspacePanel, WorkspaceRail } from './features/workspace/WorkspaceRail';
import { CodexAccounts, RightRail } from './features/panels/RightRail';
import { AccountStatus } from './features/panels/AccountStatus';
import { Chat, ChatModelSelector, Editor } from './features/chat/ChatPage';
import { useChatRun } from './features/chat/useChatRun';
import { useChatComposers } from './features/chat/useChatComposers';
import { ChatComposerDialogs } from './features/chat/ChatComposerDialogs';
import { AppStatusBar, DocumentTabs } from './app/AppChrome';

const readAttachment = (file: File, name: string): Promise<ChatAttachment> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve({ name, type: file.type || 'application/octet-stream', size: file.size, encoding: 'data-url', content: reader.result }) : reject(new Error('Invalid attachment content')); reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment')); reader.readAsDataURL(file); });
const isSupportedAttachment = (file: File) => file.type.startsWith('image/') || file.type.startsWith('text/') || ['application/json', 'application/xml', 'application/rtf', 'application/pdf'].includes(file.type) || /\.(txt|md|markdown|json|csv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|yaml|yml|rtf|pdf)$/i.test(file.name);
import { useWorkspaceFiles } from './features/workspace/useWorkspaceFiles';
import { useChatSession } from './features/chat/useChatSession';
const Settings = lazy(() => import('./features/settings/SettingsPage').then(({ Settings }) => ({ default: Settings })));
const Tasks = lazy(() => import('./features/tasks/TasksPage').then(({ Tasks }) => ({ default: Tasks })));
const Archive = lazy(() => import('./features/tasks/ArchivePage').then(({ Archive }) => ({ default: Archive })));
import { GroupChannelsPage } from './features/groups/GroupChannelsPage';

function AppContent() {
  const previewFirstRun = new URLSearchParams(window.location.search).get('previewFirstRun') === '1';
 const [page, setPage] = useState<Page>(() => previewFirstRun ? 'settings' : 'chat'); const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => previewFirstRun ? 'agents' : 'general');
  const { targets: apiTargets, loaded: apiTargetsLoaded } = useApiTargets();
  const { activeTarget, activeTargets, expandedAgents, runtimeVersion, selectedAgentId, selectedStreamId, selectChildStream, selectParentStream, selectTarget, setSelectedAgentId, setSelectedStreamId, showParentStream, toggleAgentExpanded } = useRuntimeSelection({ targets: apiTargets, targetsLoaded: apiTargetsLoaded });
  const { tabs, setTabs, activeTabId, setActiveTabId } = useAppTabs();
  const { leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, leftSplit, setLeftSplit, rightSplit, setRightSplit, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel } = usePersistedLayout();
  const workspacePanelVisible = page === 'chat' && !leftCollapsed && (leftTopPanel === 'workspace' || leftBottomPanel === 'workspace');
  const { workspaceFiles, openFile, saveFile } = useWorkspaceFiles({ selectedAgentId, targets: activeTargets, setTabs, setActiveTabId, pollingEnabled: workspacePanelVisible });
  const { attached, setAttachment, clearAttachment, removeAttachment, isNewSession, leaveNewSessionForMessage, sessions, sessionId, turns, chatError, reportError, clearError, isLoadingConversation, draft, setDraft, refreshSessions, refreshConversation, selectSession: selectChatSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent, resetSession, appendTurn, storeToolActivity, toolActivityForRun, a2aActivities } = useChatSession(selectedAgentId, activeTargets);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const runtimeProviders = useRef([]);
  const { agents, setAgents, refreshAgents, registryState, registryError, registryStale } = useRuntimeAgents({
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
  const { accounts, anthropicUsage, openAiUsage, operatorProfile, providerConnectionStatus, refreshModelConnections, reorderAccounts, savedProviders, setOperatorProfile } = useRuntimeDashboard({ selectedProvider: selected.provider, setAgents, runtimeProviders, reportError, target: activeTarget });
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const railAgents = agents;
  // The NDJSON stream is the authority for a live run. Polling traces here used
  // to race the stream and replace its tool card with stale snapshots.
  const selectAgent = (agent: Agent) => {
    // A parent row must never fall back to the currently displayed child. If
    // the session list has not hydrated yet, let useChatSession resolve the
    // parent's session instead of binding the chat to a stale/child session.
    prepareAgentSelection(agent.id);
    selectParentStream(agent.id);
    setActiveTabId('chat');
  };
  const selectSession = (targetSessionId: string) => {
    if (!selectedAgentId || !targetSessionId || targetSessionId === sessionId) return;
    showParentStream();
    selectChatSession(targetSessionId);
    setActiveTabId('chat');
  };
  const selectSubagent = (agentId: string, subagentId: string) => {
    const subagent = agents.find((agent) => agent.id === agentId)?.subagents.find((item) => item.id === subagentId);
    if (!subagent) return;

    selectChildStream(agentId, subagentId);
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
  const composers = useChatComposers({ selectedAgentId, activeRunId, sessions, targets: apiTargets, activeTarget, refreshSessions, selectSession, reportError, clearError, setTabs, setActiveTabId });
  const resizeVertical = (kind: 'left' | 'right', event: PointerEvent) => { const start = event.clientY; const initial = kind === 'left' ? leftSplit : rightSplit; const host = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect(); if (!host) return; const move = (e: globalThis.PointerEvent) => { const next = initial + ((e.clientY - start) / host.height) * 100; if (kind === 'left') setLeftSplit(Math.min(75, Math.max(25, next))); else setRightSplit(Math.min(75, Math.max(25, next))); }; listenResize(move); };
  const style = { '--left': leftCollapsed ? '38px' : '320px', '--right': rightCollapsed ? '38px' : '320px', '--left-split': `${leftSplit}%`, '--right-split': `${rightSplit}%` } as React.CSSProperties;
  // An empty registry is a valid configured state: keep the cockpit visible so
  // operators can inspect the chat and open Settings instead of hitting a
  // full-page dead end. Only block while the registry is still loading or
  // genuinely unavailable.
  if (!loadedSelected && registryState !== 'empty' && page !== 'settings' && page !== 'archive') {
    const registryMessage = registryState === 'unavailable'
      ? `${activeTarget.name} is unavailable${registryError ? `: ${registryError}` : '.'}`
      : 'Loading Burrow agents…';
    return <main className="cockpit loading-app" data-theme={theme}><p role={registryState === 'unavailable' ? 'alert' : 'status'}>{registryMessage}</p>{registryState !== 'loading' && <button type="button" onClick={() => setPage('settings')}>Open settings</button>}</main>;
  }
  const renderRailPanel = (panel: PanelId) => {
    if (panel === 'agents') return <AgentsPanel agents={railAgents} selectedStreamId={selectedStreamId} expandedAgents={expandedAgents} onToggleAgent={toggleAgentExpanded} onSelectAgent={selectAgent} onSelectSubagent={selectSubagent} />;
    if (panel === 'system') return <SystemPanel target={activeTarget} provider={selected.provider} providerConnectionStatus={providerConnectionStatus} />;
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
      {apiTargets.length > 1 && <TargetSelector targets={apiTargets} selectedId={activeTarget?.id ?? 'local'} onChange={selectTarget} />}
      <nav className="page-tabs" aria-label="Primary navigation">{(['chat', 'tasks', 'archive', 'settings'] as Page[]).map((item) => <button className={page === item ? 'active' : ''} onClick={() => changePage(item)} key={item} aria-current={page === item ? 'page' : undefined}>{item}</button>)}</nav>
    </header>
    {page === 'chat' && <WorkspaceRail collapsed={leftCollapsed} topPanel={leftTopPanel} bottomPanel={leftBottomPanel} renderPanel={renderRailPanel} onExpand={() => setLeftCollapsed(false)} onCollapse={() => setLeftCollapsed(true)} onResizeSplit={(event) => resizeVertical('left', event)} />}
    <section className={`workspace ${page === 'tasks' || page === 'archive' ? 'tasks-workspace' : page === 'settings' ? 'settings-workspace' : ''}`}><div className="workspace-watermark" aria-hidden="true"><img src="/burrow-logo.png" alt="" /></div><Suspense fallback={<div className="page-loading" role="status">Loading page…</div>}>{page === 'tasks' ? <Tasks agents={agents} /> : page === 'archive' ? <Archive agents={agents} /> : page === 'settings' ? <Settings key={activeTarget?.id ?? 'local'} tab={settingsTab} setTab={setSettingsTab} agents={agents} selected={selected} targets={apiTargets} onOperatorProfileChanged={setOperatorProfile} onFirstRunComplete={() => setPage('chat')} savedProviders={savedProviders} onModelConnectionsChanged={refreshModelConnections} onAgentsChanged={refreshAgents} leftTopPanel={leftTopPanel} setLeftTopPanel={setLeftTopPanel} leftBottomPanel={leftBottomPanel} setLeftBottomPanel={setLeftBottomPanel} rightTopPanel={rightTopPanel} setRightTopPanel={setRightTopPanel} rightBottomPanel={rightBottomPanel} setRightBottomPanel={setRightBottomPanel} theme={theme} setTheme={setTheme} previewFirstRun={previewFirstRun} /> : <><DocumentTabs tabs={tabs} activeTabId={activeTabId} onSelect={setActiveTabId} onClose={closeTab} /><ChatModelSelector selected={selected} savedProviders={savedProviders} updateAgent={updateAgent} sessions={sessions} sessionId={sessionId} onSessionChange={selectSession} onNewSession={startNewSession} onNewNamedSession={composers.session.open} onCreateGroup={composers.group.open} locked={Boolean(activeRunForSelection)} />{activeTab.kind === 'file' ? <Editor tab={activeTab} setTabs={setTabs} onSave={saveFile} /> : activeTab.kind === 'group' && activeTab.channelId ? <GroupChannelsPage channelId={activeTab.channelId} target={apiTargets.find((target) => target.id === activeTab.targetId) ?? activeTarget} agents={agents} operator={operatorProfile} /> : <Chat selected={selected} parent={selected} operator={operatorProfile} draft={draft} setDraft={setDraft} attached={attached} onAttach={attachImage} onRemoveAttachment={removeAttachment} isNewSession={isNewSession} turns={turns} isLoading={isLoadingConversation} error={chatError} isSending={Boolean(activeRunForSelection)} activeRunId={activeRunId} activeToolActivity={activeRunForSelection ? toolActivityForRun(activeRunForSelection.runId) : undefined} liveProgress={liveProgress} liveAnswer={liveAnswer} a2aActivities={a2aActivities} onSend={sendMessage} onCancel={cancelRun} />}</>}</Suspense></section>
    {page === 'chat' && <RightRail collapsed={rightCollapsed} topPanel={rightTopPanel} bottomPanel={rightBottomPanel} renderPanel={renderRailPanel} onExpand={() => setRightCollapsed(false)} onCollapse={() => setRightCollapsed(true)} onResizeSplit={(event) => resizeVertical('right', event)} />}
    <ChatComposerDialogs agents={agents} session={composers.session} group={composers.group} />
    <AppStatusBar anthropicUsage={anthropicUsage} openAiUsage={openAiUsage} runtimeVersion={runtimeVersion} registryStale={registryStale} />
  </main>;
}

export const App = AppContent;


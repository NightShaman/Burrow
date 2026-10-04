import { readAttachment } from './app/readAttachment';
import { isWithinAttachmentBudget } from './features/chat/attachmentValidation';
import { useModelSelectionWriter } from './app/useModelSelectionWriter';
import { useConfirm } from './app/ConfirmDialog';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Agent, Page, PanelId, SettingsTab } from './app/types';
import { api, attachmentDisplayName, type SetupStatus } from './app/api';
import { loadModPanels, modsChangedEvent, type ModPanel } from './app/modPanels';
import { ModPanelHost } from './features/mods/ModPanelHost';
import { clampRailSplit, listenResize, usePersistedTheme, usePersistedLayout } from './app/usePersistedLayout';
import { useAgentRailPreferences } from './app/useAgentRailPreferences';
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


const isSupportedAttachment = (file: File) => file.type.startsWith('image/') || file.type.startsWith('text/') || ['application/json', 'application/xml', 'application/rtf'].includes(file.type) || /\.(txt|md|markdown|json|csv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|yaml|yml|rtf)$/i.test(file.name);
import { useWorkspaceFiles } from './features/workspace/useWorkspaceFiles';
import { useChatSession } from './features/chat/useChatSession';
const Settings = lazy(() => import('./features/settings/SettingsPage').then(({ Settings }) => ({ default: Settings })));
const Tasks = lazy(() => import('./features/tasks/TasksPage').then(({ Tasks }) => ({ default: Tasks })));
const Albdruck = lazy(() => import('./features/albdruck/AlbdruckPage').then(({ Albdruck }) => ({ default: Albdruck })));
const Archive = lazy(() => import('./features/tasks/ArchivePage').then(({ Archive }) => ({ default: Archive })));
import { GroupChannelsPage } from './features/groups/GroupChannelsPage';
import { Forge } from './features/forge/ForgePage';

function AppContent() {
  const previewFirstRun = new URLSearchParams(window.location.search).get('previewFirstRun') === '1';
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const firstRun = previewFirstRun || setupStatus?.wizardStep === 'fresh' || setupStatus?.wizardStep === 'incomplete';
  const [page, setPage] = useState<Page>(() => previewFirstRun ? 'settings' : 'chat'); const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => previewFirstRun ? 'agents' : 'general');
  useEffect(() => {
    if (previewFirstRun) return;
    let cancelled = false;
    void api<SetupStatus>('/api/setup/status').then((status) => { if (!cancelled) setSetupStatus(status); }).catch(() => { if (!cancelled) setSetupStatus(null); });
    return () => { cancelled = true; };
  }, [previewFirstRun]);
  useEffect(() => {
    if (firstRun) { setPage('settings'); setSettingsTab('agents'); }
  }, [firstRun]);
  const completeFirstRun = () => { setSetupStatus((status) => status ? { ...status, wizardStep: 'ready', configured: true } : status); setPage('chat'); };
  // Burrow is a single local runtime. Node Goblin integrations are explicit mod-owned APIs.
  const [modPanels, setModPanels] = useState<ModPanel[]>([]);
  const [modsLoaded, setModsLoaded] = useState(false);
  const [activeModId, setActiveModId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const refresh = () => { const current = ++sequence; void loadModPanels().then((panels) => { if (live && current === sequence) { setModPanels(panels); setModsLoaded(true); } }).catch(() => { if (live && current === sequence) { setModPanels([]); setModsLoaded(true); } }); };
    refresh();
    window.addEventListener(modsChangedEvent, refresh);
    const interval = window.setInterval(refresh, 30000);
    return () => { live = false; window.removeEventListener(modsChangedEvent, refresh); window.clearInterval(interval); };
  }, []);
  const activeMod = modPanels.find((mod) => mod.modId === activeModId);
  useEffect(() => { if (modsLoaded && activeModId && !activeMod) { setActiveModId(null); setPage('chat'); } }, [activeModId, activeMod, modsLoaded]);
  const { expandedAgents, selectedAgentId, selectedStreamId, selectChildStream, selectParentStream, setSelectedAgentId, setSelectedStreamId, showParentStream, toggleAgentExpanded } = useRuntimeSelection();
  const { tabs, setTabs, activeTabId, setActiveTabId } = useAppTabs();
  const { leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, leftSplit, setLeftSplit, rightSplit, setRightSplit, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel, leftRailLayout, setLeftRailLayout, rightRailLayout, setRightRailLayout, leftSinglePanel, setLeftSinglePanel, rightSinglePanel, setRightSinglePanel } = usePersistedLayout();
  const workspacePanelVisible = page === 'chat' && !leftCollapsed && (leftRailLayout === 'divided' ? leftTopPanel === 'workspace' || leftBottomPanel === 'workspace' : leftSinglePanel === 'workspace');
  const { workspaceFiles, openFile, saveFile } = useWorkspaceFiles({ tabs, selectedAgentId, setTabs, setActiveTabId, pollingEnabled: workspacePanelVisible });
  const { isAttachmentScopeCurrent, attached, setAttachment, clearAttachment, removeAttachment, isNewSession, leaveNewSessionForMessage, sessions, sessionId, turns, chatError, reportError, clearError, isLoadingConversation, draft, setDraft, refreshSessions, refreshConversation, selectSession: selectChatSession, prepareAgentSelection, selectChildSession, parentSessionIdForAgent, resetSession, appendTurn, storeToolActivity, toolActivityForRun, a2aActivities, runtimeRun, runtimeChildActivities, cancelRuntimeRun } = useChatSession(selectedAgentId);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const runtimeProviders = useRef([]);
  const { agents, setAgents, refreshAgents, registryState, registryError, registryStale } = useRuntimeAgents({
    selectedAgentId,
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
  const [agentRailPreferences, setAgentRailPreferences] = useAgentRailPreferences();
  const loadedSelected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  // Settings must remain reachable when the first agent has not been created yet.
  // The placeholder is only used for the settings form; chat still waits for a real agent.
  const selected = loadedSelected ?? { id: '', name: '', avatar: '', activity: 'Disabled', context: null, provider: '', model: '', effort: '', temperature: 0.7, workspace: '', files: [], subagents: [] };
  const { accounts, anthropicUsage, openAiUsage, operatorProfile, providerConnectionStatus, refreshModelConnections, reorderAccounts, savedProviders, setOperatorProfile } = useRuntimeDashboard({ selectedProvider: selected.provider, setAgents, runtimeProviders, reportError });
  const visibleTabs = tabs;
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0];
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
  const writeModelSelection = useModelSelectionWriter(savedProviders,
    (id, patch) => setAgents(all => all.map(agent => agent.id === id ? { ...agent, ...patch } : agent)), reportError);
  const updateAgent = async (patch: Partial<Agent>) => {
    if (selected) await writeModelSelection(selected, patch);
  };

  const confirmDiscard = useConfirm();
  const closeTab = async (id: string) => { if (id === 'chat') return; const tab = tabs.find(item => item.id === id); if (tab?.kind === 'file' && tab.savedContent !== undefined && tab.content !== tab.savedContent && !await confirmDiscard({ title: 'Discard unsaved edits?', message: `Close ${tab.label} without saving?`, confirmLabel: 'Discard edits', tone: 'danger' })) return; setTabs((all) => all.filter((tab) => tab.id !== id)); if (activeTabId === id) setActiveTabId('chat'); };
  const startNewSession = async () => {
    if (!selectedAgentId || isResettingSession || activeRunId) return;
    setIsResettingSession(true);
    clearError();
    try {
      if (!await resetSession() || !isAttachmentScopeCurrent()) return;
      setDraft('');
      clearAttachment();
      setActiveTabId('chat');
      await refreshSessions();
    } catch (error) {
      if (!isAttachmentScopeCurrent()) return;
      reportError(error instanceof Error ? `Could not start a new session: ${error.message}` : 'Could not start a new session.');
    } finally {
      setIsResettingSession(false);
    }
  };
  const attachImage = (files: File[]) => {
    const accepted = files.filter((file) => {
      if (!isSupportedAttachment(file)) { reportError(`${file.name}: Attach an image or text document. PDF extraction is not supported.`); return false; }
      if (!isWithinAttachmentBudget(attached.map((item) => item.size), file.size)) { reportError(`${file.name}: Attachment exceeds the client file, count, or batch safety budget.`); return false; }
      return true;
    });
    if (!accepted.length) return;
    void Promise.all(accepted.map((file, index) => readAttachment(file, attachmentDisplayName(file, index + 1)))).then((attachments) => { if (!isAttachmentScopeCurrent()) return; setAttachment(attachments); if (accepted.length === files.length) clearError(); }).catch(() => { if (isAttachmentScopeCurrent()) reportError('Could not read the attachment.'); });
  };
  const setParentActivity = (agentId: string, status: string) => {
    setAgents((current) => current.map((agent) => agent.id === agentId ? { ...agent, activity: formatAgentActivity(status.toLowerCase()) } : agent));
  };
  const { activeRunForSelection, activeRunId, sendMessage, cancelRun, liveProgress, liveAnswer } = useChatRun({ selectedAgentId, selected, savedProviders, session: { attached, clearAttachment, sessionId, draft, setDraft, clearError, reportError, leaveNewSessionForMessage, appendTurn, storeToolActivity, toolActivityForRun, refreshSessions, refreshConversation }, setAgentActivity: setParentActivity });
  const displayedRun = activeRunForSelection ?? runtimeRun;
  const cancelDisplayedRun = activeRunForSelection ? cancelRun : runtimeRun ? () => cancelRuntimeRun(runtimeRun) : () => {};
  const composers = useChatComposers({ sessionId, selectedAgentId, activeRunId, sessions, refreshSessions, selectSession, reportError, clearError, tabs, setTabs, setActiveTabId });
  const resizeVertical = (kind: 'left' | 'right', event: PointerEvent) => { const start = event.clientY; const initial = kind === 'left' ? leftSplit : rightSplit; const host = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect(); if (!host) return; const move = (e: globalThis.PointerEvent) => { const next = initial + ((e.clientY - start) / host.height) * 100; if (kind === 'left') setLeftSplit(clampRailSplit(next)); else setRightSplit(clampRailSplit(next)); }; listenResize(move); };
  const style = { '--left': leftCollapsed ? '38px' : '320px', '--right': rightCollapsed ? '38px' : '320px', '--left-split': `${leftSplit}%`, '--right-split': `${rightSplit}%` } as React.CSSProperties;
  // An empty registry is a valid configured state: keep the cockpit visible so
  // operators can inspect the chat and open Settings instead of hitting a
  // full-page dead end. Only block while the registry is still loading or
  // genuinely unavailable.
  if (!loadedSelected && registryState !== 'empty' && page !== 'settings' && page !== 'archive' && page !== 'albdruck' && !activeMod) {
    const registryMessage = registryState === 'unavailable'
      ? `Local runtime is unavailable${registryError ? `: ${registryError}` : '.'}`
      : 'Loading Burrow agents…';
    return <main className="cockpit loading-app" data-theme={theme}><p role={registryState === 'unavailable' ? 'alert' : 'status'}>{registryMessage}</p>{registryState !== 'loading' && <button type="button" onClick={() => setPage('settings')}>Open settings</button>}</main>;
  }
  const renderRailPanel = (panel: PanelId) => {
    if (panel === 'agents') return <AgentsPanel agents={railAgents} view={agentRailPreferences.view} order={agentRailPreferences.order} selectedStreamId={selectedStreamId} expandedAgents={expandedAgents} onToggleAgent={toggleAgentExpanded} onSelectAgent={selectAgent} onSelectSubagent={selectSubagent} />;
    if (panel === 'system') return <SystemPanel provider={selected.provider} providerConnectionStatus={providerConnectionStatus} />;
    if (panel === 'workspace') return <WorkspacePanel selected={{ ...selected, files: workspaceFiles }} onOpenFile={openFile} />;
    if (panel === 'codex') return <CodexAccounts accounts={accounts} onReorder={reorderAccounts} />;
    if (panel === 'accounts') return <AccountStatus providers={savedProviders} />;
    return <div className="panel-body"><p className="hint">No panel selected.</p></div>;
  };
  const changePage = (nextPage: Page) => {
    if (nextPage === 'settings' && !previewFirstRun) setSettingsTab('general');
    setActiveModId(null);
    setPage(nextPage);
    if (nextPage === 'chat' && page !== 'chat') {
      void Promise.all([refreshSessions(), refreshConversation()]).catch((error: Error) => reportError(`Could not refresh chat: ${error.message}`));
    }
  };
  return <main className={`cockpit ${page === 'tasks' || page === 'archive' || page === 'albdruck' ? 'tasks-mode' : page === 'forge' ? 'forge-mode' : page === 'settings' ? 'settings-mode' : activeMod ? 'mod-mode' : ''}`} data-theme={theme} style={style}>
    <header className="app-header">
      <nav className="page-tabs" aria-label="Primary navigation">
        {(['chat', 'tasks', 'archive', 'albdruck', 'forge'] as Page[]).map((item) => <button className={!activeMod && page === item ? 'active' : ''} onClick={() => changePage(item)} key={item} aria-current={!activeMod && page === item ? 'page' : undefined}>{item === 'albdruck' ? 'Albdruck' : item === 'forge' ? 'Forge' : item}</button>)}
        {modPanels.map((mod) => <button type="button" key={mod.modId} className={activeModId === mod.modId ? 'active' : ''} aria-current={activeModId === mod.modId ? 'page' : undefined} onClick={() => setActiveModId(mod.modId)}>{mod.name}</button>)}
        <button className={!activeMod && page === 'settings' ? 'active' : ''} onClick={() => changePage('settings')} aria-current={!activeMod && page === 'settings' ? 'page' : undefined}>settings</button>
      </nav>
    </header>
    {page === 'chat' && !activeMod && <WorkspaceRail collapsed={leftCollapsed} topPanel={leftTopPanel} bottomPanel={leftBottomPanel} layout={leftRailLayout} singlePanel={leftSinglePanel} renderPanel={renderRailPanel} onExpand={() => setLeftCollapsed(false)} onCollapse={() => setLeftCollapsed(true)} split={leftSplit} onSplitChange={setLeftSplit} onResizeSplit={(event) => resizeVertical('left', event)} />}
    <section className={`workspace ${page === 'tasks' || page === 'archive' || page === 'albdruck' ? 'tasks-workspace' : page === 'forge' ? 'forge-workspace' : page === 'settings' ? 'settings-workspace' : activeMod ? 'mod-workspace' : ''}`}><div className="workspace-watermark" aria-hidden="true"><img src="/burrow-logo.png" alt="" /></div><Suspense fallback={<div className="page-loading" role="status">Loading page…</div>}>{activeMod ? <ModPanelHost key={activeMod.modId + activeMod.controlUrl + (activeMod.version ?? '')} panel={activeMod} /> : page === 'tasks' ? <Tasks agents={agents} /> : page === 'albdruck' ? <Albdruck agents={agents} /> : page === 'archive' ? <Archive agents={agents} operatorName={operatorProfile.name} /> : page === 'forge' ? <Forge agents={agents} selectedAgentId={selectedAgentId} sessionId={sessionId} /> : page === 'settings' ? <Settings key="local" tab={settingsTab} setTab={setSettingsTab} agents={agents} selected={selected} onOperatorProfileChanged={setOperatorProfile} onFirstRunComplete={completeFirstRun} savedProviders={savedProviders} onModelConnectionsChanged={refreshModelConnections} onAgentsChanged={refreshAgents} leftTopPanel={leftTopPanel} setLeftTopPanel={setLeftTopPanel} leftBottomPanel={leftBottomPanel} setLeftBottomPanel={setLeftBottomPanel} rightTopPanel={rightTopPanel} setRightTopPanel={setRightTopPanel} rightBottomPanel={rightBottomPanel} setRightBottomPanel={setRightBottomPanel} leftSinglePanel={leftSinglePanel} setLeftSinglePanel={setLeftSinglePanel} rightSinglePanel={rightSinglePanel} setRightSinglePanel={setRightSinglePanel} leftRailLayout={leftRailLayout} setLeftRailLayout={setLeftRailLayout} rightRailLayout={rightRailLayout} setRightRailLayout={setRightRailLayout} theme={theme} setTheme={setTheme} agentRailPreferences={agentRailPreferences} setAgentRailPreferences={setAgentRailPreferences} previewFirstRun={previewFirstRun} /> : <><DocumentTabs tabs={visibleTabs} activeTabId={activeTab.id} onSelect={setActiveTabId} onClose={closeTab} /><ChatModelSelector selected={selected} savedProviders={savedProviders} updateAgent={updateAgent} sessions={sessions} sessionId={sessionId} onSessionChange={selectSession} onNewSession={startNewSession} onNewNamedSession={composers.session.open} onCreateGroup={composers.group.open} locked={Boolean(displayedRun)} />{activeTab.kind === 'file' ? <Editor tab={activeTab} setTabs={setTabs} onSave={saveFile} /> : activeTab.kind === 'group' && activeTab.channelId ? <GroupChannelsPage key={activeTab.channelId} channelId={activeTab.channelId} agents={agents} operator={operatorProfile} /> : <Chat key={`${selectedAgentId}:${sessionId}`} selected={selected} parent={selected} operator={operatorProfile} draft={draft} setDraft={setDraft} attached={attached} onAttach={attachImage} onRemoveAttachment={removeAttachment} isNewSession={isNewSession} turns={turns} isLoading={isLoadingConversation} error={chatError} isSending={Boolean(displayedRun)} activeRunId={displayedRun?.runId ?? ''} activeToolActivity={activeRunForSelection ? toolActivityForRun(activeRunForSelection.runId) : runtimeRun?.toolActivity} runtimeChildActivities={runtimeChildActivities} liveProgress={activeRunForSelection ? liveProgress : runtimeRun?.progress ?? []} liveAnswer={activeRunForSelection ? liveAnswer : ''} a2aActivities={a2aActivities} runtimeUserMessage={runtimeRun && !activeRunForSelection ? runtimeRun.latestUserMessage : ''} onSend={sendMessage} onCancel={cancelDisplayedRun} selectedAgentId={selectedAgentId} resourceAgentId={selected?.resourceId ?? selectedAgentId} sessionId={sessionId}  />}</>}</Suspense></section>
    {page === 'chat' && !activeMod && <RightRail collapsed={rightCollapsed} topPanel={rightTopPanel} bottomPanel={rightBottomPanel} layout={rightRailLayout} singlePanel={rightSinglePanel} renderPanel={renderRailPanel} onExpand={() => setRightCollapsed(false)} onCollapse={() => setRightCollapsed(true)} split={rightSplit} onSplitChange={setRightSplit} onResizeSplit={(event) => resizeVertical('right', event)} />}
    <ChatComposerDialogs agents={agents} session={composers.session} group={composers.group} />
    <AppStatusBar anthropicUsage={anthropicUsage} openAiUsage={openAiUsage} registryStale={registryStale} />
  </main>;
}

export const App = AppContent;


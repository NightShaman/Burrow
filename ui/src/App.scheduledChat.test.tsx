import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ConfirmProvider } from './app/ConfirmDialog';
import { api } from './app/api';

const mocks = vi.hoisted(() => ({
  selectParentStream: vi.fn(),
  selectChatSession: vi.fn(),
  setActiveTabId: vi.fn(),
  reportError: vi.fn(),
  refreshSessions: vi.fn().mockResolvedValue(undefined),
  refreshConversation: vi.fn().mockResolvedValue(undefined),
  refreshAgents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./app/api', async original => ({
  ...await original<typeof import('./app/api')>(),
  api: vi.fn(),
}));
vi.mock('./app/browserTab', () => ({ useBrowserTabTitle: () => {} }));
vi.mock('./app/modPanels', async original => ({
  ...await original<typeof import('./app/modPanels')>(),
  loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/useAppTabs', () => ({
  useAppTabs: () => ({ tabs: [{ id: 'chat', label: 'Chat', kind: 'chat' }], setTabs: vi.fn(), activeTabId: 'chat', setActiveTabId: mocks.setActiveTabId }),
}));
vi.mock('./app/useRuntimeSelection', () => ({
  useRuntimeSelection: () => ({
    expandedAgents: new Set(), selectedAgentId: 'current-ui', selectedStreamId: 'current-ui',
    selectChildStream: vi.fn(), selectParentStream: mocks.selectParentStream,
    setSelectedAgentId: vi.fn(), setSelectedStreamId: vi.fn(), showParentStream: vi.fn(), toggleAgentExpanded: vi.fn(),
  }),
}));
vi.mock('./app/useRuntimeAgents', () => ({
  formatAgentActivity: (status: string) => status,
  useRuntimeAgents: () => ({
    agents: [
      { id: 'current-ui', resourceId: 'runtime-current', name: 'Current', avatar: 'C', enabled: true, activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [] },
      { id: 'target-ui', resourceId: 'runtime-target', name: 'Target', avatar: 'T', enabled: true, activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [] },
    ],
    setAgents: vi.fn(), refreshAgents: mocks.refreshAgents, registryState: 'ready', registryError: '', registryStale: false,
  }),
}));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({
    anthropicUsage: undefined, openAiUsage: undefined, operatorProfile: { name: 'Operator', avatar: 'O' }, providerConnectionStatus: {},
    refreshModelConnections: vi.fn().mockResolvedValue(undefined), savedProviders: [], setOperatorProfile: vi.fn(),
  }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({ useWorkspaceFiles: () => ({ workspaceFiles: [], openFile: vi.fn(), saveFile: vi.fn() }) }));
vi.mock('./features/workspace/WorkspaceRail', () => ({ AgentsPanel: () => null, SystemPanel: () => null, WorkspacePanel: () => null, WorkspaceRail: () => null }));
vi.mock('./features/panels/RightRail', () => ({ RightRail: () => null }));
vi.mock('./features/panels/AccountStatus', () => ({ AccountStatus: () => null }));
vi.mock('./features/chat/useChatSession', () => ({
  useChatSession: () => ({
    composerResetGeneration: 0, isAttachmentScopeCurrent: () => true, attached: [], setAttachment: vi.fn(), clearAttachment: vi.fn(), removeAttachment: vi.fn(),
    isNewSession: false, leaveNewSessionForMessage: vi.fn(), sessions: [{ id: 'current-session' }], sessionId: 'current-session', turns: [], chatError: '', reportError: mocks.reportError, clearError: vi.fn(), isLoadingConversation: false, draft: '', setDraft: vi.fn(),
    refreshSessions: mocks.refreshSessions, refreshConversation: mocks.refreshConversation, selectSession: mocks.selectChatSession, prepareAgentSelection: vi.fn(), selectChildSession: vi.fn(), parentSessionIdForAgent: () => 'default', resetSession: vi.fn(), appendTurn: vi.fn(), appendTransientTurn: vi.fn(), storeToolActivity: vi.fn(), toolActivityForRun: vi.fn(), clearRunState: vi.fn(), a2aActivities: [], runtimeRun: null, runtimeChildActivities: [], cancelRuntimeRun: vi.fn(), retireRuntimeRun: vi.fn(),
  }),
}));
vi.mock('./features/chat/useChatRun', () => ({
  useChatRun: () => ({ activeRunForSelection: null, activeRunId: '', sendMessage: vi.fn(), cancelRun: vi.fn(), liveProgress: [], liveAnswer: '', liveStage: '' }),
}));
vi.mock('./features/chat/useChatComposers', () => ({ useChatComposers: () => ({ session: {}, group: {} }) }));
vi.mock('./features/chat/ChatComposerDialogs', () => ({ ChatComposerDialogs: () => null }));
vi.mock('./features/chat/ChatPage', () => ({ Chat: () => <h1>Chat destination</h1>, ChatModelSelector: () => null, Editor: () => null }));
vi.mock('./app/AppChrome', () => ({ AppStatusBar: () => null, DocumentTabs: () => null }));
// The production Settings tree is covered at its own boundary. This App test
// captures the callback injected into it and verifies resource-to-UI identity
// translation before exact-session selection.
vi.mock('./features/settings/SettingsPage', () => ({
  Settings: ({ onOpenChat }: { onOpenChat?: (sessionId: string, agentId: string) => void }) => <button type="button" onClick={() => onOpenChat?.('receipt-session', 'runtime-target')}>Open scheduled receipt</button>,
}));

describe('App scheduled-chat navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/api/health') return { version: 'test' };
      if (path === '/api/setup/status') return { wizardStep: 'ready', configured: true };
      return {};
    });
  });

  afterEach(cleanup);

  it('maps the receipt resource agent to its parent UI row and opens its exact saved session', async () => {
    render(<ConfirmProvider><App /></ConfirmProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open scheduled receipt' }));

    expect(mocks.selectParentStream).toHaveBeenCalledWith('target-ui');
    expect(mocks.selectParentStream).not.toHaveBeenCalledWith('runtime-target');
    expect(mocks.selectChatSession).toHaveBeenCalledWith('receipt-session', 'target-ui');
    expect(mocks.setActiveTabId).toHaveBeenCalledWith('chat');
    expect(mocks.refreshSessions).toHaveBeenCalledWith('target-ui');
    expect(mocks.refreshConversation).toHaveBeenCalledWith('target-ui', 'receipt-session');
    expect(await screen.findByRole('heading', { name: 'Chat destination' })).toBeTruthy();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});

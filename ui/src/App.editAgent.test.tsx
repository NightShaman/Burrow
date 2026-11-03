import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ConfirmProvider } from './app/ConfirmDialog';
import { api } from './app/api';

const mocks = vi.hoisted(() => ({
  selectedId: 'target-ui',
  resident: false,
  hasOwner: true,
  empty: false,
  selectParentStream: vi.fn(),
  selectChatSession: vi.fn(),
  setActiveTabId: vi.fn(),
  reportError: vi.fn(),
  refreshSessions: vi.fn().mockResolvedValue(undefined),
  refreshConversation: vi.fn().mockResolvedValue(undefined),
  refreshAgents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./app/api', async (original) => ({
  ...(await original<typeof import('./app/api')>()),
  api: vi.fn(),
}));
vi.mock('./app/browserTab', () => ({ useBrowserTabTitle: () => {} }));
vi.mock('./app/modPanels', async (original) => ({
  ...(await original<typeof import('./app/modPanels')>()),
  loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/apiTargets', async (original) => ({
  ...(await original<typeof import('./app/apiTargets')>()),
  loadModSettingsContributions: vi.fn(async () =>
    mocks.hasOwner
      ? [
          {
            modId: 'burrow-menagerie',
            name: 'Menagerie',
            settingsUrl: '/settings.js',
            settings: [{ id: 'residents', label: 'Residents' }],
          },
        ]
      : [],
  ),
}));
vi.mock('./app/useAppTabs', () => ({
  useAppTabs: () => ({
    tabs: [{ id: 'chat', label: 'Chat', kind: 'chat' }],
    setTabs: vi.fn(),
    activeTabId: 'chat',
    setActiveTabId: mocks.setActiveTabId,
  }),
}));
vi.mock('./app/useRuntimeSelection', () => ({
  useRuntimeSelection: () => ({
    expandedAgents: new Set(),
    selectedAgentId: mocks.selectedId,
    selectedStreamId: mocks.selectedId,
    selectChildStream: vi.fn(),
    selectParentStream: mocks.selectParentStream,
    setSelectedAgentId: vi.fn(),
    setSelectedStreamId: vi.fn(),
    showParentStream: vi.fn(),
    toggleAgentExpanded: vi.fn(),
  }),
}));
vi.mock('./app/useRuntimeAgents', () => ({
  formatAgentActivity: (status: string) => status,
  useRuntimeAgents: () => ({
    agents: mocks.empty
      ? []
      : [
          {
            id: 'current-ui',
            resourceId: 'runtime-current',
            name: 'Current',
            avatar: 'C',
            enabled: true,
            activity: 'Idle',
            context: null,
            provider: '',
            model: '',
            effort: '',
            temperature: 0.2,
            workspace: '',
            files: [],
            subagents: [],
          },
          {
            id: 'target-ui',
            resourceId: 'runtime-target',
            name: 'Target',
            ...(mocks.resident
              ? {
                  modAgent: {
                    ownerModId: 'burrow-menagerie',
                    capabilities: {},
                    visibility: { agents: true },
                  },
                }
              : {}),
            avatar: 'T',
            enabled: true,
            activity: 'Idle',
            context: null,
            provider: '',
            model: '',
            effort: '',
            temperature: 0.2,
            workspace: '',
            files: [],
            subagents: [],
          },
        ],
    setAgents: vi.fn(),
    refreshAgents: mocks.refreshAgents,
    registryState: 'ready',
    registryError: '',
    registryStale: false,
  }),
}));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({
    operatorProfile: { name: 'Operator', avatar: 'O' },
    providerConnectionStatus: {},
    refreshModelConnections: vi.fn().mockResolvedValue(undefined),
    savedProviders: [],
    setOperatorProfile: vi.fn(),
  }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({
  useWorkspaceFiles: () => ({ workspaceFiles: [], openFile: vi.fn(), saveFile: vi.fn() }),
}));
vi.mock('./features/workspace/WorkspaceRail', () => ({
  AgentsPanel: () => null,
  SystemPanel: () => null,
  WorkspacePanel: () => null,
  WorkspaceRail: () => null,
  Chevron: () => null,
}));
vi.mock('./features/panels/RightRail', () => ({ RightRail: () => null }));
vi.mock('./features/panels/AccountStatus', () => ({ AccountStatus: () => null }));
vi.mock('./features/chat/useChatSession', () => ({
  useChatSession: () => ({
    composerResetGeneration: 0,
    isAttachmentScopeCurrent: () => true,
    attached: [],
    setAttachment: vi.fn(),
    clearAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    isNewSession: false,
    leaveNewSessionForMessage: vi.fn(),
    sessions: [{ id: 'current-session' }],
    sessionId: 'current-session',
    turns: [],
    chatError: '',
    reportError: mocks.reportError,
    clearError: vi.fn(),
    isLoadingConversation: false,
    draft: '',
    setDraft: vi.fn(),
    refreshSessions: mocks.refreshSessions,
    refreshConversation: mocks.refreshConversation,
    selectSession: mocks.selectChatSession,
    prepareAgentSelection: vi.fn(),
    selectChildSession: vi.fn(),
    parentSessionIdForAgent: () => 'default',
    resetSession: vi.fn(),
    appendTurn: vi.fn(),
    appendTransientTurn: vi.fn(),
    storeToolActivity: vi.fn(),
    toolActivityForRun: vi.fn(),
    clearRunState: vi.fn(),
    a2aActivities: [],
    runtimeRun: null,
    runtimeChildActivities: [],
    cancelRuntimeRun: vi.fn(),
    retireRuntimeRun: vi.fn(),
  }),
}));
vi.mock('./features/chat/useChatRun', () => ({
  useChatRun: () => ({
    activeRunForSelection: null,
    activeRunId: '',
    sendMessage: vi.fn(),
    cancelRun: vi.fn(),
    liveProgress: [],
    liveAnswer: '',
    liveStage: '',
  }),
}));
vi.mock('./features/chat/useChatComposers', () => ({
  useChatComposers: () => ({ session: {}, group: {} }),
}));
vi.mock('./features/chat/ChatComposerDialogs', () => ({ ChatComposerDialogs: () => null }));
vi.mock('./features/chat/ChatPage', async (original) => ({
  ...(await original<typeof import('./features/chat/ChatPage')>()),
  Chat: () => <h1>Chat destination</h1>,
  Editor: () => null,
}));
vi.mock('./app/AppChrome', () => ({ AppStatusBar: () => null, DocumentTabs: () => null }));
vi.mock('./features/settings/SystemStatsRail', () => ({ SystemStatsRail: () => null }));

describe('App Edit Agent shortcut', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.selectedId = 'target-ui';
    mocks.resident = false;
    mocks.hasOwner = true;
    mocks.empty = false;
    vi.clearAllMocks();
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/health') return { version: 'test' };
      if (path === '/api/setup/status') return { wizardStep: 'ready', configured: true };
      if (path === '/api/settings/identities')
        return { operator: { name: 'Operator', avatar: '' } };
      return {};
    });
  });

  afterEach(cleanup);

  const mount = () =>
    render(
      <ConfirmProvider>
        <App />
      </ConfirmProvider>,
    );

  it('opens the selected non-first regular agent in the real Settings profile without mutation', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Agent' }));
    expect(await screen.findByDisplayValue('Target')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agent details' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Target' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Edit in Menagerie' })).toBeNull();
    expect(
      vi.mocked(api).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'),
    ).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Agent' }));
    expect(await screen.findByDisplayValue('Target')).toBeTruthy();
  });

  it('retains the creature owner shortcut and does not substitute regular agent editing', async () => {
    mocks.resident = true;
    mount();
    expect(await screen.findByRole('button', { name: 'Edit in Menagerie' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Menagerie' }));
    await waitFor(() => expect(document.querySelector('.settings-fidgit')).toBeTruthy());
    expect(screen.queryByDisplayValue('Target')).toBeNull();
  });

  it('does not expose an invalid editor for a mod without settings or for an absent selection', async () => {
    mocks.resident = true;
    mocks.hasOwner = false;
    const view = mount();
    expect(screen.queryByRole('button', { name: 'Edit Agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit in Menagerie' })).toBeNull();
    view.unmount();
    mocks.selectedId = 'missing';
    mocks.empty = true;
    mocks.resident = false;
    mount();
    expect(screen.queryByRole('button', { name: 'Edit Agent' })).toBeNull();
  });
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './app/api';
import { ConfirmProvider } from './app/ConfirmDialog';
import type { Agent } from './app/types';

const mocks = vi.hoisted(() => ({ reportError: vi.fn(), writeModelSelection: vi.fn(), refreshSessions: vi.fn().mockResolvedValue(undefined) }));
const contextConfig = { a2aInDefault: true, personality: 'keep-personality', tools: ['keep-tool'], skills: ['keep-skill'] };
const agent: Agent = {
  id: 'smatchet', resourceId: 'runtime-agent', name: 'Smatchet', avatar: 'S', activity: 'idle', context: null,
  provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [], contextConfig,
};

vi.mock('./app/api', async (original) => ({
  ...await original<typeof import('./app/api')>(), api: vi.fn(async () => ({})),
}));
vi.mock('./app/modPanels', async (original) => ({
  ...await original<typeof import('./app/modPanels')>(), loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/useRuntimeSelection', () => ({ useRuntimeSelection: () => ({ selectedAgentId: 'smatchet' }) }));
vi.mock('./app/useRuntimeAgents', () => ({
  formatAgentActivity: vi.fn(),
  useRuntimeAgents: () => {
    const [agents, setAgents] = useState([agent]);
    return { agents, setAgents };
  },
}));
vi.mock('./app/useModelSelectionWriter', () => ({ useModelSelectionWriter: () => mocks.writeModelSelection }));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({ savedProviders: [], operatorProfile: { name: 'Rob', avatar: 'R' } }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({ useWorkspaceFiles: () => ({ workspaceFiles: [] }) }));
vi.mock('./features/workspace/WorkspaceRail', () => ({ WorkspaceRail: () => null }));
vi.mock('./features/panels/RightRail', () => ({ RightRail: () => null }));
vi.mock('./features/chat/useChatRun', () => ({ useChatRun: () => ({ activeRunId: '', activeRunForSelection: null }) }));
vi.mock('./features/chat/useChatSession', () => ({
  useChatSession: () => ({
    refreshSessions: mocks.refreshSessions, reportError: mocks.reportError, toolActivityForRun: vi.fn(), sessionId: 'default', sessions: [{ id: 'default' }], attached: [], turns: [], draft: '',
  }),
}));
vi.mock('./features/chat/ChatPage', async (original) => {
  const actual = await original<typeof import('./features/chat/ChatPage')>();
  return {
    ...actual, Chat: () => null,
    ChatModelSelector: (props: Parameters<typeof actual.ChatModelSelector>[0]) => <>
      <actual.ChatModelSelector {...props} />
      <output data-testid="context-config">{JSON.stringify(props.selected.contextConfig)}</output>
    </>,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api).mockResolvedValue({});
});
afterEach(cleanup);

function renderApp() {
  render(<ConfirmProvider><App /></ConfirmProvider>);
  return screen.getByRole('checkbox', { name: 'A2A in default' });
}
function patches() {
  return vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PATCH');
}

describe('App A2A routing persistence', () => {
  it('PATCHes only routing and merges the saved preference without losing unrelated config', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolvePromise => { resolve = resolvePromise; });
    vi.mocked(api).mockImplementation(async (_path, options) => options?.method === 'PATCH' ? pending : {});
    const toggle = renderApp();
    await act(async () => { fireEvent.click(toggle); });
    expect(patches()).toEqual([['/api/agents/runtime-agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextConfig: { a2aInDefault: false } }),
    }]]);
    expect(toggle).toHaveProperty('checked', true);
    await act(async () => { resolve({}); await pending; });
    expect(toggle).toHaveProperty('checked', false);
    expect(JSON.parse(screen.getByTestId('context-config').textContent!)).toEqual({ ...contextConfig, a2aInDefault: false });
    expect(mocks.writeModelSelection).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).toHaveBeenCalledWith('smatchet');
  });

  it('keeps the saved routing/config on PATCH failure, reports it, and allows retry', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) => {
      if (options?.method === 'PATCH') throw new Error('Routing unavailable');
      return {};
    });
    const toggle = renderApp();
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle).toHaveProperty('checked', true);
    expect(JSON.parse(screen.getByTestId('context-config').textContent!)).toEqual(contextConfig);
    expect(mocks.reportError).toHaveBeenCalledWith('Could not update A2A routing: Routing unavailable');
    expect(mocks.writeModelSelection).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValue({});
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle).toHaveProperty('checked', false);
    expect(patches()).toHaveLength(2);
  });

  it('hydrates the persisted inbox after toggling Off and keeps it visible after restoring On', async () => {
    const toggle = renderApp();
    await act(async () => { fireEvent.click(toggle); });
    expect(mocks.refreshSessions).toHaveBeenCalledWith('smatchet');
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle).toHaveProperty('checked', true);
    expect(mocks.refreshSessions).toHaveBeenCalledTimes(2);
  });

});

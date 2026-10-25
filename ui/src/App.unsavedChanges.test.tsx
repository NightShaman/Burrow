import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './app/api';
import { ConfirmProvider } from './app/ConfirmDialog';

const mocks = vi.hoisted(() => ({ refreshSessions: vi.fn(), refreshConversation: vi.fn(), setOperatorProfile: vi.fn() }));
vi.mock('./app/api', async original => ({ ...await original<typeof import('./app/api')>(), api: vi.fn() }));
vi.mock('./app/modPanels', async original => ({ ...await original<typeof import('./app/modPanels')>(), loadModPanels: vi.fn(async () => []) }));
vi.mock('./app/apiTargets', () => ({ loadModSettingsContributions: vi.fn(async () => []), modContributionsChangedEvent: 'mods-changed' }));
vi.mock('./app/useRuntimeSelection', () => ({ useRuntimeSelection: () => ({ selectedAgentId: '' }) }));
vi.mock('./app/useRuntimeAgents', () => ({ formatAgentActivity: vi.fn(), useRuntimeAgents: () => ({ agents: [], registryState: 'empty' }) }));
vi.mock('./app/useRuntimeDashboard', () => ({ useRuntimeDashboard: () => ({ savedProviders: [], operatorProfile: { name: 'Operator', avatar: '' }, setOperatorProfile: mocks.setOperatorProfile }) }));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({ useWorkspaceFiles: () => ({ workspaceFiles: [] }) }));
vi.mock('./features/workspace/WorkspaceRail', () => ({ WorkspaceRail: () => null, Chevron: () => null }));
vi.mock('./features/panels/RightRail', () => ({ RightRail: () => null }));
vi.mock('./features/settings/SystemStatsRail', () => ({ SystemStatsRail: () => null }));
vi.mock('./features/chat/useChatRun', () => ({ useChatRun: () => ({ activeRunId: '', activeRunForSelection: null }) }));
vi.mock('./features/chat/useChatSession', () => ({ useChatSession: () => ({ ...mocks, sessionId: 'default', sessions: [{ id: 'default' }], attached: [], turns: [], draft: '' }) }));
vi.mock('./features/chat/ChatPage', () => ({ Chat: () => <h1>Chat destination</h1>, ChatModelSelector: () => null, Editor: () => null }));

const alpha = { id: 'alpha', name: 'Alpha', transport: 'http', lifecycle: 'ephemeral', baseUrl: 'https://alpha.test', command: null, args: [], enabled: true, apiKeyConfigured: false, environmentVariables: [], tools: [] };
beforeEach(() => {
  localStorage.clear();
  mocks.refreshSessions.mockResolvedValue(undefined);
  mocks.refreshConversation.mockResolvedValue(undefined);
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'PUT' || options?.method === 'POST') return { ok: true };
    if (path === '/api/settings/identities') return { operator: { name: 'Operator', avatar: '' } };
    if (path === '/api/settings/mcp-connections') return { connections: [alpha] };
    if (path === '/api/settings/ui-auth') return { auth: { mode: 'none' } };
    if (path === '/api/setup/status') return { wizardStep: 'ready' };
    return {};
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(api).mockReset(); });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const primary = (name: string) => within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name });
const mutations = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'POST');

it.each((['profile', 'MCP'] as const).flatMap(form => (['Stay', 'Discard', 'Save'] as const).map(choice => ({ form, choice }))))('App primary navigation away from dirty $form handles $choice', async ({ form, choice }) => {
  render(<ConfirmProvider><App /></ConfirmProvider>);
  fireEvent.click(primary('settings'));
  await screen.findByDisplayValue('Operator');
  if (form === 'MCP') {
    click('Connections'); click('MCP servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
  }
  fireEvent.change(screen.getByLabelText(form === 'profile' ? 'Displayed name' : 'Name'), { target: { value: 'Dirty draft' } });
  // Clicking the already active primary page is not a navigation boundary.
  fireEvent.click(primary('settings'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByDisplayValue('Dirty draft')).toBeTruthy();
  fireEvent.click(primary('chat'));
  const dialog = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
  expect(primary('settings').getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('heading', { name: 'Chat destination' })).toBeNull();
  expect(mocks.refreshSessions).not.toHaveBeenCalled();
  expect(mocks.refreshConversation).not.toHaveBeenCalled();

  if (choice === 'Stay') {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByDisplayValue('Dirty draft')).toBeTruthy();
    expect(primary('settings').getAttribute('aria-current')).toBe('page');
    expect(mutations()).toHaveLength(0);
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  } else {
    if (choice === 'Save') {
      let resolve!: (value: unknown) => void;
      const pending = new Promise(done => { resolve = done; });
      const normalApi = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation((path, options) => options?.method === 'PUT' || options?.method === 'POST' ? pending as ReturnType<typeof api> : normalApi(path, options));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(primary('settings').getAttribute('aria-current')).toBe('page');
      expect(screen.queryByRole('heading', { name: 'Chat destination' })).toBeNull();
      expect(mocks.refreshSessions).not.toHaveBeenCalled();
      expect(mutations()).toHaveLength(1);
      expect(JSON.parse(String(mutations()[0][1]?.body))).toMatchObject({ name: 'Dirty draft', id: form === 'profile' ? 'default' : 'alpha' });
      await act(async () => resolve({ ok: true }));
    } else fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('heading', { name: 'Chat destination' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByLabelText(form === 'profile' ? 'Displayed name' : 'Name')).toBeNull();
    expect(primary('chat').getAttribute('aria-current')).toBe('page');
    expect(mutations()).toHaveLength(choice === 'Save' ? 1 : 0);
    expect(mocks.refreshSessions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshConversation).toHaveBeenCalledTimes(1);
  }
});

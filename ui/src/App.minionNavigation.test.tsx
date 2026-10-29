import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, type AgentStatus, type RuntimeAgent } from './app/api';
import { ConfirmProvider } from './app/ConfirmDialog';

// Keep App, both selection/session hooks, runtime hydration, the rail, session
// selector and transcript real. Only unrelated dashboard/workspace I/O is stubbed;
// the API fixture below is the boundary for navigation and polling evidence.
vi.mock('./app/api', async (original) => ({
  ...await original<typeof import('./app/api')>(), api: vi.fn(),
}));
vi.mock('./app/modPanels', async (original) => ({
  ...await original<typeof import('./app/modPanels')>(), loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({ savedProviders: [], operatorProfile: { name: 'Operator', avatar: 'O' } }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({
  useWorkspaceFiles: () => ({ workspaceFiles: [] }),
}));

const runtimeAgents = [
  { id: 'hatchet', name: 'Hatchet', enabled: true },
  { id: 'other', name: 'Other agent', enabled: true },
] satisfies RuntimeAgent[];
const descendants: Record<string, AgentStatus[]> = {
  hatchet: [
    { sessionId: 'named-child', subagentId: 'worker', label: 'Named child', status: 'complete', depth: 1, parentSessionId: 'named-root', rootSessionId: 'named-root' },
    { sessionId: 'nested-child', subagentId: 'nested-worker', label: 'Nested child', status: 'complete', depth: 2, parentSessionId: 'named-child', rootSessionId: 'named-root' },
    { sessionId: 'shared-child', subagentId: 'hatchet-shared-worker', label: 'Hatchet shared child', status: 'complete', depth: 1, parentSessionId: 'named-root', rootSessionId: 'named-root' },
  ],
  other: [
    { sessionId: 'other-child', subagentId: 'other-worker', label: 'Other child', status: 'complete', depth: 1, parentSessionId: 'other-root', rootSessionId: 'other-root' },
    { sessionId: 'shared-child', subagentId: 'other-shared-worker', label: 'Other shared child', status: 'complete', depth: 1, parentSessionId: 'other-root', rootSessionId: 'other-root' },
  ],
};
let missingSelectedChild = false;
let unexpectedPaths: string[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('hc.selectedAgentId', 'hatchet');
  vi.useFakeTimers();
  missingSelectedChild = false;
  unexpectedPaths = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path, options) => {
    const url = new URL(path, 'http://fixture.invalid');
    const agentId = url.searchParams.get('agentId') ?? '';
    if (path === '/api/settings/browser-tab') return { suffix: '' };
    if (path === '/api/metrics/provider-pools') return { pools: [] };
    if (path === '/api/health') return { version: 'test' };
    if (path === '/api/setup/status') return { wizardStep: 'ready', configured: true };
    if (path === '/api/agents') return { agents: runtimeAgents };
    if (path === '/api/agents/overview') {
      const { sessions } = JSON.parse(String(options?.body)) as { sessions: Record<string, string> };
      return { agents: runtimeAgents.map(agent => ({
        agent, sessionId: sessions[agent.id], selection: null, contexts: {},
        status: { minionScope: 'agent', agents: [
          { sessionId: sessions[agent.id], status: 'idle' },
          ...descendants[agent.id].filter(child => !missingSelectedChild || child.sessionId !== 'nested-child'),
        ] },
      })) };
    }
    if (url.pathname === '/api/sessions') {
      // Children deliberately do not appear here. Navigation must use the
      // owning agent and remember the child's root, not the first list entry.
      return { sessions: [{ id: 'default' }, { id: agentId === 'other' ? 'other-root' : 'named-root' }, { id: 'another-chat' }] };
    }
    if (url.pathname.startsWith('/api/sessions/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      return { session: { id: sessionId, turns: [{ type: 'message', role: 'assistant', content: `${agentId}/${sessionId} transcript` }] } };
    }
    if (url.pathname === '/api/chat/runs/active') return { runs: [], subagents: [] };
    if (url.pathname === '/api/chat/inputs') return { generation: 1, inputs: [] };
    if (url.pathname === '/api/task-board/conversation-project') return { ok: true, project: null };
    if (url.pathname === '/api/task-board/projects') return { projects: [] };
    unexpectedPaths.push(path);
    throw new Error(`Unexpected fixture API path: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(unexpectedPaths).toEqual([]);
});

async function renderApp() {
  await act(async () => { render(<ConfirmProvider><App /></ConfirmProvider>); });
  expectTranscript('hatchet', 'default');
}
async function click(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}
function sessionSelector() {
  return screen.getByRole('combobox', { name: 'Session' }) as HTMLSelectElement;
}
function expectTranscript(agentId: string, sessionId: string) {
  expect(sessionSelector().value).toBe(sessionId);
  expect(screen.getByText(`${agentId}/${sessionId} transcript`)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
}
function expectSelected(name: string, selected: boolean) {
  expect(screen.getByRole('button', { name: `Select ${name}` }).getAttribute('aria-pressed')).toBe(String(selected));
}
async function pollOverview() {
  const count = vi.mocked(api).mock.calls.filter(([path]) => path === '/api/agents/overview').length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/agents/overview')).toHaveLength(count + 1);
}
function latestOverviewSessions() {
  const calls = vi.mocked(api).mock.calls.filter(([path]) => path === '/api/agents/overview');
  return JSON.parse(String(calls.at(-1)![1]?.body)).sessions;
}

describe('App minion navigation integration', () => {
  it.each([
    ['Named child', 'named-child'],
    ['Nested child', 'nested-child'],
  ])('returns from %s to its named root via the parent row', async (name, childSessionId) => {
    await renderApp();
    await click('Expand Hatchet');
    if (name === 'Nested child') {
      const parent = screen.getByRole('button', { name: 'Select Named child' }).closest('li')!;
      expect(within(parent).getByRole('button', { name: 'Select Nested child' })).toBeTruthy();
    }
    await click(`Select ${name}`);
    expectTranscript('hatchet', childSessionId);
    expectSelected(name, true);
    expectSelected('Hatchet', false);
    expect(vi.mocked(api)).toHaveBeenCalledWith(`/api/sessions/${childSessionId}?agentId=hatchet`);
    await pollOverview();
    expect(latestOverviewSessions().hatchet).toBe('named-root');
    expectTranscript('hatchet', childSessionId);

    await click('Select Hatchet');
    expectTranscript('hatchet', 'named-root');
    expectSelected('Hatchet', true);
    expectSelected(name, false);
    expect(screen.queryByText(`hatchet/${childSessionId} transcript`)).toBeNull();
  });

  it('opens a child under another agent and returns to that agent’s root without inheriting the previous session', async () => {
    await renderApp();
    await click('Expand Other agent');
    await click('Select Other child');
    expectTranscript('other', 'other-child');
    expectSelected('Other child', true);
    expectSelected('Hatchet', false);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/sessions/other-child?agentId=other');
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/sessions/other-child?agentId=hatchet')).toBe(false);
    await pollOverview();
    expect(latestOverviewSessions().other).toBe('other-root');
    expectTranscript('other', 'other-child');

    await click('Select Other agent');
    expectTranscript('other', 'other-root');
    expectSelected('Other agent', true);
    expectSelected('Other child', false);
    await click('Select Hatchet');
    expectTranscript('hatchet', 'default');
  });

  it('selects equal child session resources independently by owning agent while APIs stay raw', async () => {
    await renderApp();
    await click('Expand Hatchet');
    await click('Expand Other agent');
    await click('Select Hatchet shared child');
    expectTranscript('hatchet', 'shared-child');
    expectSelected('Hatchet shared child', true);
    expectSelected('Other shared child', false);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/sessions/shared-child?agentId=hatchet');

    await click('Select Other shared child');
    expectTranscript('other', 'shared-child');
    expectSelected('Hatchet shared child', false);
    expectSelected('Other shared child', true);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/sessions/shared-child?agentId=other');
    expect(vi.mocked(api).mock.calls.some(([path]) => path.includes(encodeURIComponent('["child"')))).toBe(false);
  });

  it('keeps an explicitly selected named chat when its parent row is clicked, including after a child visit', async () => {
    await renderApp();
    await click('Expand Hatchet');
    await click('Select Named child');
    expectTranscript('hatchet', 'named-child');
    await act(async () => { fireEvent.change(sessionSelector(), { target: { value: 'another-chat' } }); });
    expectTranscript('hatchet', 'another-chat');
    expectSelected('Hatchet', true);
    expectSelected('Named child', false);
    await click('Select Hatchet');
    expectTranscript('hatchet', 'another-chat');
    await pollOverview();
    expect(latestOverviewSessions().hatchet).toBe('another-chat');
    expectTranscript('hatchet', 'another-chat');
  });

  it('preserves a missing selected child’s transcript and selection, shows Last seen, and clears it when the child reappears', async () => {
    await renderApp();
    await click('Expand Hatchet');
    await click('Select Nested child');
    expectTranscript('hatchet', 'nested-child');
    missingSelectedChild = true;
    await pollOverview();
    expectTranscript('hatchet', 'nested-child');
    expectSelected('Nested child', true);
    expectSelected('Hatchet', false);
    expect(within(screen.getByRole('button', { name: 'Select Nested child' })).getByText(/Last seen/)).toBeTruthy();
    expect(latestOverviewSessions().hatchet).toBe('named-root');
    // Repeated missing snapshots must retain, not progressively lose, the row.
    await pollOverview();
    expectTranscript('hatchet', 'nested-child');
    expectSelected('Nested child', true);
    expect(screen.getByText(/Last seen/)).toBeTruthy();

    missingSelectedChild = false;
    await pollOverview();
    expectTranscript('hatchet', 'nested-child');
    expectSelected('Nested child', true);
    expect(screen.queryByText(/Last seen/)).toBeNull();
    await click('Select Hatchet');
    expectTranscript('hatchet', 'named-root');
  });
});

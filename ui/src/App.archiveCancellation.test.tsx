import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './app/api';
import { ConfirmProvider } from './app/ConfirmDialog';

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


// Real App navigation, lazy Archive, shelves, readers and repository. Only
// unrelated dashboard/workspace I/O and the API transport boundary are stubbed.
it.each(['calendar', 'first-list', 'detail', 'loadEarlier'] as const)('navigation away aborts the pending Archive %s API request', async (stage) => {
  localStorage.clear();
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(done => { resolve = done; });
  let ownerSignal: AbortSignal | null | undefined;
  let pendingPath = '';
  const unexpected: string[] = [];
  const item = { id: 'owned', sessionId: 'owned', agentId: 'hatchet', title: 'Owned conversation', archived: true };
  const newest = { turns: [{ role: 'user', content: 'Newest retained message' }], hasMore: true, nextCursor: 'earlier' };
  vi.mocked(api).mockImplementation(async (path, options) => {
    const url = new URL(path, 'http://fixture.invalid');
    const isPending = stage === 'calendar' ? url.pathname === '/api/archive/calendar'
      : stage === 'first-list' ? url.pathname === '/api/archive/sessions'
      : stage === 'detail' ? url.pathname.startsWith('/api/archive/sessions/')
      : url.pathname.startsWith('/api/archive/sessions/') && url.searchParams.has('before');
    if (isPending) { ownerSignal = options?.signal; pendingPath = path; return pending; }
    if (url.pathname === '/api/archive/calendar') return { ok: true, kind: 'sessions', month: url.searchParams.get('month'), dates: [] };
    if (url.pathname === '/api/archive/sessions') return { sessions: [item], hasMore: false, nextCursor: null };
    if (url.pathname.startsWith('/api/archive/sessions/')) return newest;
    if (url.pathname === '/api/archive/dreams/groups') return { ok: true, groups: [], hasMore: false, nextCursor: null };
    if (url.pathname === '/api/archive/continuity/cards') return { cards: [], hasMore: false, nextCursor: null };
    if (path === '/api/settings/browser-tab') return { suffix: '' };
    if (path === '/api/metrics/provider-pools') return { pools: [] };
    if (path === '/api/health') return { version: 'test' };
    if (path === '/api/setup/status') return { wizardStep: 'ready', configured: true };
    if (path === '/api/agents') return { agents: [{ id: 'hatchet', name: 'Hatchet', enabled: true }] };
    if (path === '/api/agents/overview') return { agents: [] };
    if (url.pathname === '/api/sessions') return { sessions: [{ id: 'default' }] };
    if (url.pathname.startsWith('/api/sessions/')) return { session: { turns: [] } };
    if (url.pathname === '/api/chat/runs/active') return { runs: [], subagents: [] };
    if (url.pathname === '/api/chat/inputs') return { generation: 1, inputs: [] };
    if (url.pathname === '/api/task-board/conversation-project') return { ok: true, project: null };
    if (url.pathname === '/api/task-board/tasks') return { tasks: [] };
    if (url.pathname === '/api/task-board/projects') return { projects: [] };
    unexpected.push(path);
    throw new Error(`Unexpected fixture API path: ${path}`);
  });
  render(<ConfirmProvider><App /></ConfirmProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'archive' }));
  await screen.findByRole('heading', { name: 'Archive' });
  if (stage === 'detail' || stage === 'loadEarlier') {
    fireEvent.click(await screen.findByRole('button', { name: /Owned conversation.*turns/i }));
    if (stage === 'loadEarlier') {
      await screen.findByText('Newest retained message');
      fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    }
  }
  await waitFor(() => expect(ownerSignal).toBeInstanceOf(AbortSignal));
  expect(ownerSignal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'chat' }));
  await waitFor(() => expect(ownerSignal?.aborted).toBe(true));
  expect(screen.getByRole('button', { name: 'chat' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('heading', { name: 'Archive' })).toBeNull();
  const params = new URL(pendingPath, 'http://fixture.invalid').searchParams;
  await act(async () => resolve(stage === 'calendar' ? { ok: true, kind: 'sessions', month: params.get('month'), dates: [] }
    : stage === 'first-list' ? { sessions: [item], hasMore: false, nextCursor: null } : { turns: [{ role: 'user', content: 'Late archive intruder' }] }));
  expect(screen.queryByText('Late archive intruder')).toBeNull();
  expect(screen.queryByText('Newest retained message')).toBeNull();
  expect(unexpected).toEqual([]);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

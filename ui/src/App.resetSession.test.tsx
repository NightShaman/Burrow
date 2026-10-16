import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ConfirmProvider } from './app/ConfirmDialog';

const mocks = vi.hoisted(() => ({
  resetSession: vi.fn(), refreshSessions: vi.fn(), reportError: vi.fn(),
  clearError: vi.fn(), setDraft: vi.fn(), clearAttachment: vi.fn(),
  isAttachmentScopeCurrent: vi.fn(),
  onReset: null as null | (() => void),
  activeRunId: '',
}));

vi.mock('./app/api', async (original) => ({
  ...await original<typeof import('./app/api')>(),
  api: vi.fn(async () => ({})),
}));
vi.mock('./app/modPanels', async (original) => ({
  ...await original<typeof import('./app/modPanels')>(),
  loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/useRuntimeSelection', () => ({ useRuntimeSelection: () => ({ selectedAgentId: 'smatchet' }) }));
vi.mock('./app/useRuntimeAgents', () => ({
  formatAgentActivity: vi.fn(),
  useRuntimeAgents: () => ({ agents: [{ id: 'smatchet', name: 'Smatchet', avatar: 'S', provider: '', model: '', effort: '', temperature: 0.2, files: [], subagents: [] }] }),
}));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({ savedProviders: [], operatorProfile: { name: 'Rob', avatar: 'R' } }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({ useWorkspaceFiles: () => ({ workspaceFiles: [] }) }));
vi.mock('./features/workspace/WorkspaceRail', () => ({ WorkspaceRail: () => null }));
vi.mock('./features/panels/RightRail', () => ({ RightRail: () => null }));
vi.mock('./features/chat/useChatRun', () => ({
  useChatRun: () => ({ activeRunId: mocks.activeRunId, activeRunForSelection: mocks.activeRunId ? { runId: mocks.activeRunId } : null }),
}));
vi.mock('./features/chat/useChatSession', () => ({
  useChatSession: () => ({
    ...mocks, toolActivityForRun: vi.fn(), sessionId: 'default', sessions: [{ id: 'default' }], attached: [], turns: [], draft: 'Keep my draft',
  }),
}));
vi.mock('./features/chat/ChatPage', async (original) => {
  const actual = await original<typeof import('./features/chat/ChatPage')>();
  return {
    ...actual,
    Chat: () => null,
    ChatModelSelector: (props: Parameters<typeof actual.ChatModelSelector>[0]) => {
      mocks.onReset = props.onNewSession;
      return <actual.ChatModelSelector {...props} />;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.activeRunId = '';
  mocks.isAttachmentScopeCurrent.mockReturnValue(true);
  mocks.refreshSessions.mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderApp() {
  return render(<ConfirmProvider><App /></ConfirmProvider>);
}

function resetButton(label = 'Reset Session') {
  return screen.getByRole('button', { name: label }) as HTMLButtonElement;
}

describe('Reset Session pending feedback', () => {
  it('disables and relabels reset until the request and session refresh finish', async () => {
    const reset = deferred<boolean>();
    const refresh = deferred<void>();
    mocks.resetSession.mockReturnValue(reset.promise);
    mocks.refreshSessions.mockReturnValue(refresh.promise);
    renderApp();
    expect(resetButton().disabled).toBe(false);
    fireEvent.click(resetButton());
    expect(resetButton('Resetting…').disabled).toBe(true);
    fireEvent.click(resetButton('Resetting…'));
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.setDraft).not.toHaveBeenCalled();
    expect(mocks.clearAttachment).not.toHaveBeenCalled();

    await act(async () => { reset.resolve(true); await reset.promise; });
    expect(mocks.setDraft).toHaveBeenCalledWith('');
    expect(mocks.clearAttachment).toHaveBeenCalledTimes(1);
    expect(resetButton('Resetting…').disabled).toBe(true);
    await act(async () => { refresh.resolve(); await refresh.promise; });
    expect(resetButton().disabled).toBe(false);
  });

  it('blocks duplicate attempts even before React commits the pending state', async () => {
    const reset = deferred<boolean>();
    mocks.resetSession.mockReturnValue(reset.promise);
    renderApp();
    const attempt = mocks.onReset!;
    act(() => { attempt(); attempt(); });
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    await act(async () => { reset.resolve(true); await reset.promise; });
    expect(resetButton().disabled).toBe(false);
  });

  it('restores reset after failure, preserves the draft and attachments, and permits retry', async () => {
    const reset = deferred<boolean>();
    mocks.resetSession.mockReturnValueOnce(reset.promise).mockResolvedValueOnce(true);
    renderApp();
    fireEvent.click(resetButton());
    await act(async () => { reset.reject(new Error('Reset unavailable')); });
    expect(resetButton().disabled).toBe(false);
    expect(mocks.reportError).toHaveBeenCalledWith('Could not start a new session: Reset unavailable');
    expect(mocks.setDraft).not.toHaveBeenCalled();
    expect(mocks.clearAttachment).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(resetButton()); });
    expect(mocks.resetSession).toHaveBeenCalledTimes(2);
    expect(resetButton().disabled).toBe(false);
  });

  it('restores reset when a late response is discarded after navigation', async () => {
    const reset = deferred<boolean>();
    mocks.resetSession.mockReturnValue(reset.promise);
    renderApp();
    fireEvent.click(resetButton());
    mocks.isAttachmentScopeCurrent.mockReturnValue(false);
    await act(async () => { reset.resolve(false); await reset.promise; });
    expect(resetButton().disabled).toBe(false);
    expect(mocks.setDraft).not.toHaveBeenCalled();
    expect(mocks.clearAttachment).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
  });

  it('retains the existing active-run reset lock', () => {
    mocks.activeRunId = 'running';
    renderApp();
    expect(resetButton().disabled).toBe(true);
    fireEvent.click(resetButton());
    act(() => { mocks.onReset!(); });
    expect(mocks.resetSession).not.toHaveBeenCalled();
  });
});

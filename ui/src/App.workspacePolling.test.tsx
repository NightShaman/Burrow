import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { ConfirmProvider } from './app/ConfirmDialog';
import { writeStoredValue } from './app/browserStorage';

const mocks = vi.hoisted(() => ({ polling: vi.fn(), selectedAgentId: 'smatchet' }));
vi.mock('./app/api', async (original) => ({
  ...(await original<typeof import('./app/api')>()),
  api: vi.fn(async () => ({})),
}));
vi.mock('./app/modPanels', async (original) => ({
  ...(await original<typeof import('./app/modPanels')>()),
  loadModPanels: vi.fn(async () => []),
}));
vi.mock('./app/useRuntimeSelection', () => ({
  useRuntimeSelection: () => ({ selectedAgentId: mocks.selectedAgentId }),
}));
vi.mock('./app/useRuntimeAgents', () => ({
  formatAgentActivity: vi.fn(),
  useRuntimeAgents: () => ({
    agents: [{ id: 'smatchet', name: 'Smatchet', avatar: 'S', files: [], subagents: [] }],
  }),
}));
vi.mock('./app/useRuntimeDashboard', () => ({
  useRuntimeDashboard: () => ({
    savedProviders: [],
    operatorProfile: { name: 'Rob', avatar: 'R' },
  }),
}));
vi.mock('./features/workspace/useWorkspaceFiles', () => ({
  useWorkspaceFiles: (props: { pollingEnabled: boolean; selectedAgentId: string }) => {
    mocks.polling(props);
    return { workspaceFiles: [] };
  },
}));
vi.mock('./features/workspace/WorkspaceRail', () => ({
  WorkspaceRail: ({ onCollapse, onExpand }: { onCollapse: () => void; onExpand: () => void }) => (
    <>
      <button onClick={onCollapse}>Collapse left</button>
      <button onClick={onExpand}>Expand left</button>
    </>
  ),
}));
vi.mock('./features/panels/RightRail', () => ({
  RightRail: ({ onCollapse, onExpand }: { onCollapse: () => void; onExpand: () => void }) => (
    <>
      <button onClick={onCollapse}>Collapse right</button>
      <button onClick={onExpand}>Expand right</button>
    </>
  ),
}));
vi.mock('./features/chat/useChatRun', () => ({ useChatRun: () => ({}) }));
vi.mock('./features/chat/useChatSession', () => ({
  useChatSession: () => ({
    sessionId: 'default',
    sessions: [],
    attached: [],
    turns: [],
    draft: '',
  }),
}));
vi.mock('./features/chat/ChatPage', async (original) => ({
  ...(await original<typeof import('./features/chat/ChatPage')>()),
  Chat: () => null,
  ChatModelSelector: () => null,
  Editor: () => null,
}));

beforeEach(() => {
  localStorage.clear();
  mocks.polling.mockClear();
  mocks.selectedAgentId = 'smatchet';
});
afterEach(cleanup);

it('polls for either rendered Workspace surface and stops when neither is visible', () => {
  writeStoredValue('hc.leftRailLayout', 1, 'single');
  writeStoredValue('hc.leftSinglePanel', 1, 'agents');
  writeStoredValue('hc.rightRailLayout', 1, 'single');
  writeStoredValue('hc.rightSinglePanel', 1, 'workspace');
  render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>,
  );
  const latest = () =>
    mocks.polling.mock.lastCall?.[0] as { pollingEnabled: boolean; selectedAgentId: string };
  expect(latest().pollingEnabled).toBe(true); // right only
  fireEvent.click(screen.getByRole('button', { name: 'Collapse right' }));
  expect(latest().pollingEnabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Expand right' }));
  expect(latest().pollingEnabled).toBe(true);
  mocks.selectedAgentId = 'hatchet';
  fireEvent.click(screen.getByRole('button', { name: 'Collapse left' }));
  expect(latest()).toMatchObject({ pollingEnabled: true, selectedAgentId: 'hatchet' });
  fireEvent.click(screen.getByRole('button', { name: 'settings' }));
  expect(latest().pollingEnabled).toBe(false);
});

it.each([
  ['left-only', 'workspace', 'agents', true],
  ['both', 'workspace', 'workspace', true],
  ['neither', 'agents', 'agents', false],
] as const)('polls for %s single-rail layout', (_name, left, right, enabled) => {
  writeStoredValue('hc.leftRailLayout', 1, 'single');
  writeStoredValue('hc.leftSinglePanel', 1, left);
  writeStoredValue('hc.rightRailLayout', 1, 'single');
  writeStoredValue('hc.rightSinglePanel', 1, right);
  render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>,
  );
  expect(mocks.polling.mock.lastCall?.[0].pollingEnabled).toBe(enabled);
});
it('treats divided right rail Workspace as visible until collapsed', () => {
  writeStoredValue('hc.leftRailLayout', 1, 'single');
  writeStoredValue('hc.leftSinglePanel', 1, 'agents');
  writeStoredValue('hc.rightRailLayout', 1, 'divided');
  writeStoredValue('hc.rightBottomPanel', 1, 'workspace');
  render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>,
  );
  expect(mocks.polling.mock.lastCall?.[0].pollingEnabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse right' }));
  expect(mocks.polling.mock.lastCall?.[0].pollingEnabled).toBe(false);
});

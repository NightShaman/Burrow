import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type ActiveChatRunsResponse, type SessionTurn } from '../../app/api';
import { useChatSession } from './useChatSession';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);
const artifact: SessionTurn = {
  id: 'forge-artifact',
  type: 'message',
  role: 'assistant',
  content: '',
  metadata: {
    kind: 'forge-artifact',
    attachments: [
      { name: 'generated.png', type: 'image/png', artifactPath: 'artifacts/generated.png' },
    ],
  },
};
let turns: SessionTurn[];
let active: ActiveChatRunsResponse;
const conversationPath = '/api/sessions/default?agentId=gerald';
const conversationLoads = () =>
  apiMock.mock.calls.filter(([path]) => path === conversationPath).length;
async function flush() {
  await act(async () => {});
}
async function tick() {
  await act(async () => vi.advanceTimersByTimeAsync(1000));
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  turns = [];
  active = {
    ok: true,
    runs: [{ agentId: 'gerald', sessionId: 'default', runId: 'generation', status: 'running' }],
  };
  apiMock.mockReset();
  apiMock.mockImplementation(async (path) => {
    if (path === '/api/sessions?agentId=gerald')
      return { sessions: [{ id: 'default' }, { id: 'other' }] };
    if (path === conversationPath)
      return { session: { id: 'default', turns: structuredClone(turns) } };
    if (path === '/api/sessions/other?agentId=gerald')
      return {
        session: { id: 'other', turns: [{ role: 'assistant', content: 'Other destination' }] },
      };
    if (path === '/api/chat/generation/cancel') return { ok: true };
    if (path.startsWith('/api/chat/runs/active'))
      return path.includes('sessionId=default')
        ? active
        : { ok: true, runs: [], pendingForgeDeliveries: 0 };
    throw new Error(`Unexpected path: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows a late persisted assistant attachment in the cancelled originating chat and performs the final count-zero reload', async () => {
  const { result } = renderHook(() => useChatSession('gerald'));
  await flush();
  expect(result.current.sessionId).toBe('default');
  expect(result.current.runtimeRun?.runId).toBe('generation');
  await act(async () => result.current.cancelRuntimeRun(result.current.runtimeRun!));
  turns = [
    {
      role: 'assistant',
      content: '',
      runId: 'generation',
      metadata: { chatResultVersion: 2, terminalStatus: 'cancelled' },
    },
  ];
  active = { ok: true, runs: [], pendingForgeDeliveries: 1 };
  await tick();
  expect(result.current.runtimeRun).toBeNull();
  expect(result.current.turns.some((turn) => turn.metadata?.terminalStatus === 'cancelled')).toBe(
    true,
  );
  turns.push(artifact);
  await tick();
  expect(result.current.sessionId).toBe('default');
  expect(result.current.turns.find((turn) => turn.id === artifact.id)).toEqual(artifact);
  // Persist one last write as the count settles: disappearance must trigger its own reload.
  turns.push({ id: 'settled', role: 'assistant', content: 'Delivery settled' });
  active = { ok: true, runs: [], pendingForgeDeliveries: 0 };
  const beforeFinal = conversationLoads();
  await tick();
  expect(conversationLoads()).toBe(beforeFinal + 1);
  expect(result.current.turns.map((turn) => turn.id)).toContain('settled');
  expect(result.current.turns.filter((turn) => turn.id === artifact.id)).toHaveLength(1);
  const afterFinal = conversationLoads();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(conversationLoads()).toBe(afterFinal);
});

it('does not apply a late originating Forge transcript to a different selected destination', async () => {
  active = { ok: true, runs: [], pendingForgeDeliveries: 0 };
  const { result } = renderHook(() => useChatSession('gerald'));
  await flush();
  let resolve!: (value: unknown) => void;
  const late = new Promise((next) => {
    resolve = next;
  });
  const initial = apiMock.getMockImplementation()!;
  apiMock.mockImplementation((path, ...args) =>
    path === conversationPath ? late : initial(path, ...args),
  );
  active = { ok: true, runs: [], pendingForgeDeliveries: 1 };
  await tick();
  act(() => result.current.selectSession('other'));
  await flush();
  expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Other destination' }]);
  await act(async () => resolve({ session: { id: 'default', turns: [artifact] } }));
  await tick();
  expect(result.current.sessionId).toBe('other');
  expect(result.current.turns).toEqual([{ role: 'assistant', content: 'Other destination' }]);
});

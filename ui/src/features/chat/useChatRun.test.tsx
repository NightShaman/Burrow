import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { streamChat } from './chatStream';
import { trimStreamedAnswer, useChatRun } from './useChatRun';

vi.mock('../../app/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));

vi.mock('./chatStream', () => ({ streamChat: vi.fn() }));

const streamChatMock = vi.mocked(streamChat);

function createSession() {
  return {
    attached: [],
    clearAttachment: vi.fn(),
    sessionId: 'session-1',
    draft: 'Trigger the model error',
    setDraft: vi.fn(),
    clearError: vi.fn(),
    reportError: vi.fn(),
    leaveNewSessionForMessage: vi.fn(),
    appendTurn: vi.fn(),
    appendTransientTurn: vi.fn(),
    storeToolActivity: vi.fn(),
    toolActivityForRun: vi.fn(),
    clearRunState: vi.fn(),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshConversation: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  streamChatMock.mockReset();
  vi.mocked(api).mockReset();
});

describe('useChatRun', () => {
  it('removes only meaningful exact stream overlap with the final answer', () => {
    expect(trimStreamedAnswer('Working notes.\n\nAuthoritative final answer.', 'Authoritative   final answer.')).toBe('Working notes.');
    expect(trimStreamedAnswer('A streamed response that differs.', 'A rewritten final response.')).toBe('A streamed response that differs.');
    expect(trimStreamedAnswer('Short tail ok', 'ok and more')).toBe('Short tail ok');
  });

  it('closes a superseded run without appending or reporting a synthetic assistant error', async () => {
    streamChatMock.mockImplementation(async ({ onEvent, onAccepted }) => {
      onAccepted?.();
      onEvent({ type: 'assistant.thought', data: { delta: 'Old run progress.' } });
      onEvent({ type: 'tool.started', data: { tool: 'shell_exec', activityId: 'old-tool', command: 'echo old' } });
      return {
        terminalType: 'run.superseded',
        finalResult: { ok: false, error: 'superseded_by_newer_session_run' },
      };
    });
    const session = createSession();
    const activity = { items: [] as Array<{ id: string; label: string; detail?: string; status?: 'pending' | 'ok' | 'error' }> };
    session.toolActivityForRun.mockImplementation(() => activity);
    session.storeToolActivity.mockImplementation((next) => { activity.items = next.items; });
    const setAgentActivity = vi.fn();
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [],
      session,
      setAgentActivity,
    }));

    await act(async () => { await result.current.sendMessage(); });

    const runId = (streamChatMock.mock.calls[0][0].requestBody as { runId: string }).runId;
    expect(session.clearRunState).toHaveBeenCalledWith('nigel', 'session-1', runId);
    expect(session.appendTurn).toHaveBeenCalledTimes(1);
    expect(session.appendTurn).toHaveBeenCalledWith('nigel', 'session-1', expect.objectContaining({ role: 'user', runId }));
    expect(session.reportError).not.toHaveBeenCalled();
    expect(result.current.activeRunId).toBe('');
    expect(result.current.liveProgress).toEqual([]);
    expect(result.current.liveAnswer).toBe('');
    expect(setAgentActivity).toHaveBeenLastCalledWith('nigel', 'idle');
    await waitFor(() => expect(session.refreshConversation).toHaveBeenCalledWith('nigel', 'session-1'));
  });

  it('reconciles the active conversation after a failed terminal event', async () => {
    streamChatMock.mockResolvedValue({
      terminalType: 'run.failed',
      finalResult: { ok: false },
    });
    const session = createSession();
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [],
      session,
      setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.appendTurn).toHaveBeenLastCalledWith('nigel', 'session-1', expect.objectContaining({
      role: 'assistant',
      content: '[model_error: The runtime could not complete the message.]',
    }));
    await waitFor(() => expect(session.refreshConversation).toHaveBeenCalledWith('nigel', 'session-1'));
    expect(session.refreshSessions).toHaveBeenCalledWith('nigel');
  });

  it('keeps /context visible for the current visit without caching or immediately reconciling it away', async () => {
    streamChatMock.mockImplementation(async ({ onAccepted }) => { onAccepted?.(); return { terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Context: 42% used.' } }; });
    const session = createSession();
    session.draft = '/context';
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [], session, setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.appendTransientTurn).toHaveBeenNthCalledWith(1, 'nigel', 'session-1', expect.objectContaining({ role: 'user', content: '/context' }));
    expect(session.appendTransientTurn).toHaveBeenNthCalledWith(2, 'nigel', 'session-1', expect.objectContaining({ role: 'assistant', content: 'Context: 42% used.' }));
    expect(session.appendTurn).not.toHaveBeenCalled();
    expect(session.refreshConversation).not.toHaveBeenCalled();
    expect(session.refreshSessions).toHaveBeenCalledWith('nigel');
  });

  it('preserves normal message persistence and reconciliation', async () => {
    streamChatMock.mockImplementation(async ({ onAccepted }) => { onAccepted?.(); return { terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Normal reply.' } }; });
    const session = createSession();
    session.draft = 'Hello';
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.appendTurn).toHaveBeenCalledTimes(2);
    expect(session.appendTransientTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(session.refreshConversation).toHaveBeenCalledWith('nigel', 'session-1'));
  });

  it('coalesces word-sized thought deltas by model call without changing the terminal answer', async () => {
    streamChatMock.mockImplementation(async ({ onEvent, onAccepted }) => {
      onAccepted?.();
      onEvent({ type: 'assistant.thought', ts: '2026-09-22T10:00:00.000Z', data: { delta: 'decide', modelCall: 1 } });
      onEvent({ type: 'assistant.thought', data: { delta: ' which', modelCall: 1 } });
      onEvent({ type: 'assistant.thought', data: { delta: '\nnext', modelCall: 2 } });
      onEvent({ type: 'assistant.thought', data: { delta: ' call', modelCall: 2 } });
      return { terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Final answer.' } };
    });
    const session = createSession();
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [], session, setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.appendTurn).toHaveBeenLastCalledWith('nigel', 'session-1', expect.objectContaining({
      role: 'assistant',
      content: 'Final answer.',
      metadata: expect.objectContaining({
        progress: { status: 'complete', items: [
          expect.objectContaining({ text: 'decide which', modelCall: 1, status: 'complete' }),
          expect.objectContaining({ text: '\nnext call', modelCall: 2, status: 'complete' }),
        ] },
      }),
    }));
  });

  it('retains visible streamed output separately from the final answer', async () => {
    streamChatMock.mockImplementation(async ({ onEvent, onAccepted }) => {
      onAccepted?.();
      onEvent({ type: 'assistant.delta', data: { delta: 'Draft streamed response.' } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Authoritative final answer.' } };
    });
    const session = createSession();
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [], session, setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.appendTurn).toHaveBeenLastCalledWith('nigel', 'session-1', expect.objectContaining({
      role: 'assistant', content: 'Authoritative final answer.', metadata: expect.objectContaining({ streamedAnswer: 'Draft streamed response.' }),
    }));
  });

  it.each([
    { tool: 'mcp_call', provider: 'Bitwarden', mcpToolName: 'get', expectedLabel: 'MCP · Bitwarden · get', expectedDetail: 'Bitwarden · get' },
    { tool: 'load_skill', skillId: 'frontend-review', expectedLabel: 'Load skill · frontend-review', expectedDetail: 'frontend-review' },
  ])('shows only safe identity for $tool in tool activity', async (identity) => {
    const activity = { items: [] as Array<{ id: string; label: string; detail?: string; status?: 'pending' | 'ok' | 'error' }> };
    streamChatMock.mockImplementation(async ({ onEvent, onAccepted }) => {
      onAccepted?.();
      onEvent({ type: 'tool.started', data: {
        ...identity, activityId: 'mcp-1', detail: 'absolutely-not-for-the-transcript',
        mcpArguments: { secret: 'absolutely-not-for-the-transcript' }, output: 'also-not-for-the-transcript',
      } });
      return { terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Done.' } };
    });
    const session = createSession();
    session.toolActivityForRun.mockImplementation(() => activity);
    session.storeToolActivity.mockImplementation((next) => { activity.items = next.items; });
    const { result } = renderHook(() => useChatRun({
      selectedAgentId: 'nigel',
      selected: { id: 'nigel', name: 'Nigel', avatar: '', activity: 'idle', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] },
      savedProviders: [], session, setAgentActivity: vi.fn(),
    }));

    await act(async () => { await result.current.sendMessage(); });

    expect(session.storeToolActivity).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: identity.expectedLabel, detail: identity.expectedDetail })] }));
    expect(session.storeToolActivity).not.toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ detail: expect.stringContaining('absolutely-not-for-the-transcript') })] }));
  });

});


describe('FE-014 immediate acceptance', () => {
  it.each(['agent', 'session', 'blank'])('does not accept an unavailable %s', async (missing) => {
    const session = createSession();
    if (missing === 'session') session.sessionId = '';
    if (missing === 'blank') session.draft = '  ';
    const { result } = renderHook(() => useChatRun({ selectedAgentId: missing === 'agent' ? '' : 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }));
    const accepted = vi.fn();
    await act(async () => { await result.current.sendMessage(undefined, accepted); });
    expect(accepted).not.toHaveBeenCalled();
    expect(session.setDraft).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it('accepts only after HTTP acceptance, rejects duplicate/running sends and awaits completion', async () => {
    let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
    let accept!: () => void;
    streamChatMock.mockImplementation(({ onAccepted }) => { accept = () => onAccepted?.(); return new Promise((resolve) => { complete = resolve; }); });
    const session = createSession();
    const { result } = renderHook(() => useChatRun({ selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }));
    const accepted = vi.fn(); const rejected = vi.fn(); let settled = false;
    let completion!: Promise<void>;
    act(() => {
      completion = result.current.sendMessage('Accepted', accepted);
      void completion.then(() => { settled = true; });
      void result.current.sendMessage('Duplicate', rejected);
      expect(accepted).not.toHaveBeenCalled();
    });
    act(() => accept());
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await act(async () => { await result.current.sendMessage('Next draft', rejected); });
    expect(rejected).not.toHaveBeenCalled();
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    session.setDraft.mockClear(); session.draft = 'Typed next draft';
    await act(async () => { complete({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Done' } }); await completion; });
    expect(settled).toBe(true);
    expect(session.setDraft).not.toHaveBeenCalled();
  });
});

it('records browser-local send, useful delta and React commit without dispatch-only timing', async () => {
  let emit!: (event: unknown) => void;
  let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
  streamChatMock.mockImplementation(({ onEvent }) => { emit = onEvent; return new Promise((resolve) => { complete = resolve; }); });
  const session = createSession();
  const { result } = renderHook(() => useChatRun({ selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.sendMessage(); });
  const runId = (streamChatMock.mock.calls[0][0].requestBody as { runId: string }).runId;
  const prefix = `chat:${runId}:`;
  expect(performance.getEntriesByName(`${prefix}send`)).toHaveLength(1);
  act(() => emit({ type: 'model.dispatched', data: { modelCall: 1 } }));
  expect(performance.getEntriesByName(`${prefix}first-useful`)).toHaveLength(0);
  act(() => emit({ type: 'assistant.delta', data: { delta: 'Visible', modelCall: 1 } }));
  await waitFor(() => expect(result.current.liveAnswer).toBe('Visible'));
  expect(performance.getEntriesByName(`${prefix}first-useful`)).toHaveLength(1);
  expect(performance.getEntriesByName(`${prefix}react-commit-observed`)).toHaveLength(1);
  expect(performance.getEntriesByName(`${prefix}send-to-first-useful`)).toHaveLength(1);
  await act(async () => { complete({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Done' } }); await pending; });
});

describe('truthful live stages', () => {
  it('tracks preparation and request intent without manufacturing thought or final metadata; rejects stale callbacks', async () => {
    let emit!: (event: unknown) => void;
    let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
    streamChatMock.mockImplementation(({ onEvent }) => { emit = onEvent; return new Promise((resolve) => { complete = resolve; }); });
    const session = createSession();
    const { result, rerender } = renderHook(({ agent }) => useChatRun({ selectedAgentId: agent, selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }), { initialProps: { agent: 'nigel' } });
    let pending!: Promise<void>;
    act(() => { pending = result.current.sendMessage(); });
    expect(result.current.liveStage).toBe('accepted');
    act(() => emit({ type: 'run.started' }));
    expect(result.current.liveStage).toBe('preparing');
    act(() => emit({ type: 'route.decided' }));
    expect(result.current.liveStage).toBe('preparing');
    act(() => emit({ type: 'model.started' }));
    expect(result.current.liveStage).toBe('request-intent');
    act(() => emit({ type: 'model.dispatched', sessionId: 'wrong', data: { modelCall: 1 } }));
    expect(result.current.liveStage).toBe('request-intent');
    act(() => emit({ type: 'model.dispatched', data: { modelCall: 1 } }));
    expect(result.current.liveStage).toBe('dispatched');
    act(() => emit({ type: 'model.started', data: { modelCall: 2 } }));
    act(() => emit({ type: 'model.dispatched', data: { modelCall: 1 } }));
    expect(result.current.liveStage).toBe('request-intent');
    act(() => emit({ type: 'assistant.delta', data: { modelCall: 1 } }));
    expect(result.current.liveAnswer).toBe('');
    expect(result.current.liveProgress).toEqual([]);
    rerender({ agent: 'other' });
    act(() => emit({ type: 'model.completed' }));
    expect(result.current.liveStage).toBeUndefined();
    rerender({ agent: 'nigel' });
    expect(result.current.liveStage).toBe('model-completed');
    await act(async () => { complete({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Final-only answer' } }); await pending; });
    expect(result.current.liveStage).toBeUndefined();
    expect(session.appendTurn).toHaveBeenLastCalledWith('nigel', 'session-1', expect.objectContaining({ content: 'Final-only answer', metadata: undefined }));
    // The previous stream no longer owns this selection.
    act(() => { pending = result.current.sendMessage('Next'); });
    const currentEmit = emit;
    // Capture callbacks via the previous call rather than the new owner.
    act(() => streamChatMock.mock.calls[0][0].onEvent({ type: 'model.completed' }));
    expect(result.current.liveStage).toBe('accepted');
    act(() => currentEmit({ type: 'model.started' }));
    expect(result.current.liveStage).toBe('request-intent');
    await act(async () => { complete({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'Next final' } }); await pending; });
  });
});

describe('Stop retirement', () => {
  it.each(['success', 'not_found'])('retires exact local/projected run on %s without waiting for a stalled stream', async (outcome) => {
    const completions: Array<(value: Awaited<ReturnType<typeof streamChat>>) => void> = [];
    streamChatMock.mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    if (outcome === 'success') vi.mocked(api).mockResolvedValue({ ok: true });
    else vi.mocked(api).mockRejectedValue(Object.assign(new Error('chat_run_not_found'), { status: 404 }));
    const session = createSession();
    const onRunStopped = vi.fn();
    const { result } = renderHook(() => useChatRun({ selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn(), onRunStopped }));
    let oldCompletion!: Promise<void>;
    act(() => { oldCompletion = result.current.sendMessage(); });
    const oldRunId = result.current.activeRunId;
    act(() => streamChatMock.mock.calls[0][0].onEvent({ type: 'assistant.delta', data: { delta: 'Old text' } }));
    await waitFor(() => expect(result.current.liveAnswer).toBe('Old text'));
    await act(async () => { await result.current.cancelRun(); });
    expect(result.current.activeRunId).toBe('');
    expect(result.current.liveAnswer).toBe('');
    expect(result.current.liveProgress).toEqual([]);
    expect(onRunStopped).toHaveBeenCalledWith({ agentId: 'nigel', sessionId: 'session-1', runId: oldRunId });
    expect(streamChatMock.mock.calls[0][0].signal.aborted).toBe(true);
    expect(session.refreshConversation).toHaveBeenCalledWith('nigel', 'session-1');
    expect(session.reportError).not.toHaveBeenCalled();
    let nextCompletion!: Promise<void>;
    act(() => { nextCompletion = result.current.sendMessage('Next'); });
    const nextRunId = result.current.activeRunId;
    act(() => streamChatMock.mock.calls[1][0].onEvent({ type: 'assistant.delta', data: { delta: 'New text' } }));
    await waitFor(() => expect(result.current.liveAnswer).toBe('New text'));
    await act(async () => { completions[0]({ terminalType: 'run.completed', finalResult: { answerText: 'Stale answer' } }); await oldCompletion; });
    expect(result.current.activeRunId).toBe(nextRunId);
    expect(result.current.liveAnswer).toBe('New text');
    expect(session.appendTurn).not.toHaveBeenCalledWith('nigel', 'session-1', expect.objectContaining({ role: 'assistant', runId: oldRunId }));
    await act(async () => { completions[1]({ terminalType: 'run.completed', finalResult: { answerText: 'New answer' } }); await nextCompletion; });
  });

  it('retires the local stream even when Stop fails, while reporting the runtime failure', async () => {
    let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
    streamChatMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    vi.mocked(api).mockRejectedValue(Object.assign(new Error('chat_run_not_found'), { status: 503 }));
    const session = createSession();
    const { result } = renderHook(() => useChatRun({ selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }));
    let completion!: Promise<void>;
    act(() => { completion = result.current.sendMessage(); });
    await act(async () => { await result.current.cancelRun(); });
    expect(result.current.activeRunId).toBe('');
    expect(streamChatMock.mock.calls[0][0].signal.aborted).toBe(true);
    expect(session.reportError).toHaveBeenCalledWith('Could not stop run: chat_run_not_found');
    await act(async () => { complete({ terminalType: 'run.completed', finalResult: { answerText: 'Done' } }); await completion; });
  });

  it('cannot strand the old local run when navigation aborts a pending Stop request', async () => {
    let resolveStop!: (value: unknown) => void;
    vi.mocked(api).mockReturnValue(new Promise(resolve => { resolveStop = resolve; }));
    let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
    streamChatMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const session = createSession();
    const { result, rerender } = renderHook(({ agent }) => useChatRun({ selectedAgentId: agent, selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }), { initialProps: { agent: 'nigel' } });
    let completion!: Promise<void>;
    act(() => { completion = result.current.sendMessage(); });
    let stopping!: Promise<void>;
    act(() => { stopping = result.current.cancelRun(); });
    expect(result.current.activeRunId).toBe('');
    rerender({ agent: 'other' });
    rerender({ agent: 'nigel' });
    expect(result.current.activeRunId).toBe('');
    await act(async () => { resolveStop({ ok: true }); await stopping; });
    expect(result.current.activeRunId).toBe('');
    await act(async () => { complete({ terminalType: 'run.completed', finalResult: { answerText: 'Late' } }); await completion; });
  });
});

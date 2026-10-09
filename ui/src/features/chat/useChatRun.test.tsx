import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './chatStream';
import { trimStreamedAnswer, useChatRun } from './useChatRun';

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
    storeToolActivity: vi.fn(),
    toolActivityForRun: vi.fn(),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshConversation: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  streamChatMock.mockReset();
});

describe('useChatRun', () => {
  it('removes only meaningful exact stream overlap with the final answer', () => {
    expect(trimStreamedAnswer('Working notes.\n\nAuthoritative final answer.', 'Authoritative   final answer.')).toBe('Working notes.');
    expect(trimStreamedAnswer('A streamed response that differs.', 'A rewritten final response.')).toBe('A streamed response that differs.');
    expect(trimStreamedAnswer('Short tail ok', 'ok and more')).toBe('Short tail ok');
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

  it('coalesces word-sized thought deltas by model call without changing the terminal answer', async () => {
    streamChatMock.mockImplementation(async ({ onEvent }) => {
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
    streamChatMock.mockImplementation(async ({ onEvent }) => {
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

  it('shows only safe MCP provider and tool identity in tool activity', async () => {
    const activity = { items: [] as Array<{ id: string; label: string; detail?: string; status?: 'pending' | 'ok' | 'error' }> };
    streamChatMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'tool.started', data: {
        tool: 'mcp_call', activityId: 'mcp-1', provider: 'Bitwarden', mcpToolName: 'get',
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

    expect(session.storeToolActivity).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: 'MCP tool', detail: 'Bitwarden · get' })] }));
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

  it('accepts synchronously, rejects duplicate/running sends and awaits completion', async () => {
    let complete!: (value: Awaited<ReturnType<typeof streamChat>>) => void;
    streamChatMock.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const session = createSession();
    const { result } = renderHook(() => useChatRun({ selectedAgentId: 'nigel', selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() }));
    const accepted = vi.fn(); const rejected = vi.fn(); let settled = false;
    let completion!: Promise<void>;
    act(() => {
      completion = result.current.sendMessage('Accepted', accepted);
      void completion.then(() => { settled = true; });
      void result.current.sendMessage('Duplicate', rejected);
      expect(accepted).toHaveBeenCalledTimes(1);
    });
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

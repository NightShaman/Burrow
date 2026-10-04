import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { Chat, ChatModelSelector } from './ChatPage';

const agent: Agent = {
  id: 'smatchet',
  name: 'Smatchet',
  avatar: 'S',
  activity: 'idle',
  context: null,
  provider: 'test',
  model: 'test-model',
  effort: 'off',
  temperature: 0.2,
  workspace: '',
  files: [],
  subagents: [],
};

function renderChat(overrides: Partial<Parameters<typeof Chat>[0]> = {}) {
  const setDraft = vi.fn();
  const onSend = vi.fn((_draft?: string, accepted?: () => void) => accepted?.());
  const props: Parameters<typeof Chat>[0] = {
    selected: agent,
    parent: agent,
    operator: { name: 'Rob', avatar: 'R' },
    draft: '',
    setDraft,
    attached: [],
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    isNewSession: false,
    turns: [],
    isLoading: false,
    error: '',
    isSending: false,
    activeRunId: '',
    liveProgress: [],
    liveAnswer: '',
    onSend,
    onCancel: vi.fn(),
    selectedAgentId: agent.id,
    resourceAgentId: agent.id,
    sessionId: 'default',
    ...overrides,
  };
  return { ...render(<Chat {...props} />), props, setDraft, onSend };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Chat session picker', () => {
  it('excludes group and artifact sessions even when the API omits classification metadata', () => {
    const sessions = [
      { id: 'default' },
      { id: 'Issues' },
      { id: 'group-group-34d69c4b-2848-4b5b-a76a-8b0262a9a9be' },
      { id: 'artifact-smoke-image-1790371247' },
      { id: 'artifact-foundry-tts-1790372961-bf1b91cc' },
    ];
    const provider = { id: 'provider', provider: 'test', apiType: 'openai', url: '', apiKey: '', models: ['test-model'] };
    const onSessionChange = vi.fn();

    render(<ChatModelSelector selected={agent} savedProviders={[provider]} updateAgent={vi.fn()} sessions={sessions} sessionId="default" onSessionChange={onSessionChange} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);

    const picker = screen.getByRole('combobox', { name: 'Session' });
    expect(Array.from((picker as HTMLSelectElement).options).map((option) => option.value)).toEqual(['default', 'Issues']);
  });
});

describe('Chat composer draft ownership', () => {
  it('keeps typing local and debounces durable draft updates', () => {
    vi.useFakeTimers();
    const { setDraft } = renderChat();
    const composer = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(composer, { target: { value: 'Typing stays responsive' } });

    expect((composer as HTMLTextAreaElement).value).toBe('Typing stays responsive');
    expect(setDraft).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(setDraft).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setDraft).toHaveBeenCalledWith('Typing stays responsive');
  });

  it('does not replace active typing with a delayed persistence echo', () => {
    vi.useFakeTimers();
    const { props, rerender, setDraft } = renderChat();
    const composer = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(composer, { target: { value: 'super' } });
    vi.advanceTimersByTime(250);
    expect(setDraft).toHaveBeenCalledWith('super');

    fireEvent.change(composer, { target: { value: 'super fast' } });
    rerender(<Chat {...props} draft="super" />);

    expect((composer as HTMLTextAreaElement).value).toBe('super fast');
  });

  it('hydrates the correct draft when the conversation changes', () => {
    const { props, rerender } = renderChat({ draft: 'First conversation' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Unsaved first conversation edit' } });

    rerender(<Chat {...props} sessionId="another-session" draft="Second conversation" />);

    expect((composer as HTMLTextAreaElement).value).toBe('Second conversation');
  });

  it('flushes the latest draft when leaving the chat', () => {
    vi.useFakeTimers();
    const { setDraft, unmount } = renderChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep this when I come back' } });

    unmount();

    expect(setDraft).toHaveBeenCalledWith('Keep this when I come back');
  });

  it('sends the latest local value before the persistence debounce', () => {
    vi.useFakeTimers();
    const { onSend } = renderChat();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Send this now' } });

    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('Send this now', expect.any(Function));
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });
});

describe('FE-014 submission acceptance', () => {
  it.each([true, false])('retains blocked draft (running=%s)', (running) => {
    const onCancel = vi.fn();
    const { onSend } = renderChat({ draft: running ? 'Next message' : '   ', isSending: running, onCancel });
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe(running ? 'Next message' : '   ');
    if (running) {
      fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    } else expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retains rejected text and persisted draft', () => {
    const onSend = vi.fn();
    const { setDraft } = renderChat({ draft: 'Unavailable selection', onSend });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith('Unavailable selection', expect.any(Function));
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Unavailable selection');
    expect(setDraft).not.toHaveBeenCalledWith('');
  });

  it('clears accepted draft immediately, not the next draft on completion', async () => {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const onSend = vi.fn((_draft?: string, accepted?: () => void) => { accepted?.(); return completion; });
    const { setDraft } = renderChat({ draft: 'Accepted message', onSend });
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(setDraft).toHaveBeenCalledWith('');
    fireEvent.change(input, { target: { value: 'Next draft' } });
    complete(); await completion;
    expect((input as HTMLTextAreaElement).value).toBe('Next draft');
  });

  it('retains Shift+Enter and IME guards', () => {
    const { onSend } = renderChat({ draft: 'Composition' });
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });
});

it.each(['Session load failed', 'Attachment rejected', 'Run failed', 'Reset failed'])('FE016 composed Chat exposes empty transcript error: %s', error => {
 const { onSend } = renderChat({ error, turns: [], draft: '' });
 expect(screen.getByText(error)).toBeTruthy();
 expect(onSend).not.toHaveBeenCalled();
});

import { useChatRun } from './useChatRun';
import { streamChat } from './chatStream';
vi.mock('./chatStream', () => ({ streamChat: vi.fn() }));
it.each(['agent', 'session'])('FE014 composed run/page retains unavailable %s draft and makes zero stream calls', missing => {
  vi.mocked(streamChat).mockClear();
  const setDraft = vi.fn();
  function Fixture() {
    const session = {
      attached: [], clearAttachment: vi.fn(), sessionId: missing === 'session' ? '' : 'default',
      draft: 'Keep this draft', setDraft, clearError: vi.fn(), reportError: vi.fn(),
      leaveNewSessionForMessage: vi.fn(), appendTurn: vi.fn(), storeToolActivity: vi.fn(),
      toolActivityForRun: vi.fn(), refreshSessions: vi.fn().mockResolvedValue(undefined),
      refreshConversation: vi.fn().mockResolvedValue(undefined),
    };
    const run = useChatRun({ selectedAgentId: missing === 'agent' ? '' : agent.id,
      selected: undefined, savedProviders: [], session, setAgentActivity: vi.fn() });
    return <Chat selected={agent} parent={agent} operator={{name:'Rob',avatar:'R'}}
      draft={session.draft} setDraft={setDraft} attached={[]} onAttach={vi.fn()} onRemoveAttachment={vi.fn()}
      isNewSession={false} turns={[]} isLoading={false} error="" isSending={Boolean(run.activeRunForSelection)}
      activeRunId="" liveProgress={[]} liveAnswer="" onSend={run.sendMessage} onCancel={vi.fn()}
      selectedAgentId={agent.id} resourceAgentId={agent.id} sessionId={session.sessionId} />;
  }
  render(<Fixture />);
  const input = screen.getByRole('textbox', {name:'Message'});
  fireEvent.keyDown(input, {key:'Enter'});
  fireEvent.click(screen.getByRole('button', {name:'Send message'}));
  expect(streamChat).not.toHaveBeenCalled();
  expect(input).toHaveProperty('value', 'Keep this draft');
  expect(setDraft).not.toHaveBeenCalledWith('');
});

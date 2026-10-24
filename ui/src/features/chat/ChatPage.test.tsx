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
  it('orders session controls from actions through routing to the picker', () => {
    render(<ChatModelSelector selected={agent} savedProviders={[]} updateAgent={vi.fn()} sessions={[{ id: 'default' }]} sessionId="default" onSessionChange={vi.fn()} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);

    const controls = screen.getByRole('combobox', { name: 'Session' }).closest('.session-controls');
    expect(Array.from(controls?.children ?? []).map((element) =>
      element instanceof HTMLButtonElement ? element.textContent : element.querySelector('input, select')?.id,
    )).toEqual(['Group Chat', 'New session', 'Reset Session', 'chat-a2a-in-default', 'chat-session']);
    expect(screen.getByRole('combobox', { name: 'Session' }).closest('label')?.className).toBe('session-selector-control');
  });

  it('allows switching sessions back and forth during an active run while keeping mutation controls locked', () => {
    const onSessionChange = vi.fn();
    const props = { selected: agent, savedProviders: [], updateAgent: vi.fn(), sessions: [{ id: 'default' }, { id: 'Issues' }], sessionId: 'default', onSessionChange, onNewSession: vi.fn(), onNewNamedSession: vi.fn(), onCreateGroup: vi.fn(), locked: true };
    const { rerender } = render(<ChatModelSelector {...props} />);
    const picker = screen.getByRole('combobox', { name: 'Session' });
    expect(picker).toHaveProperty('disabled', false);
    fireEvent.change(picker, { target: { value: 'Issues' } });
    expect(onSessionChange).toHaveBeenLastCalledWith('Issues');
    rerender(<ChatModelSelector {...props} sessionId="Issues" />);
    fireEvent.change(picker, { target: { value: 'default' } });
    expect(onSessionChange).toHaveBeenLastCalledWith('default');
    expect(screen.getByRole('button', { name: 'Reset Session' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'New session' })).toHaveProperty('disabled', true);
  });

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

  it('renders resolved Telegram labels while preserving raw routing values and titles', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mods: [{ id: 'burrow-switchboard', status: 'loaded' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ connections: [{ id: 'default', name: 'Telegram', mappings: [{ chatId: '-1001', topicId: null, chatTitle: 'Kingdom Trouble' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onSessionChange = vi.fn();
    render(<ChatModelSelector selected={agent} savedProviders={[]} updateAgent={vi.fn()} sessions={[{ id: 'default' }, { id: 'telegram:-1001:root' }]} sessionId="telegram:-1001:root" onSessionChange={onSessionChange} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);

    const option = await screen.findByRole('option', { name: 'Telegram · Kingdom Trouble' });
    expect(option).toHaveProperty('value', 'telegram:-1001:root');
    expect(option.getAttribute('title')).toBe('telegram:-1001:root');
    fireEvent.change(screen.getByRole('combobox', { name: 'Session' }), { target: { value: 'default' } });
    expect(onSessionChange).toHaveBeenCalledWith('default');
  });

  it('renders Discord labels and thread titles while keeping raw option values and routing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mods: [{ id: 'burrow-switchboard', status: 'loaded' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ connections: [
        { id: 'guild', transportType: 'discord', mappings: [{ channelId: '123', chatTitle: 'Town Hall' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onSessionChange = vi.fn();
    render(<ChatModelSelector selected={agent} savedProviders={[]} updateAgent={vi.fn()} sessions={[{ id: 'discord:guild:123' }, { id: 'discord:guild:unknown' }]} sessionId="discord:guild:123" onSessionChange={onSessionChange} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);
    const option = await screen.findByRole('option', { name: 'Discord · Town Hall' });
    expect(option).toHaveProperty('value', 'discord:guild:123');
    expect(option.getAttribute('title')).toBe('discord:guild:123');
    expect(screen.getByRole('option', { name: 'discord:guild:unknown' })).toHaveProperty('value', 'discord:guild:unknown');
    fireEvent.change(screen.getByRole('combobox', { name: 'Session' }), { target: { value: 'discord:guild:unknown' } });
    expect(onSessionChange).toHaveBeenCalledWith('discord:guild:unknown');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/mods', '/api/mods/burrow-switchboard/bootstrap']);
  });

  it('defaults A2A routing to the default session and persists only the routing preference', () => {
    const provider = { id: 'provider', provider: 'test', apiType: 'openai', url: '', apiKey: '', models: ['test-model'] };
    const updateAgent = vi.fn();
    const onSessionChange = vi.fn();

    const configuredAgent = { ...agent, contextConfig: { a2aInDefault: true, personality: 'stale', tools: ['stale-tool'], skills: ['stale-skill'] } };
    render(<ChatModelSelector selected={configuredAgent} savedProviders={[provider]} updateAgent={updateAgent} sessions={[{ id: 'default' }]} sessionId="default" onSessionChange={onSessionChange} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} locked />);

    const toggle = screen.getByRole('switch', { name: 'A2A in default' });
    expect(toggle).toHaveProperty('checked', true);
    expect(toggle).toHaveProperty('disabled', false);
    fireEvent.click(toggle);
    expect(updateAgent).toHaveBeenCalledWith({ contextConfig: { a2aInDefault: false } });
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('shows the dedicated A2A session before it has messages when A2A routing is separate', () => {
    const provider = { id: 'provider', provider: 'test', apiType: 'openai', url: '', apiKey: '', models: ['test-model'] };
    const separateAgent = { ...agent, contextConfig: { a2aInDefault: false } };

    render(<ChatModelSelector selected={separateAgent} savedProviders={[provider]} updateAgent={vi.fn()} sessions={[{ id: 'default' }]} sessionId="default" onSessionChange={vi.fn()} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);

    const picker = screen.getByRole('combobox', { name: 'Session' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => [option.value, option.text])).toEqual([['default', 'default'], ['a2a', 'A2A']]);
    expect(screen.getByRole('switch', { name: 'A2A in default' })).toHaveProperty('checked', false);
  });

  it('retains the selected synthetic inbox when routing is toggled back on before metadata arrives', () => {
    const props: Parameters<typeof ChatModelSelector>[0] = {
      selected: { ...agent, contextConfig: { a2aInDefault: false } }, savedProviders: [],
      updateAgent: vi.fn(), sessions: [{ id: 'default' }], sessionId: 'a2a',
      onSessionChange: vi.fn(), onNewSession: vi.fn(), onNewNamedSession: vi.fn(), onCreateGroup: vi.fn(),
    };
    const { rerender } = render(<ChatModelSelector {...props} />);
    const picker = screen.getByRole('combobox', { name: 'Session' }) as HTMLSelectElement;
    expect(picker.value).toBe('a2a');
    fireEvent.click(screen.getByRole('switch', { name: 'A2A in default' }));
    expect(props.updateAgent).toHaveBeenCalledWith({ contextConfig: { a2aInDefault: true } });
    rerender(<ChatModelSelector {...props} selected={{ ...agent, contextConfig: { a2aInDefault: true } }} />);
    expect(picker.value).toBe('a2a');
    expect(picker.selectedOptions[0].text).toBe('A2A');
    expect(props.onSessionChange).not.toHaveBeenCalled();
  });

  it('retains any current session while its metadata is unavailable', () => {
    render(<ChatModelSelector selected={agent} savedProviders={[]} updateAgent={vi.fn()} sessions={[{ id: 'default' }]} sessionId="pending-session" onSessionChange={vi.fn()} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Session' })).toHaveProperty('value', 'pending-session');
  });

  it.each([false, true])('uses only exact lowercase a2a as inbox identity (stored=%s)', (stored) => {
    const onSessionChange = vi.fn();
    render(<ChatModelSelector selected={{ ...agent, contextConfig: { a2aInDefault: false } }} savedProviders={[]} updateAgent={vi.fn()} sessions={[{ id: 'default' }, { id: 'A2A' }, { id: 'A2a' }, ...(stored ? [{ id: 'a2a' }] : [])]} sessionId="default" onSessionChange={onSessionChange} onNewSession={vi.fn()} onNewNamedSession={vi.fn()} onCreateGroup={vi.fn()} />);
    const picker = screen.getByRole('combobox', { name: 'Session' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map(option => [option.value, option.text])).toEqual([
      ['default', 'default'], ['A2A', 'A2A'], ['A2a', 'A2a'], ['a2a', 'A2A'],
    ]);
    for (const value of ['A2A', 'A2a', 'a2a']) {
      fireEvent.change(picker, { target: { value } });
      expect(onSessionChange).toHaveBeenLastCalledWith(value);
    }
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
  it('keeps the draft editable but blocks steering until the backend publishes readiness', () => {
    renderChat({ draft: 'Wait for durable steering', isSending: true, steeringReady: false, activeRunId: 'run' });
    const input = screen.getByRole('textbox', { name: 'Message' });
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Still editable' } });
    expect(input).toHaveProperty('value', 'Still editable');
  });

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
      leaveNewSessionForMessage: vi.fn(), appendTurn: vi.fn(), appendTransientTurn: vi.fn(), storeToolActivity: vi.fn(),
      toolActivityForRun: vi.fn(), clearRunState: vi.fn(), refreshSessions: vi.fn().mockResolvedValue(undefined),
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

it('audit: clears the mounted composer after successful same-session reset', () => {
  const { props, rerender } = renderChat({ draft: 'Text from before reset' });
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Text from before reset');
  // App.startNewSession clears parent draft after resetSession, which keeps sessionId.
  rerender(<Chat {...props} draft="" isNewSession={true} composerResetGeneration={1} turns={[]} />);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', '');
});

it('clears repeated same-session reset generations and never flushes old text afterward', () => {
 vi.useFakeTimers();
 const {props,rerender,setDraft,unmount} = renderChat({draft:'old',isNewSession:true,composerResetGeneration:1});
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'typed before second reset'}});
 rerender(<Chat {...props} draft="" composerResetGeneration={2} />);
 expect(screen.getByRole('textbox',{name:'Message'})).toHaveProperty('value','');
 vi.advanceTimersByTime(300); unmount();
 expect(setDraft).not.toHaveBeenCalledWith('typed before second reset');
});

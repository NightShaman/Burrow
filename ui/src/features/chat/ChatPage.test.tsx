import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { Chat } from './ChatPage';

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
  const onSend = vi.fn();
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
  return { ...render(<Chat {...props} />), setDraft, onSend };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

    expect(onSend).toHaveBeenCalledWith('Send this now');
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });
});

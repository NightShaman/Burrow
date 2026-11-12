import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ChatTranscript } from './ChatTranscript';
import { ChatMessage } from './ChatMessage';

const markdownRenders = vi.hoisted(() => vi.fn());
vi.mock('react-markdown', async (importOriginal) => {
  const { default: Original } = await importOriginal<typeof import('react-markdown')>();
  return {
    default: (props: ComponentProps<typeof Original>) => {
      markdownRenders(props.children);
      return <Original {...props} />;
    },
  };
});
afterEach(() => {
  cleanup();
  markdownRenders.mockClear();
});

it('does not reparse historical Markdown for live activity or fresh equivalent turn metadata, but displays changed content and terminal diagnostics', () => {
  const agent = { id: 'a', name: 'Agent', avatar: 'A' } as ComponentProps<
    typeof ChatTranscript
  >['parent'];
  const turns: ComponentProps<typeof ChatTranscript>['turns'] = [
    {
      id: 'history',
      type: 'message',
      role: 'assistant',
      runId: 'history',
      content: '**Historical answer**',
      metadata: { chatResultVersion: 2, terminalStatus: 'completed' },
    },
  ];
  const props = {
    selected: agent,
    parent: agent,
    operator: { name: 'King', avatar: 'K' },
    isNewSession: false,
    turns,
    isLoading: false,
    error: '',
    isSending: true,
    activeRunId: 'live',
    liveProgress: [],
    liveAnswer: 'Live answer',
  };
  const view = render(<ChatTranscript {...props} />);
  const historicalRenders = () =>
    markdownRenders.mock.calls.filter(([text]) => text === '**Historical answer**').length;
  expect(historicalRenders()).toBe(1);
  view.rerender(
    <ChatTranscript
      {...props}
      turns={structuredClone(turns)}
      liveAnswer="Updated live answer"
      runtimeChildActivities={[{ runId: 'child', status: 'running', items: [] }]}
    />,
  );
  expect(historicalRenders()).toBe(1);
  expect(screen.getByText('Updated live answer')).toBeTruthy();
  view.rerender(
    <ChatTranscript
      {...props}
      turns={[
        {
          ...turns[0],
          content: '**Changed historical answer**',
          metadata: {
            chatResultVersion: 2,
            terminalStatus: 'failed',
            modelFailure: {
              origin: 'upstream',
              code: 'test_failure',
              retryable: false,
              message: 'Synthetic provider failure',
            },
          },
        },
      ]}
    />,
  );
  expect(screen.getByText('Changed historical answer')).toBeTruthy();
  expect(screen.getByText('Synthetic provider failure')).toBeTruthy();
  expect(
    markdownRenders.mock.calls.filter(([text]) => text === '**Changed historical answer**'),
  ).toHaveLength(1);
});

it('keeps Markdown isolated from changed input actions, invokes the latest callback, and exposes metadata/attachment changes', () => {
  const oldAction = vi.fn(),
    nextAction = vi.fn();
  const props: ComponentProps<typeof ChatMessage> = {
    side: 'operator',
    name: 'King',
    avatar: 'K',
    time: 'Now',
    text: 'Queued **message**',
    chatInput: { id: 'one', intent: 'queue_next', status: 'queued' },
    input: { id: 'one', status: 'queued' } as ComponentProps<typeof ChatMessage>['input'],
    onInputAction: oldAction,
  };
  const view = render(<ChatMessage {...props} />);
  view.rerender(<ChatMessage {...props} onInputAction={nextAction} inputActionPending="one" />);
  expect((screen.getByText('Cancel input') as HTMLButtonElement).disabled).toBe(true);
  expect(markdownRenders).toHaveBeenCalledTimes(1);
  view.rerender(
    <ChatMessage
      {...props}
      onInputAction={nextAction}
      attachments={[{ name: 'late.txt', type: 'text/plain' }]}
    />,
  );
  fireEvent.click(screen.getByText('Cancel input'));
  expect(nextAction).toHaveBeenCalledWith('one', 'cancel');
  expect(oldAction).not.toHaveBeenCalled();
  expect(screen.getByText('late.txt')).toBeTruthy();
  expect(markdownRenders).toHaveBeenCalledTimes(1);
});

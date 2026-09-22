import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import type { SessionTurn } from '../../app/api';

const markdownRender = vi.hoisted(() => vi.fn());
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    markdownRender(children);
    return <div>{children}</div>;
  },
}));

import { Chat } from './ChatPage';

const agent: Agent = { id: 'smatchet', name: 'Smatchet', avatar: 'S', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [] };
const turns: SessionTurn[] = [{ type: 'message', role: 'assistant', content: 'Existing conversation', ts: '2026-01-01T00:00:00Z' }];

afterEach(() => { cleanup(); markdownRender.mockClear(); });

it('does not reparse an unchanged transcript on each local draft update, but updates for streamed content', () => {
  const props: Parameters<typeof Chat>[0] = {
    selected: agent, parent: agent, operator: { name: 'Rob', avatar: 'R' }, draft: '', setDraft: vi.fn(),
    attached: [], onAttach: vi.fn(), onRemoveAttachment: vi.fn(), isNewSession: false, turns,
    isLoading: false, error: '', isSending: false, activeRunId: '', liveProgress: [], liveAnswer: '',
    onSend: vi.fn(), onCancel: vi.fn(), selectedAgentId: agent.id, sessionId: 'default',
  };
  const { rerender } = render(<Chat {...props} />);
  expect(markdownRender).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'One' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'One two' } });
  expect(markdownRender).toHaveBeenCalledTimes(1);
  rerender(<Chat {...props} turns={[...turns, { type: 'message', role: 'assistant', content: 'New answer', ts: '2026-01-01T00:00:01Z' }]} />);
  expect(markdownRender).toHaveBeenCalledTimes(3);
});

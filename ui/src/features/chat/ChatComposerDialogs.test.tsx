import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { ChatComposerDialogs } from './ChatComposerDialogs';
afterEach(cleanup);
it('shows Menagerie avatar in group selection without changing checkbox behavior', () => {
  const avatar = 'data:image/webp;base64,cmVzaWRlbnQ=';
  const toggleAgent = vi.fn();
  const resident: Agent = {
    id: 'gerald',
    name: 'Gerald',
    avatar,
    enabled: true,
    activity: 'Idle',
    context: null,
    provider: '',
    model: '',
    effort: '',
    temperature: 1,
    workspace: '',
    files: [],
    subagents: [],
    modAgent: { ownerModId: 'burrow-menagerie', capabilities: {}, visibility: { agents: false } },
  };
  render(
    <ChatComposerDialogs
      agents={[resident, { ...resident, id: 'kerning', name: 'Kerning', avatar: 'K' }]}
      session={{
        isOpen: false,
        isCreating: false,
        name: '',
        error: '',
        close: vi.fn(),
        setName: vi.fn(),
        create: async () => {},
      }}
      group={{
        isOpen: true,
        isCreating: false,
        name: '',
        setName: vi.fn(),
        agentIds: [],
        error: '',
        close: vi.fn(),
        toggleAgent,
        create: async () => {},
        rooms: [],
        roomsLoading: false,
        roomsError: '',
        openExisting: vi.fn(),
      }}
    />,
  );
  const checkbox = screen.getByRole('checkbox', { name: 'Gerald' });
  expect(checkbox.closest('label')?.querySelector('img')?.getAttribute('src')).toBe(avatar);
  fireEvent.click(checkbox);
  expect(toggleAgent).toHaveBeenCalledWith('gerald');
  expect(document.querySelectorAll('.group-participant img')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'Kerning' })).toBeTruthy();
});

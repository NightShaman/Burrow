import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import type { AgentRailPreferences } from '../../app/useAgentRailPreferences';
import { AgentSidebarSettings } from './AgentSidebarSettings';

const agents: Agent[] = [
  {
    id: 'smatchet',
    name: 'Smatchet',
    avatar: 'S',
    activity: 'Idle',
    context: 12,
    provider: '',
    model: '',
    effort: '',
    temperature: 0.7,
    workspace: '',
    files: [],
    subagents: [],
  },
  {
    id: 'hatchet',
    name: 'Hatchet',
    avatar: 'H',
    activity: 'Working',
    context: 20,
    provider: '',
    model: '',
    effort: '',
    temperature: 0.7,
    workspace: '',
    files: [],
    subagents: [],
  },
];

afterEach(cleanup);

describe('AgentSidebarSettings', () => {
  it('selects compact view from a Settings dropdown', () => {
    const Harness = () => {
      const [preferences, setPreferences] = useState<{
        view: 'regular' | 'compact';
        order: string[];
      }>({ view: 'regular', order: ['smatchet', 'hatchet'] });
      return (
        <>
          <AgentSidebarSettings
            agents={agents}
            preferences={preferences}
            setPreferences={setPreferences}
          />
          <output>{preferences.view}</output>
        </>
      );
    };
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'compact' } });
    expect(screen.getByText('compact', { selector: 'output' })).toBeTruthy();
  });

  it('reorders agents with the Account Status drag interaction', () => {
    let current = { view: 'regular' as const, order: ['smatchet', 'hatchet'] };
    const setPreferences = vi.fn((update) => {
      current = typeof update === 'function' ? update(current) : update;
    });
    render(
      <AgentSidebarSettings
        agents={agents}
        preferences={current}
        setPreferences={setPreferences}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    const source = screen.getByText('Hatchet').closest('[draggable="true"]') as HTMLElement;
    const target = screen.getByText('Smatchet').closest('[draggable="true"]') as HTMLElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(current.order).toEqual(['hatchet', 'smatchet']);
  });
});

it('moves visible agents by keyboard with focus, live feedback, and hidden IDs preserved', () => {
  const Harness = () => {
    const [preferences, setPreferences] = useState<AgentRailPreferences>({
      view: 'regular',
      order: ['hidden', 'smatchet', 'hatchet'],
    });
    return (
      <>
        <AgentSidebarSettings
          agents={agents}
          preferences={preferences}
          setPreferences={setPreferences}
        />
        <output data-testid="order">{preferences.order.join(',')}</output>
      </>
    );
  };
  render(<Harness />);
  const hatchet = screen.getByRole('listitem', { name: /Hatchet.*move/i });
  hatchet.focus();
  fireEvent.keyDown(hatchet, { key: 'ArrowUp', altKey: true });
  expect(screen.getByTestId('order').textContent).toBe('hidden,hatchet,smatchet');
  expect(document.activeElement).toBe(hatchet);
  expect(screen.getByRole('status', { name: 'Agent order update' }).textContent).toMatch(
    /Hatchet.*position 1 of 2/i,
  );
  fireEvent.keyDown(hatchet, { key: 'ArrowUp', altKey: true });
  expect(screen.getByTestId('order').textContent).toBe('hidden,hatchet,smatchet');
  fireEvent.keyDown(hatchet, { key: 'ArrowDown', altKey: true });
  expect(screen.getByTestId('order').textContent).toBe('hidden,smatchet,hatchet');
});

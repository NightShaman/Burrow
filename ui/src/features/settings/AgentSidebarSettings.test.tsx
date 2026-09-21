import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { AgentSidebarSettings } from './AgentSidebarSettings';

const agents: Agent[] = [
  { id: 'smatchet', name: 'Smatchet', avatar: 'S', activity: 'Idle', context: 12, provider: '', model: '', effort: '', temperature: 0.7, workspace: '', files: [], subagents: [] },
  { id: 'hatchet', name: 'Hatchet', avatar: 'H', activity: 'Working', context: 20, provider: '', model: '', effort: '', temperature: 0.7, workspace: '', files: [], subagents: [] },
];

afterEach(cleanup);

describe('AgentSidebarSettings', () => {
  it('selects compact view from a Settings dropdown', () => {
    const Harness = () => {
      const [preferences, setPreferences] = useState<{ view: 'regular' | 'compact'; order: string[] }>({ view: 'regular', order: ['smatchet', 'hatchet'] });
      return <><AgentSidebarSettings agents={agents} preferences={preferences} setPreferences={setPreferences} /><output>{preferences.view}</output></>;
    };
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'compact' } });
    expect(screen.getByText('compact', { selector: 'output' })).toBeTruthy();
  });

  it('reorders agents with the Account Status drag interaction', () => {
    let current = { view: 'regular' as const, order: ['smatchet', 'hatchet'] };
    const setPreferences = vi.fn((update) => { current = typeof update === 'function' ? update(current) : update; });
    render(<AgentSidebarSettings agents={agents} preferences={current} setPreferences={setPreferences} />);
    const source = screen.getByText('Hatchet').closest('[draggable="true"]') as HTMLElement;
    const target = screen.getByText('Smatchet').closest('[draggable="true"]') as HTMLElement;
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(current.order).toEqual(['hatchet', 'smatchet']);
  });
});

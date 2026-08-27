import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { AgentsPanel } from './WorkspaceRail';

const agent: Agent = {
  id: 'smatchet',
  name: 'Smatchet',
  avatar: 'S',
  activity: 'Idle',
  context: 12,
  provider: 'openai',
  model: 'gpt-test',
  effort: 'medium',
  temperature: 0.7,
  workspace: '/workspace',
  files: [],
  subagents: [{ id: 'child', name: 'Child', avatar: 'C', activity: 'Working', context: 3, stream: 'child' }],
};

afterEach(cleanup);

describe('AgentsPanel', () => {
  it('exposes agent selection and expansion as separate accessible controls', () => {
    const onSelectAgent = vi.fn();
    const onToggleAgent = vi.fn();
    render(<AgentsPanel agents={[agent]} selectedStreamId="smatchet" expandedAgents={new Set()} onSelectAgent={onSelectAgent} onToggleAgent={onToggleAgent} onSelectSubagent={vi.fn()} />);

    const select = screen.getByRole('button', { name: 'Select Smatchet' });
    const expand = screen.getByRole('button', { name: 'Expand Smatchet' });
    expect(select.getAttribute('aria-pressed')).toBe('true');
    expect(expand.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(select);
    expect(onSelectAgent).toHaveBeenCalledWith(agent);
    expect(onToggleAgent).not.toHaveBeenCalled();

    fireEvent.click(expand);
    expect(onToggleAgent).toHaveBeenCalledWith('smatchet');
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
  });

  it('renders expanded subagents as selectable buttons', () => {
    const onSelectSubagent = vi.fn();
    render(<AgentsPanel agents={[agent]} selectedStreamId="child" expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={onSelectSubagent} />);

    const child = screen.getByRole('button', { name: 'Select Child' });
    expect(child.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(child);
    expect(onSelectSubagent).toHaveBeenCalledWith('smatchet', 'child');
  });
});

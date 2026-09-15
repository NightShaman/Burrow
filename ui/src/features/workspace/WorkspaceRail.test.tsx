import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { AgentsPanel, WorkspaceRail } from './WorkspaceRail';
import { RightRail } from '../panels/RightRail';

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


describe('configurable rails', () => {
  const renderPanel = (panel: string) => <div>{panel} panel</div>;
  const railProps = { collapsed: false, topPanel: 'agents' as const, bottomPanel: 'workspace' as const, renderPanel, onExpand: vi.fn(), onCollapse: vi.fn(), onResizeSplit: vi.fn() };

  it('renders the selected top panel across the full left rail without a divider', () => {
    render(<WorkspaceRail {...railProps} layout="top" />);
    expect(screen.getByText('agents panel')).toBeTruthy();
    expect(screen.queryByText('workspace panel')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resize left rail panels' })).toBeNull();
  });

  it('renders the selected bottom panel across the full right rail without a divider', () => {
    render(<RightRail {...railProps} layout="bottom" />);
    expect(screen.getByText('workspace panel')).toBeTruthy();
    expect(screen.queryByText('agents panel')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resize right rail panels' })).toBeNull();
  });

  it('renders the independent single panel on either rail', () => {
    for (const Rail of [WorkspaceRail, RightRail]) {
      const view = render(<Rail {...railProps} layout="single" singlePanel="system" />);
      expect(screen.getByText('system panel')).toBeTruthy();
      expect(screen.queryByText('agents panel')).toBeNull();
      expect(screen.queryByText('workspace panel')).toBeNull();
      expect(view.container.querySelector('.resize-divider')).toBeNull();
      view.unmount();
    }
  });

  it('keeps both panels and the divider in divided mode', () => {
    render(<WorkspaceRail {...railProps} layout="divided" />);
    expect(screen.getByText('agents panel')).toBeTruthy();
    expect(screen.getByText('workspace panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resize left rail panels' })).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { childStreamId } from '../../app/useRuntimeSelection';
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

afterEach(() => { cleanup(); window.localStorage.clear(); });

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
    render(<AgentsPanel agents={[agent]} selectedStreamId={childStreamId('smatchet', 'child')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={onSelectSubagent} />);

    const child = screen.getByRole('button', { name: 'Select Child' });
    expect(child.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(child);
    expect(onSelectSubagent).toHaveBeenCalledWith('smatchet', 'child');
  });

  it.each(['regular', 'compact'] as const)('nests descendants in %s view and selects them through the root agent', view => {
    const onSelectSubagent = vi.fn();
    const grandchild = { ...agent.subagents[0], id: 'grandchild', stream: 'grandchild', name: 'Grandchild', parentSessionId: 'child', depth: 2, maxDepth: 3 };
    const orphan = { ...agent.subagents[0], id: 'orphan', name: 'Orphan', parentSessionId: 'missing', depth: 2 };
    render(<AgentsPanel agents={[{ ...agent, subagents: [grandchild, agent.subagents[0], orphan] }]} view={view} selectedStreamId={childStreamId('smatchet', 'grandchild')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={onSelectSubagent} />);
    const child = screen.getByRole('button', { name: 'Select Child' });
    const grand = screen.getByRole('button', { name: 'Select Grandchild' });
    expect(child.closest('li')?.querySelector('ul')?.contains(grand)).toBe(true);
    expect(grand.getAttribute('aria-pressed')).toBe('true');
    expect(child.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(grand);
    expect(onSelectSubagent).toHaveBeenCalledWith('smatchet', 'grandchild');
    expect(screen.getByRole('button', { name: 'Select Orphan' }).closest('ul')?.getAttribute('aria-label')).toBe('Minions');
  });

  describe.each(['regular', 'compact'] as const)('%s origin grouping', view => {
    it.each(['session', 'run'] as const)('does not create cross-root edges from parent %s ids', parentKind => {
      const parentLink = parentKind === 'session'
        ? { parentSessionId: 'parent-session' }
        : { parentRunId: 'parent-run' };
      const parent = { ...agent.subagents[0], id: 'parent', stream: 'parent', name: 'Parent', resourceId: 'parent-session', runId: 'parent-run', rootSessionId: 'root-a' };
      const nested = { ...agent.subagents[0], id: 'nested', stream: 'nested', name: 'Nested', rootSessionId: 'root-a', ...parentLink };
      const conflict = { ...agent.subagents[0], id: 'conflict', stream: 'conflict', name: 'Conflict', rootSessionId: 'root-b', ...parentLink };
      const onSelectSubagent = vi.fn();
      render(<AgentsPanel agents={[{ ...agent, subagents: [nested, conflict, parent] }]} view={view} selectedStreamId={childStreamId('smatchet', 'conflict')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={onSelectSubagent} />);

      const rootA = screen.getByText('Session: root-a').parentElement!;
      const rootB = screen.getByText('Session: root-b').parentElement!;
      const parentButton = within(rootA).getByRole('button', { name: 'Select Parent' });
      const nestedButton = within(rootA).getByRole('button', { name: 'Select Nested' });
      const conflictButton = within(rootB).getByRole('button', { name: 'Select Conflict' });
      expect(parentButton.closest('li')?.querySelector('ul')?.contains(nestedButton)).toBe(true);
      expect(within(rootA).queryByRole('button', { name: 'Select Conflict' })).toBeNull();
      expect(conflictButton.closest('ul')?.getAttribute('aria-label')).toBe('Minions');
      expect(screen.getAllByRole('button', { name: 'Select Conflict' })).toHaveLength(1);
      expect(conflictButton.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(conflictButton);
      expect(onSelectSubagent).toHaveBeenCalledWith('smatchet', 'conflict');
    });

    it.each(['session', 'run'] as const)('keeps unknown origins separate in both directions despite parent %s ids', parentKind => {
      const knownLink = parentKind === 'session'
        ? { parentSessionId: 'known-session' }
        : { parentRunId: 'known-run' };
      const unknownLink = parentKind === 'session'
        ? { parentSessionId: 'unknown-session' }
        : { parentRunId: 'unknown-run' };
      const known = { ...agent.subagents[0], id: 'known', stream: 'known', name: 'Known', resourceId: 'known-session', runId: 'known-run', rootSessionId: 'known-root', ...unknownLink };
      const unknown = { ...agent.subagents[0], id: 'unknown', stream: 'unknown', name: 'Unknown', resourceId: 'unknown-session', runId: 'unknown-run', ...knownLink };
      const nested = { ...agent.subagents[0], id: 'unknown-nested', stream: 'unknown-nested', name: 'Unknown nested', ...unknownLink };
      render(<AgentsPanel agents={[{ ...agent, subagents: [nested, known, unknown] }]} view={view} selectedStreamId={childStreamId('smatchet', 'unknown-nested')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);

      const knownGroup = screen.getByText('Session: known-root').parentElement!;
      const unknownGroup = screen.getByText('Unknown origin').parentElement!;
      const knownButton = within(knownGroup).getByRole('button', { name: 'Select Known' });
      const unknownButton = within(unknownGroup).getByRole('button', { name: 'Select Unknown' });
      const nestedButton = within(unknownGroup).getByRole('button', { name: 'Select Unknown nested' });
      expect(knownButton.closest('ul')?.getAttribute('aria-label')).toBe('Minions');
      expect(unknownButton.closest('ul')?.getAttribute('aria-label')).toBe('Minions');
      expect(unknownButton.closest('li')?.querySelector('ul')?.contains(nestedButton)).toBe(true);
      expect(within(knownGroup).queryByRole('button', { name: 'Select Unknown' })).toBeNull();
      expect(within(unknownGroup).queryByRole('button', { name: 'Select Known' })).toBeNull();
      expect(screen.getAllByText('Unknown origin')).toHaveLength(1);
      expect(nestedButton.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it.each(['Error', 'Incomplete'])('keeps %s rail status free of diagnostic text', (activity) => {
    const child = { ...agent.subagents[0], activity, outcomeReason: 'Recorded diagnostic reason' };
    render(<AgentsPanel agents={[{ ...agent, subagents: [child] }]} selectedStreamId={childStreamId('smatchet', 'child')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);
    const status = screen.getByRole('button', { name: 'Select Child' }).querySelector('small');
    expect(status?.textContent).toBe(activity);
    expect(status?.getAttribute('title')).toBeNull();
    expect(screen.queryByText(/Recorded diagnostic reason/)).toBeNull();
  });

  it('renders compact view without sidebar configuration controls', () => {
    const view = render(<AgentsPanel agents={[agent]} view="compact" order={[]} selectedStreamId="smatchet" expandedAgents={new Set()} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);
    expect(view.container.querySelector('.context-usage')).toBeNull();
    expect(screen.getByText('Smatchet')).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Smatchet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Arrange' })).toBeNull();
  });

  it('renders the Settings-defined agent order', () => {
    const hatchet = { ...agent, id: 'hatchet', name: 'Hatchet' };
    const fringe = { ...agent, id: 'fringe', name: 'Fringe' };
    const view = render(<AgentsPanel agents={[agent, hatchet, fringe]} order={['hatchet', 'smatchet']} selectedStreamId="smatchet" expandedAgents={new Set()} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);
    expect([...view.container.querySelectorAll('.agent-name b')].map((node) => node.textContent)).toEqual(['Hatchet', 'Smatchet', 'Fringe']);
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
    expect(screen.getByRole('separator', { name: 'Resize left rail panels' })).toBeTruthy();
  });
});

it('groups known roots separately from unknown origins and labels scoped compatibility honestly', () => {
  const child = agent.subagents[0];
  const named = { ...child, id: 'named-child', name: 'Named child', rootSessionId: 'named' };
  const nested = { ...child, id: 'nested', name: 'Nested', rootSessionId: 'named', parentSessionId: 'named-child' };
  const conflict = { ...child, id: 'conflict', name: 'Other root', rootSessionId: 'other', parentSessionId: 'named-child' };
  render(<AgentsPanel agents={[{ ...agent, minionScope: 'session', subagents: [named, nested, conflict, child] }]} selectedStreamId={childStreamId('smatchet', 'nested')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);
  expect(screen.getByText('Minions for the requested session only')).toBeTruthy();
  expect(screen.getByText('Session: named')).toBeTruthy();
  expect(screen.getByText('Session: other')).toBeTruthy();
  expect(screen.getByText('Unknown origin')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Select Named child' }).closest('li')?.querySelector('ul')?.contains(screen.getByRole('button', { name: 'Select Nested' }))).toBe(true);
  expect(screen.getByRole('button', { name: 'Select Other root' }).closest('ul')?.getAttribute('aria-label')).toBe('Minions');
});

it.each([
  ['stale', 'Minion status unavailable · showing last seen'],
  ['unavailable', 'Minion status unavailable'],
] as const)('labels %s minion evidence without claiming a successful scoped scan', (minionCoverage, notice) => {
  render(<AgentsPanel agents={[{ ...agent, minionScope: 'session', minionCoverage, subagents: minionCoverage === 'stale' ? [{ ...agent.subagents[0], retained: true }] : [] }]} selectedStreamId={childStreamId('smatchet', 'child')} expandedAgents={new Set(['smatchet'])} onSelectAgent={vi.fn()} onToggleAgent={vi.fn()} onSelectSubagent={vi.fn()} />);
  expect(screen.getByText(notice)).toBeTruthy();
  expect(screen.queryByText('Minions for the requested session only')).toBeNull();
  if (minionCoverage === 'stale') expect(screen.getByText('Last seen · Working')).toBeTruthy();
});

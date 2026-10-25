import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import css from './settings.css?raw';
import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { AgentToolbar } from './AgentToolbar';

afterEach(cleanup);
const agent = (id: string, enabled?: boolean, activity = 'Idle') => ({ id, name: id, enabled, activity } as Agent);
const agents = [agent('Enabled', true), agent('Disabled', false), agent('Legacy disabled', undefined, 'Disabled'), agent('Explicitly enabled', true, 'Disabled')];

it('marks only disabled names red using the semantic danger token, including the legacy fallback', () => {
  render(<AgentToolbar agents={agents} selectedId="Disabled" onSelect={vi.fn()} onAgentsChanged={async () => {}} onModelConnectionsChanged={async () => {}} />);
  for (const name of ['Disabled', 'Legacy disabled']) expect(screen.getByRole('button', { name }).classList.contains('agent-disabled')).toBe(true);
  for (const name of ['Enabled', 'Explicitly enabled']) expect(screen.getByRole('button', { name }).classList.contains('agent-disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Disabled' }).getAttribute('aria-pressed')).toBe('true');
  expect(css).toContain('.agent-toolbar-selector button.agent-disabled{color:var(--danger)}');
});

it('keeps disabled management entries selectable and updates styling when enabled state changes', () => {
  const onSelect = vi.fn();
  const props = { agents, selectedId: 'Enabled', onSelect, onAgentsChanged: async () => {}, onModelConnectionsChanged: async () => {} };
  const view = render(<AgentToolbar {...props} />);
  const disabled = screen.getByRole('button', { name: 'Disabled' }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(false);
  fireEvent.click(disabled);
  expect(onSelect).toHaveBeenCalledWith('Disabled');
  view.rerender(<AgentToolbar {...props} agents={agents.map(item => ({ ...item, enabled: true }))} selectedId="Disabled" />);
  expect(screen.getByRole('button', { name: 'Disabled' }).classList.contains('agent-disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Disabled' }).getAttribute('aria-pressed')).toBe('true');
});

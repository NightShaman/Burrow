import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Agent } from '../../app/types';
import { UnsavedChangesProvider, useUnsavedChanges } from '../../app/UnsavedChanges';
import { AgentToolbar } from './AgentToolbar';

afterEach(cleanup);
const agents = Array.from(
  { length: 17 },
  (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, enabled: i !== 16 }) as Agent,
);
it('lists all 17 agents, preserves disabled management entries, and guards selection', () => {
  const onSelect = vi.fn();
  function Subject() {
    const [selectedId, setSelectedId] = useState('agent-0');
    const [dirty, setDirty] = useState(true);
    useUnsavedChanges({
      dirty,
      busy: false,
      save: async () => true,
      discard: () => setDirty(false),
    });
    return (
      <AgentToolbar
        agents={agents}
        selectedId={selectedId}
        onSelect={(id) => {
          onSelect(id);
          setSelectedId(id);
        }}
        onSelectGlobal={vi.fn()}
        onAgentsChanged={async () => {}}
        onModelConnectionsChanged={async () => {}}
      />
    );
  }
  render(
    <UnsavedChangesProvider>
      <Subject />
    </UnsavedChangesProvider>,
  );
  const picker = screen.getByRole('combobox', { name: 'Agent to configure' }) as HTMLSelectElement;
  expect(screen.getAllByRole('option')).toHaveLength(17);
  expect(
    (screen.getByRole('option', { name: 'Agent 16 (disabled)' }) as HTMLOptionElement).disabled,
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Global' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New Agent' })).toBeTruthy();
  fireEvent.change(picker, { target: { value: 'agent-16' } });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(picker.value).toBe('agent-0');
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.change(picker, { target: { value: 'agent-16' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(onSelect).toHaveBeenCalledWith('agent-16');
  expect(picker.value).toBe('agent-16');
});

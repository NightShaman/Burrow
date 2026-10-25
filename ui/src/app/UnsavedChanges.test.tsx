import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider, useUnsavedChanges, useUnsavedNavigation } from './UnsavedChanges';
afterEach(cleanup);
function Scope({ label, save }: { label: string; save: () => Promise<boolean> }) {
  const [value, setValue] = useState('');
  useUnsavedChanges({ dirty: value !== '', busy: false, save: async () => { const ok = await save(); if (ok) setValue(''); return ok; }, discard: () => setValue('') });
  return <input aria-label={label} value={value} onChange={event => setValue(event.target.value)} />;
}
function Leave({ done }: { done: () => void }) { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(done)}>Leave</button>; }
it('does not let a clean nested registration hide another dirty form; discards both scopes', () => {
  const done = vi.fn(); const save = vi.fn(async () => true);
  render(<UnsavedChangesProvider><Scope label="Profile" save={save} /><Scope label="Timezone" save={save} /><Leave done={done} /></UnsavedChangesProvider>);
  fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByText('Leave')); expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByText('Stay')); expect(done).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'other' } });
  fireEvent.click(screen.getByText('Leave')); fireEvent.click(screen.getByText('Discard'));
  expect(done).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Profile')).toHaveProperty('value', ''); expect(screen.getByLabelText('Timezone')).toHaveProperty('value', '');
});
it('stops navigation on one failed scope and retries only the remaining dirty scope', async () => {
  const done = vi.fn(); const first = vi.fn(async () => true); const second = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  render(<UnsavedChangesProvider><Scope label="Profile" save={first} /><Scope label="Timezone" save={second} /><Leave done={done} /></UnsavedChangesProvider>);
  for (const label of ['Profile', 'Timezone']) fireEvent.change(screen.getByLabelText(label), { target: { value: 'draft' } });
  fireEvent.click(screen.getByText('Leave')); fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); expect(done).not.toHaveBeenCalled(); expect(first).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Leave')); fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(done).toHaveBeenCalledOnce()); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
});

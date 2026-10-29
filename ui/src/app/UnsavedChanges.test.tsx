import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider, useUnsavedChanges, useUnsavedNavigation } from './UnsavedChanges';
afterEach(cleanup);
function Scope({ label, save }: { label: string; save: () => Promise<boolean> }) {
  const [value, setValue] = useState('');
  useUnsavedChanges({ dirty: value !== '', busy: false, save: async () => { const ok = await save(); if (ok) setValue(''); return ok; }, discard: () => setValue('') });
  return <input aria-label={label} value={value} onChange={event => setValue(event.target.value)} />;
}
function Leave({ done }: { done: () => void }) { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(done)}>Leave</button>; }
function DeferredScope({ resumeAfterAutosave, start, discard = vi.fn() }: { resumeAfterAutosave?: boolean; start: () => Promise<boolean>; discard?: () => void }) {
  const [state, setState] = useState<'dirty' | 'busy' | 'clean'>('dirty');
  const save = async () => { setState('busy'); const ok = await start(); setState(ok ? 'clean' : 'dirty'); return ok; };
  useUnsavedChanges({ dirty: state !== 'clean', busy: state === 'busy', resumeAfterAutosave, save, discard });
  return <button onClick={() => void save()}>Start autosave</button>;
}
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

it.each([[undefined, false], [false, false], [true, true]] as const)('resumes navigation queued behind autosave only with explicit opt-in %s', async (resumeAfterAutosave, resumes) => {
  let resolve!: (value: boolean) => void;
  const done = vi.fn();
  render(<UnsavedChangesProvider><DeferredScope resumeAfterAutosave={resumeAfterAutosave} start={() => new Promise(finish => { resolve = finish; })} /><Leave done={done} /></UnsavedChangesProvider>);
  fireEvent.click(screen.getByText('Start autosave'));
  fireEvent.click(screen.getByText('Leave'));
  expect(done).not.toHaveBeenCalled();
  await act(async () => resolve(true));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(resumes ? 1 : 0));
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('locks modal actions when a registered mutation becomes busy before Discard', async () => {
  let resolve!: (value: boolean) => void;
  const done = vi.fn(); const discard = vi.fn();
  render(<UnsavedChangesProvider><DeferredScope start={() => new Promise(finish => { resolve = finish; })} discard={discard} /><Leave done={done} /></UnsavedChangesProvider>);
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByText('Start autosave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(discard).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  await act(async () => resolve(false));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', false));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

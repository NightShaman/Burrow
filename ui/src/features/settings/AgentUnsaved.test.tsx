import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { DefaultMinionModel } from './DefaultMinionModel';
import { AgentToolbar } from './AgentToolbar';
import type { Agent } from '../../app/types';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
function Leave({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave</button>;
}
const providers = [{ id: 'provider', provider: 'Test', apiType: '', url: '', apiKey: '', models: ['model'] }];
const loaded = { connectionId: 'provider', model: 'model', reasoningEffort: 'off', temperature: 0.2 };
const temperature = () => screen.getByLabelText('Minion temperature') as HTMLInputElement;

it('guards an in-progress temperature draft; Stay retains and Discard restores without writing', async () => {
  vi.mocked(api).mockResolvedValue({ ok: true, selection: loaded });
  const leave = vi.fn();
  render(<UnsavedChangesProvider><DefaultMinionModel resourceId="agent" savedProviders={providers} /><Leave onLeave={leave} /></UnsavedChangesProvider>);
  await waitFor(() => expect(temperature().disabled).toBe(false));
  fireEvent.pointerDown(temperature(), { pointerId: 1 });
  fireEvent.change(temperature(), { target: { value: '1.1' } });
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByText('Stay'));
  expect(leave).not.toHaveBeenCalled();
  expect(temperature().value).toBe('1.1');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(leave).toHaveBeenCalledTimes(1);
  expect(temperature().value).toBe('0.2');
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});

it('failed autosave stays guarded; failed guard retry retains the draft and cancels navigation', async () => {
  vi.mocked(api).mockImplementation(async (_path, init) => { if (init?.method === 'PUT') throw new Error('denied'); return { ok: true, selection: loaded }; });
  const leave = vi.fn();
  render(<UnsavedChangesProvider><DefaultMinionModel resourceId="agent" savedProviders={providers} /><Leave onLeave={leave} /></UnsavedChangesProvider>);
  await waitFor(() => expect(temperature().disabled).toBe(false));
  fireEvent.pointerDown(temperature(), { pointerId: 1 });
  fireEvent.change(temperature(), { target: { value: '1.1' } });
  fireEvent.pointerUp(temperature(), { pointerId: 1 });
  await screen.findByText(/Could not save default minion model: denied/);
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2));
  expect(leave).not.toHaveBeenCalled();
  expect(temperature().value).toBe('1.1');
  expect(screen.getByText(/Could not save default minion model: denied/)).toBeTruthy();
});

it('toolbar sends a changed agent through the shared navigation boundary', () => {
  const agent = (id: string): Agent => ({ id, name: id, avatar: '', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0, workspace: '', files: [], subagents: [] });
  const select = vi.fn();
  render(<UnsavedChangesProvider><AgentToolbar agents={[agent('a'), agent('b')]} selectedId="a" onSelect={select} onAgentsChanged={vi.fn()} onModelConnectionsChanged={vi.fn()} /></UnsavedChangesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  expect(select).toHaveBeenCalledWith('b');
});

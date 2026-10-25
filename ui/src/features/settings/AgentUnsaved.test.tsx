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
it('guards an edited minion model; Stay retains and Discard restores without writing', async () => {
  vi.mocked(api).mockResolvedValue({ selection: null });
  const leave = vi.fn();
  render(<UnsavedChangesProvider><DefaultMinionModel resourceId="agent" savedProviders={providers} /><Leave onLeave={leave} /></UnsavedChangesProvider>);
  await waitFor(() => expect((screen.getByLabelText('Default minion provider') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Default minion provider'), { target: { value: 'provider' } });
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByText('Stay'));
  expect(leave).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Default minion provider') as HTMLSelectElement).value).toBe('provider');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(leave).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Default minion provider') as HTMLSelectElement).value).toBe('');
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});
it('failed guarded Save retains the model and cancels the requested navigation', async () => {
  vi.mocked(api).mockImplementation(async (_path, init) => { if (init?.method === 'PUT') throw new Error('denied'); return { selection: null }; });
  const leave = vi.fn();
  render(<UnsavedChangesProvider><DefaultMinionModel resourceId="agent" savedProviders={providers} /><Leave onLeave={leave} /></UnsavedChangesProvider>);
  await waitFor(() => expect((screen.getByLabelText('Default minion provider') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Default minion provider'), { target: { value: 'provider' } });
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Save', { selector: 'button' }));
  await screen.findByText(/Could not save default minion model: denied/);
  expect(leave).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Default minion provider') as HTMLSelectElement).value).toBe('provider');
});
it('toolbar sends a changed agent through the shared navigation boundary', () => {
  const agent = (id: string): Agent => ({ id, name: id, avatar: '', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0, workspace: '', files: [], subagents: [] });
  const select = vi.fn();
  render(<UnsavedChangesProvider><AgentToolbar agents={[agent('a'), agent('b')]} selectedId="a" onSelect={select} onAgentsChanged={vi.fn()} onModelConnectionsChanged={vi.fn()} /></UnsavedChangesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  expect(select).toHaveBeenCalledWith('b');
});

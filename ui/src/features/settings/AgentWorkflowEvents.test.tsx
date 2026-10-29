import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { AgentWorkflowEvents, type WorkflowWatch } from './AgentWorkflowEvents';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
const mock = vi.mocked(api);
const watch: WorkflowWatch = { id: 'watch-1', repository: 'kingdom/burrow', workflow: 'Assembly', agentId: 'hatchet', sessionId: 'ci-releases', instruction: 'Inspect the result', enabled: true };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mock.mockImplementation(async (path, init) => {
    if (path === '/api/events/settings') return { ok: true, settings: { deliveryUrl: '', webhookPath: '/api/events/github', secretConfigured: false, storedSecretConfigured: false, secretSource: 'none', environmentOverride: false, ready: false, readiness: 'secret_missing' } } as never;
    if (init?.method === 'DELETE') return { ok: true } as never;
    if (init?.method === 'POST') return { ok: true, watch: { ...JSON.parse(String(init.body)), id: 'watch-1' } } as never;
    if (path === '/api/events/watches') return { ok: true, watches: [watch, { ...watch, id: 'other', agentId: 'smatchet', workflow: 'Other agent watch' }] } as never;
    throw new Error(`Unexpected request: ${path}`);
  });
});
function show(agentId = 'hatchet') { return render(<ConfirmProvider><AgentWorkflowEvents agentId={agentId} /></ConfirmProvider>); }
it('scopes watches to the selected agent without fetching or polling recent events', async () => {
  const overflow = document.createElement('section');
  document.body.append(overflow);
  vi.useFakeTimers();
  const view = render(<ConfirmProvider><AgentWorkflowEvents agentId="hatchet" overflowTarget={overflow} /></ConfirmProvider>);
  try {
    await act(async () => {});
    const savedWatch = screen.getByRole('button', { name: /Assembly.*Enabled/ });
    expect(overflow.contains(savedWatch)).toBe(true);
    expect(screen.queryByText('Other agent watch')).toBeNull();
    expect(screen.queryByText('Recent events')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh events' })).toBeNull();
    expect(screen.getByLabelText('Repository')).toBeTruthy();
    expect(screen.getByText('GitHub webhook setup')).toBeTruthy();
    const paths = () => mock.mock.calls.map(([path]) => path);
    expect(paths().sort()).toEqual(['/api/events/settings', '/api/events/watches']);
    await act(async () => { vi.advanceTimersByTime(45000); });
    expect(paths().sort()).toEqual(['/api/events/settings', '/api/events/watches']);
  } finally { view.unmount(); overflow.remove(); vi.useRealTimers(); }
});
it('validates then creates an explicit instruction and destination, disabled by default', async () => {
  show(); await screen.findByRole('button', { name: /Assembly.*Enabled/ });
  fireEvent.click(screen.getByRole('button', { name: 'Add watch' })); expect(screen.getByRole('alert').textContent).toContain('Enter owner/repo');
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'kingdom/ui' } });
  fireEvent.change(screen.getByLabelText(/Workflow name/), { target: { value: 'CI exact name' } });
  fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Report failures' } });
  fireEvent.change(screen.getByLabelText('Destination session'), { target: { value: 'release-review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add watch' }));
  await screen.findByText('Watch saved.');
  const call = mock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ repository: 'kingdom/ui', workflow: 'CI exact name', agentId: 'hatchet', sessionId: 'release-review', instruction: 'Report failures', enabled: false });
});
it('edits and disables via upsert, deletes only after confirmation', async () => {
  show(); fireEvent.click(await screen.findByRole('button', { name: /Assembly.*Enabled/ }));
  expect((screen.getByLabelText('Instruction') as HTMLTextAreaElement).value).toBe('Inspect the result');
  fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Updated instruction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save watch' })); await screen.findByText('Watch saved.');
  expect(JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toMatchObject({ id: 'watch-1', instruction: 'Updated instruction' });
  fireEvent.click(screen.getByRole('button', { name: 'Disable' })); await screen.findByText('Watch disabled.');
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete watch' }));
  await screen.findByText('Watch deleted.');
  expect(mock.mock.calls.some(([path, init]) => path === '/api/events/watches/watch-1' && init?.method === 'DELETE')).toBe(true);
});
it('does not confuse read failure with empty state and supports retry', async () => {
  mock.mockRejectedValue(new Error('Backend unavailable')); show();
  await screen.findByText(/Could not load watches/);
  expect(screen.queryByText('No watches for this agent.')).toBeNull();
  expect((screen.getByRole('button', { name: 'Add watch' }) as HTMLButtonElement).disabled).toBe(true);
  mock.mockResolvedValue({ ok: true, watches: [], events: [] }); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('No watches for this agent.');
});
it('retains editor content and surfaces failed mutations', async () => {
  show(); fireEvent.click(await screen.findByRole('button', { name: /Assembly.*Enabled/ }));
  mock.mockRejectedValue(new Error('Save unavailable')); fireEvent.click(screen.getByRole('button', { name: 'Save watch' }));
  await screen.findByText('Could not save watch: Save unavailable');
  expect((screen.getByLabelText('Instruction') as HTMLTextAreaElement).value).toBe('Inspect the result');
});
it('does not apply old agent responses after switching destinations', async () => {
  let resolve: (value: unknown) => void = () => {};
  mock.mockImplementation((path) => path === '/api/events/watches' ? new Promise(r => { resolve = r; }) : Promise.resolve({ ok: true, events: [] }) as never);
  const view = show(); const oldResolve = resolve;
  view.rerender(<ConfirmProvider><AgentWorkflowEvents agentId="smatchet" /></ConfirmProvider>);
  oldResolve({ ok: true, watches: [watch] });
  resolve({ ok: true, watches: [] });
  await screen.findByText('No watches for this agent.');
  expect(screen.queryByRole('button', { name: /Assembly/ })).toBeNull();
});

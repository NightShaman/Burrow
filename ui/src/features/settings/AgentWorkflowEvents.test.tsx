import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { AgentWorkflowEvents, githubRunUrl, type WorkflowWatch } from './AgentWorkflowEvents';
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
    return { ok: true, events: [{ id: 'e', agentId: 'hatchet', workflow: 'Assembly', repository: 'kingdom/burrow', runId: '123', runAttempt: 2, conclusion: 'failure', status: 'succeeded', sessionId: 'ci-releases', url: 'https://github.com/kingdom/burrow/actions/runs/123', error: null }] } as never;
  });
});
function show(agentId = 'hatchet') { return render(<ConfirmProvider><AgentWorkflowEvents agentId={agentId} /></ConfirmProvider>); }
it('scopes watches and events to the selected agent, with distinct source and handling outcomes', async () => {
  show(); await screen.findByRole('button', { name: /Assembly.*Enabled/ });
  expect(screen.queryByText('Other agent watch')).toBeNull();
  expect(screen.getByText('failure')).toBeTruthy(); expect(screen.getByText('succeeded')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'GitHub run #123 · attempt 2' }).getAttribute('href')).toContain('/runs/123');
  expect(mock).toHaveBeenCalledWith('/api/events?agentId=hatchet&limit=50', expect.anything());
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
it('accepts only HTTPS GitHub source links', () => {
  expect(githubRunUrl('https://github.com/owner/repo/actions/runs/1')).toBeTruthy();
  for (const url of ['javascript:alert(1)', 'https://github.com.evil.test/a', 'http://github.com/a', 'invalid']) expect(githubRunUrl(url)).toBeUndefined();
});

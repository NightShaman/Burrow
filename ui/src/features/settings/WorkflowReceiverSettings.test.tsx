import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { WorkflowReceiverSettings, type ReceiverSettings } from './WorkflowReceiverSettings';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
const mock = vi.mocked(api);
const initial: ReceiverSettings = { deliveryUrl: '', webhookPath: '/api/events/github', secretConfigured: true, storedSecretConfigured: true, secretSource: 'settings', environmentOverride: false, ready: true, readiness: 'ready' };
let stored: ReceiverSettings;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  stored = { ...initial };
  mock.mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') {
      const patch = JSON.parse(String(init.body));
      stored = { ...stored, deliveryUrl: patch.deliveryUrl ?? stored.deliveryUrl, ...(patch.clearSecret ? { secretConfigured: false, storedSecretConfigured: false, secretSource: 'none', ready: false, readiness: 'secret_missing' } : {}) };
    }
    return { ok: true, settings: stored } as never;
  });
});
const body = () => JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body));
async function show() { render(<WorkflowReceiverSettings />); await screen.findByText('Configured'); }
it('shows global scope, readiness, source and write-only empty secret', async () => {
  await show();
  expect(screen.getByText('Shared by all agents.')).toBeTruthy();
  expect(screen.getByText('Ready')).toBeTruthy(); expect(screen.getByText('Settings')).toBeTruthy();
  const input = screen.getByLabelText(/Webhook secret/) as HTMLInputElement;
  expect(input.type).toBe('password'); expect(input.value).toBe('');
});
it('preserves blank secret while saving URL metadata, including clearing URL', async () => {
  await show(); fireEvent.change(screen.getByLabelText(/Delivery URL/), { target: { value: 'https://burrow.example/api/events/github' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save receiver' })); await screen.findByText(/Receiver saved/);
  expect(body()).toEqual({ deliveryUrl: 'https://burrow.example/api/events/github' });
  mock.mockClear(); fireEvent.change(screen.getByLabelText(/Delivery URL/), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save receiver' })); await waitFor(() => expect(body()).toEqual({ deliveryUrl: '' }));
});
it('sends a replacement with exact bytes then clears the password field', async () => {
  await show(); fireEvent.change(screen.getByLabelText(/Webhook secret/), { target: { value: ' exact secret bytes ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save receiver' })); await screen.findByText(/Receiver saved/);
  expect(body()).toEqual({ deliveryUrl: '', secret: ' exact secret bytes ' });
  expect((screen.getByLabelText(/Webhook secret/) as HTMLInputElement).value).toBe('');
});
it('only clears on explicit checkbox plus save, never sends replacement and clear together', async () => {
  await show(); fireEvent.change(screen.getByLabelText(/Webhook secret/), { target: { value: 'discard this' } });
  fireEvent.click(screen.getByLabelText('Clear stored secret on save'));
  expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect((screen.getByLabelText(/Webhook secret/) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save receiver' })); await screen.findByText('Not configured');
  expect(body()).toEqual({ deliveryUrl: '', clearSecret: true });
});
it('explains environment precedence while allowing stored secret changes', async () => {
  stored = { ...initial, secretSource: 'environment', environmentOverride: true };
  await show(); expect(screen.getByText('Environment override')).toBeTruthy(); expect(screen.getByText(/overrides the stored secret/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Clear stored secret on save')); expect(screen.getByText('The environment override will remain active.')).toBeTruthy();
});
it('shows unavailable encryption state without pretending receiver is ready', async () => {
  stored = { ...initial, ready: false, readiness: 'secret_unavailable' }; await show();
  expect(screen.getByText('Stored secret unavailable')).toBeTruthy(); expect(screen.getByRole('alert').textContent).toContain('cannot be decrypted');
});
it('rejects invalid URLs without mutation', async () => {
  await show();
  for (const value of ['https://burrow.example/wrong', 'javascript:alert(1)', 'https://user:pass@burrow.example/api/events/github', 'https://burrow.example/api/events/github?q=1', 'https://burrow.example/api/events/github#fragment', 'https://burrow.example/api/events/github?', 'https://burrow.example/api/events/github#']) {
    fireEvent.change(screen.getByLabelText(/Delivery URL/), { target: { value } }); fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }));
    expect(screen.getByRole('alert').textContent).toContain('absolute HTTP(S)');
  }
  expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('retains failed draft and supports discard without mutation', async () => {
  await show(); mock.mockRejectedValue(new Error('Offline'));
  fireEvent.change(screen.getByLabelText(/Webhook secret/), { target: { value: 'unsaved' } }); fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }));
  await screen.findByText('Could not save receiver: Offline'); expect((screen.getByLabelText(/Webhook secret/) as HTMLInputElement).value).toBe('unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Discard receiver changes' })); expect((screen.getByLabelText(/Webhook secret/) as HTMLInputElement).value).toBe('');
});
it('does not present read errors as unconfigured and retries', async () => {
  mock.mockRejectedValue(new Error('Unavailable')); render(<WorkflowReceiverSettings />); await screen.findByText(/Could not load receiver/);
  expect(screen.queryByText('Not configured')).toBeNull(); expect(screen.queryByRole('button', { name: 'Save receiver' })).toBeNull();
  mock.mockResolvedValue({ ok: true, settings: initial }); fireEvent.click(screen.getByRole('button', { name: 'Retry receiver' })); await screen.findByText('Configured');
});
it('registers receiver drafts with the shared unsaved navigation guard', async () => {
  function Navigate() { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(() => {})}>Leave</button>; }
  render(<UnsavedChangesProvider><WorkflowReceiverSettings /><Navigate /></UnsavedChangesProvider>); await screen.findByText('Configured');
  fireEvent.change(screen.getByLabelText(/Webhook secret/), { target: { value: 'draft' } }); fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByRole('alertdialog').textContent).toContain('Unsaved changes'); fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((screen.getByLabelText(/Webhook secret/) as HTMLInputElement).value).toBe('');
});

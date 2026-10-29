import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { ApiTokensSettings } from './ApiTokensSettings';
import { BrowserOriginSettings } from './BrowserOriginSettings';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
function Harness({ children }: { children: React.ReactNode }) {
  const [left, setLeft] = useState(false);
  const navigate = useUnsavedNavigation();
  return <><button onClick={() => navigate(() => setLeft(true))}>Leave</button>{left ? <p>Destination</p> : children}</>;
}
function mount(children: React.ReactNode) { render(<ConfirmProvider><UnsavedChangesProvider><Harness>{children}</Harness></UnsavedChangesProvider></ConfirmProvider>); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(finish => { resolve = finish; }), resolve }; }

it('browser origin stays on failed save, then discards to the accepted preference', async () => {
  vi.mocked(api).mockImplementation(async (_, init) => {
    if (init?.method === 'PUT') throw new Error('write failed');
    return { ok: true, settings: { checkOrigin: false }, effective: { checkOrigin: false, source: 'database' } };
  });
  mount(<BrowserOriginSettings />);
  const input = await screen.findByRole('checkbox', { name: 'Check browser origin' });
  fireEvent.click(input);
  await screen.findByText('Could not save browser origin settings. Try saving again.');
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Could not save browser origin settings. Try saving again.');
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  expect(screen.getByRole('checkbox', { name: 'Check browser origin' })).toHaveProperty('checked', true);
  expect(screen.queryByText('Destination')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(await screen.findByText('Destination')).toBeTruthy();
});

it('navigation requested during token creation does not unmount the one-time reveal', async () => {
  const creation = deferred<{ token: { id: string; name: string; scopes: string[]; token: string } }>();
  vi.mocked(api).mockImplementation(async (_, init) => init?.method === 'POST'
    ? creation.promise
    : { tokens: [], supportedScopes: ['diagnostics:read'] });
  mount(<ApiTokensSettings />);
  await screen.findByText('No API tokens created yet.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Diagnostic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create API token' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  expect(screen.queryByText('Destination')).toBeNull();
  await act(async () => creation.resolve({ token: { id: 'token-1', name: 'Diagnostic', scopes: ['diagnostics:read'], token: 'secret-once' } }));
  expect(await screen.findByRole('textbox', { name: 'New API token plaintext' })).toHaveProperty('value', 'secret-once');
  expect(screen.queryByText('Destination')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  expect(await screen.findByText('Destination')).toBeTruthy();
});

it('token Save retains the one-time reveal before allowing navigation', async () => {
  vi.mocked(api).mockImplementation(async (_, init) => init?.method === 'POST'
    ? { token: { id: 'token-1', name: 'Diagnostic', scopes: ['diagnostics:read'], token: 'secret-once' } }
    : { tokens: [], supportedScopes: ['diagnostics:read'] });
  mount(<ApiTokensSettings />);
  await screen.findByText('No API tokens created yet.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Diagnostic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.getByRole('textbox', { name: 'Token name' })).toHaveProperty('value', 'Diagnostic');
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('textbox', { name: 'New API token plaintext' })).toHaveProperty('value', 'secret-once');
  expect(screen.queryByText('Destination')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  expect(await screen.findByText('Destination')).toBeTruthy();
  expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
});

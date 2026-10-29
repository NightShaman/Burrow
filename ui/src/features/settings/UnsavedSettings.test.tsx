import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { OperatorProfile } from './OperatorProfile';
import { McpConnections } from './McpConnections';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
const profile = { name: 'Operator', avatar: '' };
const alpha = { id: 'alpha', name: 'Alpha', transport: 'http', lifecycle: 'ephemeral', baseUrl: 'https://alpha.test', command: null, args: [], enabled: true, apiKeyConfigured: true, environmentVariables: [], tools: [] };
const beta = { ...alpha, id: 'beta', name: 'Beta', baseUrl: 'https://beta.test' };
function Harness({ mcp = false }: { mcp?: boolean }) {
  const navigate = useUnsavedNavigation();
  const [left, setLeft] = useState(false);
  return <><button onClick={() => navigate(() => setLeft(true))}>Leave Settings</button>{left ? <h1>Destination</h1> : mcp ? <McpConnections /> : <OperatorProfile onSaved={() => {}} />}</>;
}
function mount(mcp = false) { render(<ConfirmProvider><UnsavedChangesProvider><Harness mcp={mcp} /></UnsavedChangesProvider></ConfirmProvider>); }
function leave() { fireEvent.click(screen.getByText('Leave Settings')); }
function choose(name: string) { fireEvent.click(screen.getByRole('button', { name })); }
async function openProfile() { vi.mocked(api).mockResolvedValueOnce({ operator: profile }); mount(); await screen.findByDisplayValue('Operator'); }
async function editMcp() { await screen.findByRole('button', { name: 'Edit Alpha' }); choose('Edit Alpha'); fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } }); }
const changeName = (value: string) => fireEvent.change(screen.getByLabelText('Displayed name'), { target: { value } });
it('clean and reverted forms leave without prompting', async () => {
  await openProfile(); changeName('Changed'); changeName('Operator'); leave(); expect(screen.getByText('Destination')).toBeTruthy(); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('Stay, Escape and backdrop keep the draft and restore focus; Discard leaves without saving', async () => {
  await openProfile(); changeName('Changed');
  const opener = screen.getByText('Leave Settings'); opener.focus(); leave();
  expect(document.activeElement).toBe(screen.getByText('Stay'));
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(screen.getByText('Save'));
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.getByDisplayValue('Changed')).toBeTruthy(); expect(document.activeElement).toBe(opener);
  leave(); choose('Stay'); expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  leave(); fireEvent.click(document.querySelector('.accessible-modal-backdrop')!); expect(screen.queryByRole('alertdialog')).toBeNull();
  leave(); choose('Discard'); expect(screen.getByText('Destination')).toBeTruthy(); expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
});
it('Save waits for success, locks dialog actions and blocks repeated submission', async () => {
  await openProfile(); changeName('Changed'); let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  leave(); choose('Save'); expect(screen.queryByText('Destination')).toBeNull();
  expect((screen.getByText('Discard') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Saving…')); expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ ok: true, operator: { ...profile, name: 'Changed' } })); expect(screen.getByText('Destination')).toBeTruthy();
});
it('Save failure cancels destination and retains draft, validation also explains failure', async () => {
  await openProfile(); changeName('Changed'); vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  leave(); choose('Save'); await screen.findByRole('alert'); expect(screen.queryByText('Destination')).toBeNull(); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  changeName(''); leave(); choose('Save'); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot be empty'));
});
it('normal save clears dirty state; browser unload is protected only while dirty or busy', async () => {
  await openProfile(); const clean = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  changeName('Changed'); const dirty = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.blur(screen.getByLabelText('Displayed name'));
  expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toMatchObject({ kind: 'operator', name: 'Changed' });
  const busy = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(busy); expect(busy.defaultPrevented).toBe(true);
  expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(true);
  await act(async () => resolve({ ok: true, operator: { ...profile, name: 'Changed' } }));
  expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(false);
  const saved = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(saved); expect(saved.defaultPrevented).toBe(false);
  leave(); expect(screen.getByText('Destination')).toBeTruthy(); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('MCP same-item clicks preserve edits; Stay keeps selection; Discard switches and restores saved values', async () => {
  vi.mocked(api).mockResolvedValue({ connections: [alpha, beta] }); mount(true); await editMcp();
  choose('Edit Alpha'); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  choose('Edit Beta'); choose('Stay'); expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  choose('Edit Beta'); choose('Discard'); expect(screen.getByDisplayValue('Beta')).toBeTruthy(); choose('Edit Alpha'); expect(screen.getByDisplayValue('Alpha')).toBeTruthy();
});
it('MCP Cancel guards dirty changes and clean selection switches without prompts', async () => {
  vi.mocked(api).mockResolvedValue({ connections: [alpha, beta] }); mount(true); await editMcp();
  choose('Cancel'); choose('Stay'); expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  choose('Cancel'); choose('Discard'); expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  choose('Edit Beta'); choose('Edit Alpha'); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('MCP Save-and-switch waits for mutation and refresh and submits original editor', async () => {
  vi.mocked(api).mockResolvedValueOnce({ connections: [alpha, beta] }).mockResolvedValueOnce({ ok: true }).mockResolvedValue({ connections: [{ ...alpha, name: 'Changed' }, beta] });
  mount(true); await editMcp(); choose('Edit Beta'); choose('Save'); await screen.findByDisplayValue('Beta');
  expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toMatchObject({ id: 'alpha', name: 'Changed' });
  leave(); expect(screen.getByText('Destination')).toBeTruthy();
});
it('MCP failed refresh after successful save stays put, exposes retry and prevents duplicate mutation', async () => {
  vi.mocked(api).mockResolvedValueOnce({ connections: [alpha, beta] }).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('refresh offline')).mockResolvedValue({ connections: [{ ...alpha, name: 'Changed' }, beta] });
  mount(true); await editMcp(); choose('Edit Beta'); choose('Save');
  await screen.findByText('Retry loading'); expect(screen.getByDisplayValue('Changed')).toBeTruthy(); expect(screen.queryByRole('alertdialog')).toBeNull();
  expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
  choose('Retry loading'); await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')); choose('Edit Beta'); expect(screen.getByDisplayValue('Beta')).toBeTruthy();
  expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('MCP invalid and failed saves explain failure and keep selection and secrets', async () => {
  vi.mocked(api).mockResolvedValueOnce({ connections: [alpha, beta] }); mount(true); await editMcp();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } }); choose('Edit Beta'); choose('Save'); await screen.findByText('Enter a name before saving.');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } }); fireEvent.change(screen.getByLabelText('API key (optional)'), { target: { value: 'new-secret' } });
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')); leave(); choose('Save'); await screen.findByText('Could not save MCP connection: offline'); expect(screen.getByDisplayValue('new-secret')).toBeTruthy(); expect(screen.queryByText('Destination')).toBeNull();
});
it('deleting locks editor navigation until DELETE resolves so another draft cannot be erased', async () => {
  vi.mocked(api).mockResolvedValueOnce({ connections: [alpha, beta] }); mount(true); await screen.findByText('Alpha'); choose('Edit Alpha'); choose('Delete Alpha');
  let resolve!: (value: unknown) => void; vi.mocked(api).mockReturnValueOnce(new Promise(done => { resolve = done; })); choose('Delete connection');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Edit Beta' }) as HTMLButtonElement).disabled).toBe(true)); leave(); expect(screen.queryByText('Destination')).toBeNull();
  await act(async () => resolve({ ok: true, operator: { ...profile, name: 'Changed' } })); choose('Edit Beta'); fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta draft' } }); expect(screen.getByDisplayValue('Beta draft')).toBeTruthy();
});

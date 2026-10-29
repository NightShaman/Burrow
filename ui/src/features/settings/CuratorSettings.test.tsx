import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import type { SavedProvider } from '../../app/types';
import { CuratorSettings } from './CuratorSettings';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); document.body.removeAttribute('data-left'); });
const external = { kind: 'external', connectionId: 'saved', model: 'model-a', temperature: 0.1 };
const local = { kind: 'local', modelPath: 'models/saved.gguf', contextSize: 8192, gpuLayers: 3, temperature: 0.1 };
const response = (selection: unknown) => ({ ok: true, configured: true, available: true, selection });
const providers = [{ id: 'saved', provider: 'Saved', models: ['model-a', 'model-b'] }] as SavedProvider[];
function Leave() { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(() => document.body.setAttribute('data-left', 'yes'))}>Leave</button>; }
async function mount(selection: unknown = external) {
  vi.mocked(api).mockResolvedValueOnce(response(selection));
  const view = render(<UnsavedChangesProvider><CuratorSettings savedProviders={providers} /><Leave /></UnsavedChangesProvider>);
  await waitFor(() => expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(false));
  return view;
}
function put() { return vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(init!.body as string)); }
function adjust(value = '0.3') { const slider = screen.getByRole('slider'); fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value } }); return slider; }

it('autosaves temperature once at pointer completion using the accepted external identity, not an unfinished local draft', async () => {
  await mount();
  fireEvent.click(screen.getByRole('radio', { name: 'Local GGUF' }));
  fireEvent.change(screen.getByLabelText('Model path'), { target: { value: 'models/draft.gguf' } });
  fireEvent.change(screen.getByLabelText('Context size'), { target: { value: '12345' } });
  const slider = adjust();
  expect(put()).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, temperature: 0.3 }));
  fireEvent.pointerUp(slider); fireEvent.lostPointerCapture(slider); fireEvent.blur(slider);
  await screen.findByText('Tiddle temperature saved.');
  expect(put()).toEqual([{ ...external, temperature: 0.3 }]);
  expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe('models/draft.gguf');
  expect((screen.getByLabelText('Context size') as HTMLInputElement).value).toBe('12345');
  fireEvent.click(screen.getByText('Leave'));
  const dialog = screen.getByRole('alertdialog');
  fireEvent.click(within(dialog).getByText('Discard'));
  expect((screen.getByRole('radio', { name: 'Existing model connection' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

it('keeps local model parameters coupled while keyboard temperature commits only the accepted local selection', async () => {
  await mount(local);
  fireEvent.change(screen.getByLabelText('Model path'), { target: { value: 'unfinished' } });
  fireEvent.change(screen.getByLabelText('GPU layers'), { target: { value: '8' } });
  const slider = screen.getByRole('slider');
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  fireEvent.change(slider, { target: { value: '0.2' } });
  fireEvent.change(slider, { target: { value: '0.3' } });
  expect(put()).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce(response({ ...local, temperature: 0.3 }));
  fireEvent.keyUp(slider, { key: 'ArrowRight' });
  await screen.findByText('Tiddle temperature saved.');
  expect(put()).toEqual([{ ...local, temperature: 0.3 }]);
  vi.mocked(api).mockResolvedValueOnce(response({ ...local, modelPath: 'unfinished', gpuLayers: 8, temperature: 0.3 }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Tiddle Settings' }));
  await screen.findByText('Tiddle settings saved.');
  expect(put()[1]).toEqual({ ...local, modelPath: 'unfinished', gpuLayers: 8, temperature: 0.3 });
});

it('preserves a failed autosave, retries only temperature, and keeps other drafts guarded', async () => {
  await mount();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.blur(adjust());
  await screen.findByText('Could not save Tiddle temperature: offline');
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
  await screen.findByText('Could not save curator settings: Choose a model for the selected provider.');
  expect(document.body.getAttribute('data-left')).toBeNull();
  expect(put()).toHaveLength(1);
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, temperature: 0.3 }));
  fireEvent.click(screen.getByText('Retry saving Tiddle temperature'));
  await screen.findByText('Tiddle temperature saved.');
  expect(put()[1]).toEqual({ ...external, temperature: 0.3 });
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Discard'));
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('model-a');
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
});

it('blocks duplicate mutations and resumes queued navigation after temperature-only success', async () => {
  await mount();
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const slider = adjust(); fireEvent.pointerUp(slider); fireEvent.pointerCancel(slider);
  expect((slider as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.body.getAttribute('data-left')).toBeNull();
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  resolve(response({ ...external, temperature: 0.3 }));
  await waitFor(() => expect(document.body.getAttribute('data-left')).toBe('yes'));
  expect(put()).toHaveLength(1);
});

it('does not autosave an initial model draft with no accepted selection', async () => {
  vi.mocked(api).mockResolvedValueOnce({ ok: true, configured: false, selection: null });
  render(<CuratorSettings savedProviders={providers} />);
  await waitFor(() => expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(false));
  fireEvent.pointerUp(adjust());
  expect(put()).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, temperature: 0.3 }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Tiddle Settings' }));
  await screen.findByText('Tiddle settings saved.');
  expect(put()).toEqual([{ ...external, temperature: 0.3 }]);
});

it('ignores a late autosave completion after unmount', async () => {
  const view = await mount();
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.pointerCancel(adjust());
  view.unmount();
  await mount(local);
  resolve(response({ ...external, temperature: 0.3 }));
  await waitFor(() => expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.1'));
  expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe(local.modelPath);
  expect(screen.queryByText('Tiddle temperature saved.')).toBeNull();
});

it('does not blur-save an active temperature interaction when the unsaved modal takes focus', async () => {
  await mount();
  const slider = adjust();
  slider.focus();
  fireEvent.click(screen.getByText('Leave'));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(put()).toHaveLength(0);
  expect((slider as HTMLInputElement).value).toBe('0.3');
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Stay'));
  expect(document.body.getAttribute('data-left')).toBeNull();
});

it('guard Save retries a failed temperature-only draft and navigates only after success', async () => {
  await mount();
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.pointerUp(adjust());
  await screen.findByText('Could not save Tiddle temperature: offline');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Stay'));
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, temperature: 0.3 }));
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
  await waitFor(() => expect(document.body.getAttribute('data-left')).toBe('yes'));
  expect(put()).toEqual([{ ...external, temperature: 0.3 }, { ...external, temperature: 0.3 }]);
});

it('reverting a failed temperature adjustment clears retry and dirty state without another mutation', async () => {
  await mount();
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.pointerUp(adjust());
  await screen.findByText('Could not save Tiddle temperature: offline');
  fireEvent.lostPointerCapture(adjust('0.1'));
  expect(screen.queryByText('Retry saving Tiddle temperature')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(put()).toHaveLength(1);
  fireEvent.click(screen.getByText('Leave'));
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

const invalidResponses = [
  ['missing selection', { ok: true, configured: true }],
  ['null selection', response(null)],
  ['missing configured flag', { ok: true, selection: external }],
  ['unconfigured selection', { ok: true, configured: false, selection: external }],
  ['unknown source', response({ kind: 'unknown' })],
  ['missing connection', response({ ...external, connectionId: undefined })],
  ['blank model', response({ ...external, model: ' ' })],
  ['missing local path', response({ ...local, modelPath: undefined })],
  ['invalid temperature', response({ ...external, temperature: '0.3' })],
  ['out-of-range temperature', response({ ...external, temperature: 0.8 })],
  ['invalid context size', response({ ...local, contextSize: 0 })],
  ['invalid GPU layers', response({ ...local, gpuLayers: '3' })],
] as const;

it.each(invalidResponses)('fails closed on a %s read and retries the actual saved selection', async (_label, result) => {
  vi.mocked(api).mockResolvedValueOnce(result);
  render(<CuratorSettings savedProviders={providers} />);
  await screen.findByText('Could not load curator settings: Invalid curator settings response.');
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('radio', { name: 'Local GGUF' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save Tiddle Settings' }) as HTMLButtonElement).disabled).toBe(true);
  expect(put()).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce(response(local));
  fireEvent.click(screen.getByText('Retry Tiddle Settings'));
  await waitFor(() => expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe(local.modelPath);
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.1');
});

it.each([...invalidResponses, ['unconfigured result', { ok: true, configured: false, selection: null }]] as const)('keeps explicit Save dirty and guarded after a %s response', async (_label, result) => {
  await mount();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-b' } });
  vi.mocked(api).mockResolvedValueOnce(result);
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
  await screen.findByText('Could not save curator settings: Invalid curator settings response.');
  expect(screen.queryByText('Tiddle settings saved.')).toBeNull();
  expect(document.body.getAttribute('data-left')).toBeNull();
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('model-b');
  // A rejected response must not replace the accepted identity used by autosave.
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, temperature: 0.3 }));
  fireEvent.pointerUp(adjust());
  await screen.findByText('Tiddle temperature saved.');
  expect(put()[1]).toEqual({ ...external, temperature: 0.3 });
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  vi.mocked(api).mockResolvedValueOnce(response({ ...external, model: 'model-b', temperature: 0.3 }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
  await waitFor(() => expect(document.body.getAttribute('data-left')).toBe('yes'));
});

it.each([...invalidResponses, ['unconfigured result', { ok: true, configured: false, selection: null }]] as const)('preserves a temperature draft and accepted selection after a %s autosave response', async (_label, result) => {
  await mount(local);
  fireEvent.change(screen.getByLabelText('Model path'), { target: { value: 'models/draft.gguf' } });
  vi.mocked(api).mockResolvedValueOnce(result);
  fireEvent.pointerUp(adjust());
  await screen.findByText('Could not save Tiddle temperature: Invalid curator settings response.');
  expect(screen.queryByText('Tiddle temperature saved.')).toBeNull();
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
  expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe('models/draft.gguf');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Stay'));
  vi.mocked(api).mockResolvedValueOnce(response({ ...local, temperature: 0.3 }));
  fireEvent.click(screen.getByText('Retry saving Tiddle temperature'));
  await screen.findByText('Tiddle temperature saved.');
  expect(put()).toEqual([{ ...local, temperature: 0.3 }, { ...local, temperature: 0.3 }]);
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Discard'));
  expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe(local.modelPath);
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
});

it.each([
  { kind: 'external', connectionId: 'saved', model: 'model-a', version: 1, temperature: 0.5 },
  // The backend allows finite GPU values (including -1) and positive noninteger contexts.
  { kind: 'local', modelPath: 'models/saved.gguf', version: 1, backend: 'node-llama-cpp', contextSize: 8192.5, gpuLayers: -1, temperature: 0 },
])('accepts backend selection metadata and numeric boundaries for $kind', async selection => {
  await mount(selection);
  expect(screen.queryByRole('alert')).toBeNull();
  vi.mocked(api).mockResolvedValueOnce(response({ ...selection, temperature: 0.3 }));
  fireEvent.pointerUp(adjust());
  await screen.findByText('Tiddle temperature saved.');
  expect(put()).toEqual([{ ...selection, temperature: 0.3 }]);
});

it.each([null, undefined])('allows an unconfigured read without a selection (%s), but never autosaves a model implicitly', async selection => {
  vi.mocked(api).mockResolvedValueOnce({ ok: true, configured: false, selection });
  render(<CuratorSettings savedProviders={providers} />);
  await waitFor(() => expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(false));
  fireEvent.pointerUp(adjust());
  expect(put()).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce({ ok: true });
  fireEvent.click(screen.getByRole('button', { name: 'Save Tiddle Settings' }));
  await screen.findByText('Could not save curator settings: Invalid curator settings response.');
  expect(screen.queryByText('Tiddle settings saved.')).toBeNull();
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0.3');
  expect((screen.getByRole('button', { name: 'Save Tiddle Settings' }) as HTMLButtonElement).disabled).toBe(false);
});

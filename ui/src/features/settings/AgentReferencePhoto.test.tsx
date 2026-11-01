import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, fetchApi } from '../../app/api';
import type { Agent } from '../../app/types';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { AgentSettings } from './AgentSettings';

vi.mock('../../app/api', () => ({ api: vi.fn(), fetchApi: vi.fn() }));
vi.mock('./DefaultMinionModel', () => ({ DefaultMinionModel: () => null }));
vi.mock('./MinionDepthSettings', () => ({ MinionDepthSettings: () => null }));
const agent = { id: 'ui-a', resourceId: 'node::a', name: 'Alpha', avatar: 'data:image/png;base64,AA', enabled: true, activity: 'Idle' } as Agent;
const endpoint = '/api/agents/node%3A%3Aa/reference-image';
const photo = (id = 'one', agentId = 'node::a') => ({ id, attachmentId: `attachment-${id}`, contentUrl: `/api/agents/${encodeURIComponent(agentId)}/reference-image/content?id=${id}`, mimeType: 'image/png', fileName: `${id}.png`, sizeBytes: 3, updatedAt: '2026-11-01T12:00:00Z' });
const ack = (image: ReturnType<typeof photo> | null, agentId = 'node::a') => ({ ok: true, agentId, referenceImage: image });
const mutations = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method);
const paste = (file = new File(['abc'], 'portrait.png', { type: 'image/png' })) => fireEvent.paste(screen.getByLabelText('Reference photo file'), { clipboardData: { items: [{ type: file.type, getAsFile: () => file }] } });
const upload = (file = new File(['abc'], 'portrait.png', { type: 'image/png' })) => fireEvent.change(screen.getByLabelText('Upload reference photo'), { target: { files: [file] } });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Leave({ leave }: { leave: () => void }) { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(leave)}>Leave</button>; }
function Form({ selected = agent, leave = () => {} }: { selected?: Agent; leave?: () => void }) {
  return <ConfirmProvider><UnsavedChangesProvider><AgentSettings selected={selected} savedProviders={[]} onAgentsChanged={async () => {}} section="details" /><Leave leave={leave} /></UnsavedChangesProvider></ConfirmProvider>;
}
beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path, init) => {
    const id = decodeURIComponent(path.split('/')[3]);
    return ack(init?.method === 'PUT' ? photo('saved', id) : null, id);
  });
  vi.mocked(fetchApi).mockResolvedValue({ ok: true, blob: async () => new Blob(['abc'], { type: 'image/png' }) } as Response);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:photo') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('loads metadata with API identity, retains the avatar and renders the original authenticated photo without cropping', async () => {
  vi.mocked(api).mockResolvedValue(ack(photo()));
  const view = render(<Form />);
  await screen.findByRole('img', { name: 'Alpha reference photo' });
  expect(api).toHaveBeenCalledWith(endpoint);
  expect(fetchApi).toHaveBeenCalledWith(photo().contentUrl, expect.objectContaining({ signal: expect.any(AbortSignal), headers: { accept: 'image/png' } }));
  expect(view.container.querySelector('.agent-avatar-preview:not(.agent-reference-preview) img')?.getAttribute('src')).toBe(agent.avatar);
  expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', 'one.png');
  expect(screen.getByText('Replace')).toBeTruthy();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
});

it.each([upload, paste])('saves exact original bytes (%#) as JSON, independently of a name draft, then replaces and removes without identity writes', async choose => {
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  const name = screen.getByLabelText('Displayed name');
  fireEvent.change(name, { target: { value: 'unfinished' } });
  fireEvent.blur(name, { relatedTarget: screen.getByText('Upload') });
  choose();
  await screen.findByText('Reference photo saved.');
  expect(mutations()).toEqual([[endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'portrait.png', content: 'data:image/png;base64,YWJj' }) }]]);
  expect(name).toHaveProperty('value', 'unfinished');
  expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', 'saved.png');
  choose(new File(['xyz'], 'replacement.webp', { type: 'image/webp' }));
  await waitFor(() => expect(mutations()).toHaveLength(2));
  await waitFor(() => expect(screen.getByText('Replace')).toHaveProperty('disabled', false));
  expect(JSON.parse(mutations()[1][1]!.body as string)).toEqual({ fileName: 'replacement.webp', content: 'data:image/webp;base64,eHl6' });
  fireEvent.click(screen.getByText('Remove reference photo'));
  await screen.findByText('Reference photo removed.');
  expect(mutations()[2]).toEqual([endpoint, { method: 'DELETE', headers: { 'content-type': 'application/json' } }]);
  await waitFor(() => expect(screen.queryByRole('img', { name: 'Alpha reference photo' })).toBeNull());
  expect(screen.getByText('Upload')).toBeTruthy();
  expect(name).toHaveProperty('value', 'unfinished');
});

it.each([
  new File(['x'], 'animated.gif', { type: 'image/gif' }),
  new File([], 'empty.png', { type: 'image/png' }),
  Object.defineProperty(new File(['x'], 'large.jpg', { type: 'image/jpeg' }), 'size', { value: 20 * 1024 * 1024 + 1 }),
])('rejects unsupported, empty or oversized files before reading/writing: $name', async file => {
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  upload(file);
  expect(screen.getByRole('alert').textContent).toContain('PNG, JPEG or WebP');
  expect(mutations()).toHaveLength(0);
});

it('accepts the 20 MiB boundary and prevents duplicate writes or unrelated edits while saving', async () => {
  const saving = deferred<unknown>();
  vi.mocked(api).mockImplementation((_path, init) => init?.method ? saving.promise : Promise.resolve(ack(null)));
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  upload(Object.defineProperty(new File(['x'], 'boundary.jpg', { type: 'image/jpeg' }), 'size', { value: 20 * 1024 * 1024 }));
  upload();
  await waitFor(() => expect(mutations()).toHaveLength(1));
  expect(screen.getByLabelText('Displayed name')).toHaveProperty('disabled', true);
  expect(screen.getByText('Upload')).toHaveProperty('disabled', true);
  expect(screen.getByText('Saving reference photo…')).toBeTruthy();
  expect(screen.queryByText('Saving agent details…')).toBeNull();
  await act(async () => saving.resolve(ack(photo())));
  expect(screen.getByLabelText('Displayed name')).toHaveProperty('disabled', false);
});

it.each([upload, paste])('preserves failed file intent (%#) and old accepted preview, retries via shared guard, and can discard without removing the photo', async choose => {
  vi.mocked(api).mockImplementation(async (_path, init) => { if (init?.method) throw new Error('upload denied'); return ack(photo()); });
  const leave = vi.fn();
  render(<Form leave={leave} />);
  await screen.findByRole('img', { name: 'Alpha reference photo' });
  choose();
  await screen.findByText('upload denied');
  expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', 'portrait.png');
  expect(screen.getByRole('img', { name: 'Alpha reference photo' })).toHaveProperty('src', 'blob:photo');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Stay'));
  fireEvent.click(screen.getByText('Retry saving reference photo'));
  await waitFor(() => expect(mutations()).toHaveLength(2));
  await waitFor(() => expect(screen.getByText('Retry saving reference photo')).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(leave).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', 'one.png');
  choose();
  await screen.findByText('upload denied');
  vi.mocked(api).mockResolvedValue(ack(photo('new')));
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(leave).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', 'new.png');
});

it('failed removal retains preview and retries DELETE instead of an upload', async () => {
  vi.mocked(api).mockResolvedValue(ack(photo()));
  render(<Form />);
  await screen.findByRole('img', { name: 'Alpha reference photo' });
  vi.mocked(api).mockRejectedValueOnce(new Error('remove denied'));
  fireEvent.click(screen.getByText('Remove reference photo'));
  await screen.findByText('remove denied');
  expect(screen.getByRole('img', { name: 'Alpha reference photo' })).toBeTruthy();
  vi.mocked(api).mockResolvedValue(ack(null));
  fireEvent.click(screen.getByText('Retry saving reference photo'));
  await screen.findByText('Reference photo removed.');
  expect(mutations().map(([, init]) => init?.method)).toEqual(['DELETE', 'DELETE']);
});

it('failed metadata load disables mutations and has a working retry', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('load denied'));
  render(<Form />);
  await screen.findByText('load denied');
  expect(screen.getByText('Upload')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByText('Retry loading reference photo'));
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  expect(mutations()).toHaveLength(0);
});

it('preview failure has an independent retry and never replays the accepted write', async () => {
  vi.mocked(fetchApi).mockRejectedValueOnce(new Error('stale image 404'));
  vi.mocked(api).mockResolvedValue(ack(photo()));
  render(<Form />);
  await screen.findByText('Reference photo preview unavailable.');
  fireEvent.click(screen.getByText('Retry photo preview'));
  await screen.findByRole('img', { name: 'Alpha reference photo' });
  expect(fetchApi).toHaveBeenCalledTimes(2);
  expect(mutations()).toHaveLength(0);
});

it.each([null, {}, { ok: true, agentId: 'wrong', referenceImage: null }, ack(null), ack({ ...photo(), contentUrl: 'https://wrong.example/image' }), ack({ ...photo(), sizeBytes: 0 })])('rejects malformed upload acknowledgements %# without claiming success', async invalid => {
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  vi.mocked(api).mockResolvedValue(invalid);
  upload();
  await screen.findByText('Invalid reference photo acknowledgement.');
  expect(screen.queryByText('Reference photo saved.')).toBeNull();
  expect(screen.getByText('Retry saving reference photo')).toBeTruthy();
});

it('ignores stale metadata and upload results after resource-only selection changes or unmount', async () => {
  const old = deferred<unknown>();
  vi.mocked(api).mockReturnValueOnce(old.promise);
  const view = render(<Form />);
  view.rerender(<Form selected={{ ...agent, resourceId: 'node::b', name: 'Bravo' }} />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  await act(async () => old.resolve(ack(photo())));
  expect(screen.queryByRole('img', { name: 'Alpha reference photo' })).toBeNull();
  const write = deferred<unknown>();
  vi.mocked(api).mockReturnValueOnce(write.promise);
  upload();
  await waitFor(() => expect(mutations()).toHaveLength(1));
  view.rerender(<Form selected={{ ...agent, resourceId: 'node::c', name: 'Charlie' }} />);
  await act(async () => write.resolve(ack(photo('old', 'node::b'), 'node::b')));
  expect(screen.queryByText('Reference photo saved.')).toBeNull();
  expect(screen.getByLabelText('Displayed name')).toHaveProperty('value', 'Charlie');
  view.unmount();
});

it('cancels old preview reads and suppresses an upload still reading the file after owner change', async () => {
  const read = deferred<Blob>();
  vi.mocked(api).mockResolvedValueOnce(ack(photo()));
  vi.mocked(fetchApi).mockResolvedValueOnce({ ok: true, blob: () => read.promise } as Response);
  const view = render(<Form />);
  await waitFor(() => expect(fetchApi).toHaveBeenCalledOnce());
  const readAsDataURL = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(() => {});
  upload();
  view.rerender(<Form selected={{ ...agent, resourceId: 'node::b', name: 'Bravo' }} />);
  await act(async () => read.resolve(new Blob(['x'])));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(mutations()).toHaveLength(0);
  readAsDataURL.mockRestore();
});

it('loads under React StrictMode without accepting the disposed first effect', async () => {
  render(<StrictMode><Form /></StrictMode>);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  upload();
  await screen.findByText('Reference photo saved.');
  expect(mutations()).toHaveLength(1);
});


it('keeps text, missing clipboard files and unrelated-field paste native and local', async () => {
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  const target = screen.getByLabelText('Reference photo file');
  expect(target).toHaveProperty('placeholder', 'Paste an image or choose a file');
  expect(fireEvent.paste(target, { clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] } })).toBe(true);
  expect(fireEvent.paste(target, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => null }] } })).toBe(true);
  expect(fireEvent.paste(screen.getByLabelText('Displayed name'), { clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['x'], 'other.png', { type: 'image/png' }) }] } })).toBe(true);
  expect(mutations()).toHaveLength(0);
});

it.each([
  new File(['x'], 'animated.gif', { type: 'image/gif' }),
  new File([], 'empty.png', { type: 'image/png' }),
  Object.defineProperty(new File(['x'], 'large.jpg', { type: 'image/jpeg' }), 'size', { value: 20 * 1024 * 1024 + 1 }),
])('validates pasted images through the picker path: $name', async file => {
  render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  expect(paste(file)).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('PNG, JPEG or WebP');
  expect(mutations()).toHaveLength(0);
});

it('ignores paste before metadata loads and while a paste save is in flight', async () => {
  const loading = deferred<unknown>();
  const saving = deferred<unknown>();
  vi.mocked(api).mockImplementation((_path, init) => init?.method ? saving.promise : loading.promise);
  render(<Form />);
  expect(paste()).toBe(true);
  expect(mutations()).toHaveLength(0);
  await act(async () => loading.resolve(ack(null)));
  expect(paste()).toBe(false);
  expect(paste()).toBe(true);
  await waitFor(() => expect(mutations()).toHaveLength(1));
  expect(screen.getByLabelText('Displayed name')).toHaveProperty('disabled', true);
  await act(async () => saving.resolve(ack(photo())));
  await screen.findByText('Reference photo saved.');
});

it('guards pasted file reads after owner changes', async () => {
  const view = render(<Form />);
  await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
  let reader: FileReader | undefined;
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { reader = this; });
  try {
    paste();
    view.rerender(<Form selected={{ ...agent, resourceId: 'node::b', name: 'Bravo' }} />);
    await waitFor(() => expect(screen.getByText('Upload')).toHaveProperty('disabled', false));
    await act(async () => {
      Object.defineProperty(reader!, 'result', { value: 'data:image/png;base64,YWJj' });
      reader!.dispatchEvent(new ProgressEvent('load'));
    });
    expect(mutations()).toHaveLength(0);
    expect(screen.getByLabelText('Reference photo file')).toHaveProperty('value', '');
  } finally { read.mockRestore(); }
});

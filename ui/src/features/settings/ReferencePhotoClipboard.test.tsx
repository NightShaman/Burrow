import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, fetchApi } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { AgentReferencePhoto } from './AgentReferencePhoto';
vi.mock('../../app/api', () => ({ api: vi.fn(), fetchApi: vi.fn() }));
const endpoint = '/api/operator/reference-image';
async function setup(clipboard?: object) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.mocked(fetchApi).mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['abc']),
  } as Response);
  vi.mocked(api).mockImplementation(async (_path, init) => ({
    ok: true,
    referenceImage:
      init?.method === 'PUT'
        ? {
            id: 'saved',
            attachmentId: 'attachment',
            contentUrl: `${endpoint}/content?id=saved`,
            mimeType: 'image/png',
            fileName: 'photo.png',
            sizeBytes: 3,
            updatedAt: 'now',
          }
        : null,
  }));
  render(
    <ConfirmProvider>
      <UnsavedChangesProvider>
        <AgentReferencePhoto name="Operator" disabled={false} onBusyChange={() => {}} />
      </UnsavedChangesProvider>
    </ConfirmProvider>,
  );
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Paste' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const uploaded = () => vi.mocked(api).mock.calls.find(([, init]) => init?.method === 'PUT');
it('offers a focused keyboard paste target without Clipboard API and sends original bytes', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  const target = screen.getByRole('textbox', { name: 'Paste reference photo' });
  expect(document.activeElement).toBe(target);
  const file = new File(['abc'], 'original.png', { type: 'image/png' });
  fireEvent.paste(target, {
    clipboardData: { items: [{ type: file.type, getAsFile: () => file }] },
  });
  await waitFor(() => expect(uploaded()).toBeTruthy());
  expect(uploaded()?.[0]).toBe(endpoint);
  expect(JSON.parse(String(uploaded()?.[1]?.body))).toEqual({
    fileName: 'original.png',
    content: 'data:image/png;base64,YWJj',
  });
});
it('reads a secure clipboard image without re-encoding', async () => {
  await setup({
    read: async () => [
      { types: ['image/png'], getType: async () => new Blob(['abc'], { type: 'image/png' }) },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  await waitFor(() => expect(uploaded()).toBeTruthy());
  expect(JSON.parse(String(uploaded()?.[1]?.body)).content).toBe('data:image/png;base64,YWJj');
});
it('handles a clipboard with no image and keeps keyboard fallback available', async () => {
  await setup({ read: async () => [] });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'No supported image found on the clipboard.',
  );
  fireEvent.paste(screen.getByRole('textbox', { name: 'Paste reference photo' }), {
    clipboardData: { items: [] },
  });
  expect(screen.getByRole('alert').textContent).toBe('No image found on the clipboard.');
  expect(uploaded()).toBeUndefined();
});
it('offers keyboard fallback after denied clipboard permission', async () => {
  await setup({
    read: async () => {
      throw new Error('denied');
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  expect(await screen.findByRole('textbox', { name: 'Paste reference photo' })).toBe(
    document.activeElement,
  );
  expect(screen.getByRole('alert').textContent).toContain('denied');
});
it('ignores an older clipboard read superseded by a newer Paste click', async () => {
  let resolveFirst!: (items: object[]) => void;
  const first = new Promise<object[]>((resolve) => {
    resolveFirst = resolve;
  });
  const read = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([]);
  await setup({ read });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  await screen.findByRole('alert');
  resolveFirst([
    { types: ['image/png'], getType: async () => new Blob(['old'], { type: 'image/png' }) },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(uploaded()).toBeUndefined();
});
it('ignores a late clipboard result after keyboard paste has saved a newer image', async () => {
  let resolveRead!: (items: object[]) => void;
  await setup({
    read: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  const file = new File(['new'], 'new.png', { type: 'image/png' });
  fireEvent.paste(screen.getByRole('textbox', { name: 'Reference photo file' }), {
    clipboardData: { items: [{ type: file.type, getAsFile: () => file }] },
  });
  await waitFor(() => expect(uploaded()).toBeTruthy());
  resolveRead([
    { types: ['image/png'], getType: async () => new Blob(['old'], { type: 'image/png' }) },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});

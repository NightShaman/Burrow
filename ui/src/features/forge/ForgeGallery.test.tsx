import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { ForgeGallery } from './ForgeGallery';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api, fetchApi: vi.fn() }));
afterEach(() => {
  cleanup();
  api.mockReset();
});
const image = {
  jobId: 'job',
  artifactId: 'art',
  folderId: null as string | null,
  artifact: {
    id: 'art',
    kind: 'image',
    name: 'Portrait',
    mimeType: 'image/png',
    sizeBytes: 10,
    previewUrl: '/preview',
    downloadUrl: '/download',
  },
};
const renderGallery = () =>
  render(
    <ConfirmProvider>
      <ForgeGallery renderArtifact={(artifact) => <img alt={artifact.name} />} />
    </ConfirmProvider>,
  );
it('persists folders/subfolders and moves; remount reads saved placement', async () => {
  const data = {
    folders: [] as { id: string; name: string; parentId: string | null }[],
    images: [structuredClone(image)],
  };
  api.mockImplementation(async (path, init) => {
    if (!init?.method) return structuredClone(data);
    const body = JSON.parse(init.body);
    if (init.method === 'POST') {
      const folder = { id: `folder-${data.folders.length}`, ...body };
      data.folders.push(folder);
      return { folder };
    }
    expect(path).toBe('/api/forge/gallery/images/job/art');
    data.images[0].folderId = body.folderId;
    return { ok: true };
  });
  const view = renderGallery();
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByText('＋ New folder'));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Smatchet' } });
  fireEvent.click(screen.getByText('Create folder'));
  await screen.findByText('Smatchet');
  fireEvent.click(screen.getByLabelText('Move Portrait'));
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'folder-0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move image' }));
  await waitFor(() => expect(screen.queryByAltText('Portrait')).toBeNull());
  fireEvent.click(screen.getByText('Smatchet'));
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByText('＋ New folder'));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Outfits' } });
  fireEvent.click(screen.getByText('Create folder'));
  await screen.findByText('Outfits');
  expect(data.folders[1].parentId).toBe('folder-0');
  view.unmount();
  renderGallery();
  await screen.findByText('Smatchet');
  expect(screen.queryByAltText('Portrait')).toBeNull();
  fireEvent.click(screen.getByText('Smatchet'));
  await screen.findByAltText('Portrait');
});
it('shows load error and retries rather than presenting a successful empty gallery', async () => {
  api
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ folders: [], images: [image] });
  renderGallery();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByText('Retry'));
  await screen.findByAltText('Portrait');
});
it('retains image and dialog on move failure; retries explicitly', async () => {
  api.mockImplementation(async (_path, init) => {
    if (init?.method) throw Error('offline');
    return { folders: [], images: [image] };
  });
  renderGallery();
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByLabelText('Move Portrait'));
  fireEvent.click(screen.getByRole('button', { name: 'Move image' }));
  await screen.findByText('Could not move the image. Please try again.', {
    selector: '.forge-gallery-dialog p',
  });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByAltText('Portrait')).toBeTruthy();
});
it('keeps failed folder creation open and allows retry', async () => {
  api.mockImplementation(async (_path, init) => {
    if (init?.method) throw Error('offline');
    return { folders: [], images: [] };
  });
  renderGallery();
  await waitFor(() => expect(screen.queryByText('Loading media…')).toBeNull());
  fireEvent.click(screen.getByText('＋ New folder'));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Test' } });
  fireEvent.click(screen.getByText('Create folder'));
  await screen.findByText('Could not create the folder. Please try again.', {
    selector: '.forge-gallery-dialog p',
  });
  expect(screen.getByDisplayValue('Test')).toBeTruthy();
});

it('uses the shared Forge themed fields for folder names and move destinations', async () => {
  api.mockResolvedValue({ folders: [], images: [image] });
  renderGallery();
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByText('＋ New folder'));
  const name = screen.getByLabelText('Folder name');
  expect(name.getAttribute('type')).toBe('text');
  expect(name.closest('label')?.classList.contains('forge-field')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByLabelText('Move Portrait'));
  expect(
    screen.getByLabelText('Destination').closest('label')?.classList.contains('forge-field'),
  ).toBe(true);
});

it('confirms artifact-only deletion, retains failures and removes on successful retry', async () => {
  let fail = true;
  api.mockImplementation(async (_path, init) => {
    if (init?.method === 'DELETE') {
      if (fail) throw Error('offline');
      return { ok: true };
    }
    return { folders: [], images: [image] };
  });
  renderGallery();
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByLabelText('Delete Portrait'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByLabelText('Delete Portrait'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await screen.findByRole('alert');
  expect(screen.getByAltText('Portrait')).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByLabelText('Delete Portrait'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByAltText('Portrait')).toBeNull());
  expect(api).toHaveBeenCalledWith(
    '/api/forge/gallery/images/job/art',
    expect.objectContaining({ method: 'DELETE' }),
  );
});
it('passes video media through the shared renderer and allows moving and deleting it', async () => {
  api.mockResolvedValue({
    folders: [],
    images: [
      {
        ...image,
        artifact: { ...image.artifact, kind: 'video', mimeType: 'video/mp4', name: 'Outfit.mp4' },
      },
    ],
  });
  render(
    <ConfirmProvider>
      <ForgeGallery
        renderArtifact={(artifact) =>
          artifact.kind === 'video' ? <video aria-label={artifact.name} controls /> : null
        }
      />
    </ConfirmProvider>,
  );
  await screen.findByLabelText('Outfit.mp4');
  expect(screen.getByLabelText('Move Outfit.mp4')).toBeTruthy();
  expect(screen.getByLabelText('Delete Outfit.mp4')).toBeTruthy();
});

const batchImages = [
  image,
  { ...image, artifactId: 'second', artifact: { ...image.artifact, name: 'Landscape' } },
];
const batchFolders = [{ id: 'folder', name: 'Saved', parentId: null }];

it('selects with checkboxes, cancels without writes and clears selection on navigation', async () => {
  api.mockResolvedValue({ folders: batchFolders, images: batchImages });
  renderGallery();
  await screen.findByAltText('Portrait');
  expect(screen.getByRole('button', { name: 'Move selected' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Portrait' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Landscape' }));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move selected' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Saved/ }));
  expect(screen.getByText('0 selected')).toBeTruthy();
});

it('moves a selection, retains only failed items and retries without replaying successes', async () => {
  let fail = true;
  api.mockImplementation(async (path, init) => {
    if (!init?.method) return { folders: batchFolders, images: batchImages };
    if (path.endsWith('/second') && fail) throw Error('offline');
    return { ok: true };
  });
  renderGallery();
  await screen.findByAltText('Portrait');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Portrait' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Landscape' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move selected' }));
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'folder' } });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await screen.findByText(
    '1 moved; 1 could not be moved. Retry will move only the remaining items.',
  );
  expect(screen.queryByAltText('Portrait')).toBeNull();
  expect(screen.getByAltText('Landscape')).toBeTruthy();
  expect(screen.getByText('1 selected')).toBeTruthy();
  fail = false;
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByAltText('Landscape')).toBeNull();
  const writes = api.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes.map(([path]) => path)).toEqual([
    '/api/forge/gallery/images/job/art',
    '/api/forge/gallery/images/job/second',
    '/api/forge/gallery/images/job/second',
  ]);
  expect(writes.every(([, init]) => JSON.parse(init.body).folderId === 'folder')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Saved/ }));
  await screen.findByAltText('Portrait');
  expect(screen.getByAltText('Landscape')).toBeTruthy();
});

it('locks batch controls while pending and supports moving back to the gallery root', async () => {
  let resolve!: (value: unknown) => void;
  api.mockImplementation(async (_path, init) => {
    if (!init?.method)
      return {
        folders: batchFolders,
        images: batchImages.map((item) => ({ ...item, folderId: 'folder' })),
      };
    return new Promise((done) => {
      resolve = done;
    });
  });
  renderGallery();
  await screen.findByText('Saved');
  fireEvent.click(screen.getByRole('button', { name: /Saved/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Portrait' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move selected' }));
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: '' } });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  expect(screen.getByRole('button', { name: 'Moving…' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByLabelText('Destination').hasAttribute('disabled')).toBe(true);
  resolve({ ok: true });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api).toHaveBeenCalledWith(
    '/api/forge/gallery/images/job/art',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ folderId: null }) }),
  );
});

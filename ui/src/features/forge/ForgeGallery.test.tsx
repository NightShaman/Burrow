import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
  render(<ForgeGallery renderArtifact={(artifact) => <img alt={artifact.name} />} />);
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
  await waitFor(() => expect(screen.queryByText('Loading images…')).toBeNull());
  fireEvent.click(screen.getByText('＋ New folder'));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Test' } });
  fireEvent.click(screen.getByText('Create folder'));
  await screen.findByText('Could not create the folder. Please try again.', {
    selector: '.forge-gallery-dialog p',
  });
  expect(screen.getByDisplayValue('Test')).toBeTruthy();
});

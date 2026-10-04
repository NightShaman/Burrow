import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactOutput } from './ForgePage';
import { useOwnedApi } from '../../app/useOwnedApi';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ fetchApi: request }));
const artifact = { id: 'first', kind: 'image', name: 'small.png', mimeType: 'image/png', sizeBytes: 3, previewUrl: '/media/first', downloadUrl: '/media/first' };
function Fixture({ file = artifact }) {
  const owned = useOwnedApi();
  return <ArtifactOutput artifact={file} fetchMedia={owned.fetch} />;
}
beforeEach(() => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:small'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  request.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const success = () => ({ ok: true, blob: async () => new Blob(['abc']) });
it('reports the first failed preview and retries successfully without duplicate eager downloads', async () => {
  request.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(success());
  const view = render(<Fixture />);
  await screen.findByText('Preview failed.');
  expect(screen.queryByText('Loading preview…')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
  await screen.findByRole('img', { name: 'small.png' });
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:small');
});
it('does not fetch download-only output eagerly; click and retry retain the captured owner', async () => {
  request.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(success());
  const file = { ...artifact, previewUrl: '', downloadUrl: '/media/download' };
  const view = render(<Fixture file={file} />);
  expect(request).not.toHaveBeenCalled();
  view.rerender(<Fixture file={file} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await screen.findByText('Download failed.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry download' }));
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledTimes(2);
  for (const call of request.mock.calls) { expect(call[0]).toBe('/media/download'); }
});
it('fetches a distinct download only on demand', async () => {
  request.mockImplementation(async () => success());
  render(<Fixture file={{ ...artifact, downloadUrl: '/media/original' }} />);
  await screen.findByRole('img', { name: 'small.png' });
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1][0]).toBe('/media/original');
});

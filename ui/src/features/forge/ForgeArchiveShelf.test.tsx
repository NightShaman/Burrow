import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ForgeArchiveShelf } from './ForgeArchiveShelf';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const record = { id: 'run-1', jobId: 'job-1', connectionId: 'c1', modelId: 'image-maker', mode: 'image', kind: 'image', prompt: 'Long retained castle prompt', status: 'succeeded', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:01:00Z', deletedAt: '2026-10-25T12:02:00Z', agentId: 'a1', calls: [{ operation: 'generate' }], outcome: { status: 'succeeded', artifactCount: 1 } };
function shelf(props = {}) { return <ForgeArchiveShelf agents={[]} selectedAgent="" selectedDate="" search="" onDates={vi.fn()} {...props} />; }
it('shows retained prompt/calls/outcome without media links or delete controls', async () => {
  api.mockResolvedValue({ records: [record] }); render(shelf());
  fireEvent.click(await screen.findByRole('button', { name: /image-maker/ }));
  expect(screen.getByText('Long retained castle prompt', { selector: '.forge-evidence-prompt' })).toBeTruthy();
  expect(screen.getByText(/"operation": "generate"/)).toBeTruthy();
  expect(screen.getByText(/"artifactCount": 1/)).toBeTruthy();
  expect(screen.getByText(/Job and media deleted from Forge/)).toBeTruthy();
  expect(document.querySelector('img,audio,video,a[download]')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Delete creation$/ })).toBeNull();
});
it('filters search, date and agent and updates calendar availability', async () => {
  api.mockResolvedValue({ records: [record] }); const onDates = vi.fn();
  const view = render(shelf({ search: 'castle', onDates }));
  await screen.findByRole('button', { name: /image-maker/ });
  expect(onDates).toHaveBeenCalledWith([expect.stringMatching(/^2026-10-/)]);
  for (const filter of [{ search: 'no match' }, { selectedDate: '2020-01-01' }, { selectedAgent: 'other' }]) {
    view.rerender(shelf(filter)); expect(screen.getByText('No Forge runs match.')).toBeTruthy();
  }
});
it('recovers from failed evidence request', async () => {
  api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ records: [record] });
  render(shelf()); await screen.findByText('Could not load Forge evidence: offline');
  fireEvent.click(screen.getByRole('button', { name: 'Retry Forge evidence' }));
  await screen.findByRole('button', { name: /image-maker/ });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ModArchiveHost } from './ModArchiveHost';

const { mountArchive } = vi.hoisted(() => ({ mountArchive: vi.fn() }));
vi.mock('./ModPanelHost', () => ({ mountArchive }));

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
describe('mod panel host', () => {
  it('isolates a failed control module and keeps the main app usable', async () => {
    render(<ModArchiveHost date="2026-09-23" panel={{ modId: 'missing-mod', name: 'Missing Mod', archiveUrl: '/api/mods/missing-mod/ui/control.js' }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load|failed|fetch|unknown|cannot find module/i);
    expect(screen.getByText('Missing Mod unavailable')).toBeTruthy();
  });
});

const panel = { modId: 'example', name: 'Example', archiveUrl: './ModPanelHost' };
it('updates date context without unmounting and cleans up on identity change/unmount', async () => {
  const update = vi.fn(), unmount = vi.fn();
  mountArchive.mockReturnValue({ update, unmount });
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  expect(mountArchive.mock.calls[0][0].runtimeScope).toBe('local');
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-22', modId: 'example' })));
  expect(mountArchive).toHaveBeenCalledTimes(1); expect(unmount).not.toHaveBeenCalled();
  view.rerender(<ModArchiveHost panel={{ ...panel, modId: 'other' }} date="2026-09-22" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(2));
  expect(unmount).toHaveBeenCalledTimes(1);
  view.unmount(); expect(unmount).toHaveBeenCalledTimes(2);
});
it('keeps legacy cleanup-only mounts date-aware via remount', async () => {
  const unmount = vi.fn(); mountArchive.mockReturnValue(unmount);
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(2));
  expect(unmount).toHaveBeenCalledTimes(1);
  expect(mountArchive.mock.calls[1][0].date).toBe('2026-09-22');
});
it('delivers the latest date when an asynchronous mount finishes', async () => {
  let resolve!: (result: unknown) => void;
  const update = vi.fn(), unmount = vi.fn();
  mountArchive.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  resolve({ update, unmount });
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-22' })));
  expect(mountArchive).toHaveBeenCalledTimes(1);
});

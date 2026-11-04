import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModArchiveHost } from './ModArchiveHost';

const { mountArchive, apiLocal } = vi.hoisted(() => ({ mountArchive: vi.fn(), apiLocal: vi.fn() }));
vi.mock('../../app/api', () => ({ apiLocal }));
vi.mock('./ModPanelHost', () => ({ mountArchive }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
describe('mod panel host', () => {
  it('isolates a failed control module and keeps the main app usable', async () => {
    render(
      <ModArchiveHost
        date="2026-09-23"
        panel={{
          modId: 'missing-mod',
          name: 'Missing Mod',
          archiveUrl: '/api/mods/missing-mod/ui/control.js',
        }}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not load|failed|fetch|unknown|cannot find module/i,
    );
    expect(screen.getByText('Missing Mod unavailable')).toBeTruthy();
  });
});

const panel = { modId: 'example', name: 'Example', archiveUrl: './ModPanelHost' };
it('updates date context without unmounting and cleans up on identity change/unmount', async () => {
  const update = vi.fn(),
    unmount = vi.fn();
  mountArchive.mockReturnValue({ update, unmount });
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  expect(mountArchive.mock.calls[0][0].runtimeScope).toBe('local');
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-09-22', modId: 'example' }),
    ),
  );
  expect(mountArchive).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  view.rerender(<ModArchiveHost panel={{ ...panel, modId: 'other' }} date="2026-09-22" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(2));
  expect(unmount).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(unmount).toHaveBeenCalledTimes(2);
});
it('keeps legacy cleanup-only mounts date-aware via remount', async () => {
  const unmount = vi.fn();
  mountArchive.mockReturnValue(unmount);
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(2));
  expect(unmount).toHaveBeenCalledTimes(1);
  expect(mountArchive.mock.calls[1][0].date).toBe('2026-09-22');
});
it('delivers the latest date when an asynchronous mount finishes', async () => {
  let resolve!: (result: unknown) => void;
  const update = vi.fn(),
    unmount = vi.fn();
  mountArchive.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<ModArchiveHost panel={panel} date="2026-09-23" />);
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  view.rerender(<ModArchiveHost panel={panel} date="2026-09-22" />);
  resolve({ update, unmount });
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-22' })),
  );
  expect(mountArchive).toHaveBeenCalledTimes(1);
});

it('delivers explicit timezone on mount and updates timezone without losing the selected date', async () => {
  const update = vi.fn(),
    unmount = vi.fn();
  mountArchive.mockReturnValue({ update, unmount });
  const view = render(
    <ModArchiveHost panel={panel} date="2026-11-01" timeZone="America/New_York" />,
  );
  await waitFor(() => expect(mountArchive).toHaveBeenCalledTimes(1));
  expect(mountArchive.mock.calls[0][0]).toMatchObject({
    date: '2026-11-01',
    timeZone: 'America/New_York',
  });
  view.rerender(<ModArchiveHost panel={panel} date="2026-11-01" timeZone="Pacific/Auckland" />);
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-11-01', timeZone: 'Pacific/Auckland' }),
    ),
  );
  expect(mountArchive).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
});

it('owns opt-in header filters and preserves them while a participant roster refreshes', async () => {
  const headerRoot = document.createElement('div');
  document.body.append(headerRoot);
  const update = vi.fn();
  let context: any;
  mountArchive.mockImplementation((ctx) => {
    context = ctx;
    ctx.configureHeader({
      categories: [
        { id: 'gifts', label: 'Gifts' },
        { id: 'dreams', label: 'Mod dreams' },
      ],
      participants: [],
      participantsDisabled: true,
      participantsStatus: 'Loading participants',
      searchMaxLength: 500,
    });
    return { update };
  });
  const view = render(<ModArchiveHost panel={panel} date="2026-11-03" headerRoot={headerRoot} />);
  await waitFor(() =>
    expect(
      within(headerRoot).getByRole('button', { name: 'Gifts' }).getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  const input = within(headerRoot).getByRole('searchbox') as HTMLInputElement;
  expect(input.maxLength).toBe(500);
  expect((within(headerRoot).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'coin' } });
  fireEvent.click(within(headerRoot).getByRole('button', { name: 'Mod dreams' }));
  context.configureHeader({
    categories: [
      { id: 'gifts', label: 'Gifts' },
      { id: 'dreams', label: 'Mod dreams' },
    ],
    participants: [{ id: 'older', label: 'Older participant' }],
  });
  await waitFor(() =>
    expect((within(headerRoot).getByRole('combobox') as HTMLSelectElement).disabled).toBe(false),
  );
  expect(input.value).toBe('coin');
  expect(
    within(headerRoot).getByRole('button', { name: 'Mod dreams' }).getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.change(within(headerRoot).getByRole('combobox'), { target: { value: 'older' } });
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        date: '2026-11-03',
        filters: { search: 'coin', participantId: 'older', category: 'dreams' },
      }),
    ),
  );
  expect(mountArchive).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.archive-mod-integrated')).toBeTruthy();
  view.unmount();
  context.configureHeader({ categories: [], participants: [] });
  expect(headerRoot.textContent).toBe('');
  headerRoot.remove();
});

it('ignores late header configuration from an unmounted async module', async () => {
  const headerRoot = document.createElement('div');
  document.body.append(headerRoot);
  let context: any, resolve!: (value: unknown) => void;
  mountArchive.mockImplementation((ctx) => {
    context = ctx;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const view = render(<ModArchiveHost panel={panel} date="" headerRoot={headerRoot} />);
  await waitFor(() => expect(context).toBeTruthy());
  view.unmount();
  context.configureHeader({ categories: [{ id: 'late', label: 'Late' }], participants: [] });
  resolve({ unmount: vi.fn() });
  await new Promise((r) => setTimeout(r, 0));
  expect(headerRoot.textContent).toBe('');
  headerRoot.remove();
});

it('resets filters synchronously on a new mod and removes controls for legacy mods', async () => {
  const headerRoot = document.createElement('div');
  document.body.append(headerRoot);
  const contexts: any[] = [];
  mountArchive.mockImplementation((ctx) => {
    contexts.push({ ...ctx, filters: { ...ctx.filters } });
    if (ctx.modId !== 'legacy')
      ctx.configureHeader({ categories: [{ id: 'one', label: ctx.modId }], participants: [] });
    return { update: vi.fn() };
  });
  const view = render(<ModArchiveHost panel={panel} date="" headerRoot={headerRoot} />);
  await waitFor(() => expect(within(headerRoot).getByRole('searchbox')).toBeTruthy());
  fireEvent.change(within(headerRoot).getByRole('searchbox'), {
    target: { value: 'first-mod-only' },
  });
  view.rerender(
    <ModArchiveHost panel={{ ...panel, modId: 'second' }} date="" headerRoot={headerRoot} />,
  );
  await waitFor(() => expect(contexts).toHaveLength(2));
  expect(contexts[1].filters).toEqual({ search: '', participantId: '', category: '' });
  contexts[0].configureHeader({ categories: [{ id: 'stale', label: 'Stale' }], participants: [] });
  expect(within(headerRoot).queryByRole('button', { name: 'Stale' })).toBeNull();
  view.rerender(
    <ModArchiveHost panel={{ ...panel, modId: 'legacy' }} date="" headerRoot={headerRoot} />,
  );
  await waitFor(() => expect(contexts).toHaveLength(3));
  expect(headerRoot.textContent).toBe('');
  expect(document.querySelector('.archive-mod-integrated')).toBeNull();
  view.unmount();
  headerRoot.remove();
});

it('retains filters through cleanup-only opt-in remounts without a registration loop', async () => {
  const headerRoot = document.createElement('div');
  document.body.append(headerRoot);
  mountArchive.mockImplementation((ctx) => {
    ctx.configureHeader({ categories: [{ id: 'one', label: 'One' }], participants: [] });
    return vi.fn();
  });
  const view = render(<ModArchiveHost panel={panel} date="" headerRoot={headerRoot} />);
  await waitFor(() => expect(within(headerRoot).getByRole('searchbox')).toBeTruthy());
  fireEvent.change(within(headerRoot).getByRole('searchbox'), { target: { value: 'preserved' } });
  await waitFor(() =>
    expect((within(headerRoot).getByRole('searchbox') as HTMLInputElement).value).toBe('preserved'),
  );
  const count = mountArchive.mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(mountArchive.mock.calls.length).toBe(count);
  expect(count).toBeLessThan(5);
  view.unmount();
  headerRoot.remove();
});

it('cannot resurrect header controls after async mount rejection', async () => {
  const headerRoot = document.createElement('div');
  document.body.append(headerRoot);
  let context: any;
  mountArchive.mockImplementation(async (ctx) => {
    context = ctx;
    ctx.configureHeader({ categories: [{ id: 'one', label: 'One' }], participants: [] });
    throw new Error('Rejected mount');
  });
  const view = render(<ModArchiveHost panel={panel} date="" headerRoot={headerRoot} />);
  await screen.findByRole('alert');
  context.configureHeader({ categories: [{ id: 'late', label: 'Late' }], participants: [] });
  await new Promise((r) => setTimeout(r, 0));
  expect(headerRoot.textContent).toBe('');
  view.unmount();
  headerRoot.remove();
});

it('accepts literal search punctuation without relaxing scoped API path checks', async () => {
  let context: any;
  apiLocal.mockResolvedValue({ ok: true });
  mountArchive.mockImplementation((ctx) => {
    context = ctx;
    return {};
  });
  render(<ModArchiveHost panel={panel} date="" />);
  await waitFor(() => expect(context).toBeTruthy());
  await context.api('/archive/gifts?search=hello..');
  expect(apiLocal).toHaveBeenCalledWith(
    '/api/mods/example/archive/gifts?search=hello..',
    undefined,
  );
  for (const path of [
    '/../secret',
    '/%2e%2e/secret',
    '/archive%2fgifts',
    '/archive\\secret',
    '/archive?search=word#fragment',
  ])
    await expect(context.api(path)).rejects.toThrow('Invalid mod API path');
  expect(apiLocal).toHaveBeenCalledTimes(1);
});

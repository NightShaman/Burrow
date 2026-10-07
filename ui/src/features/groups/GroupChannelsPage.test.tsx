import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, fetchApi } from '../../app/api';
import { GroupChannelsPage } from './GroupChannelsPage';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
  fetchApi: vi.fn(async () => { throw new Error('test download unavailable'); }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the persisted session-store time for historical group turns, not Now', async () => {
  const ts = '2026-09-22T14:23:00.000Z';
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/settings/identities') return {};
    return {
      ok: true,
      channel: { id: 'room-1', name: 'Group room', participantAgentIds: [] },
      turns: [
        { id: 'old', type: 'message', role: 'user', content: 'Last night', ts, createdAt: '2026-09-23T10:00:00.000Z', metadata: { kind: 'group-channel', sender: 'operator' } },
        { id: 'missing', type: 'message', role: 'agent', content: 'Missing date', metadata: { kind: 'group-channel', fromAgentName: 'Smatchet' } },
        { id: 'invalid', type: 'message', role: 'agent', content: 'Invalid date', ts: 'not-a-date', metadata: { kind: 'group-channel', fromAgentName: 'Smatchet' } },
      ],
      runs: [],
    };
  });

  render(<GroupChannelsPage channelId="room-1" agents={[]} />);
  await waitFor(() => expect(screen.getByText('Last night')).toBeTruthy());

  const expectedTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts)).toUpperCase();
  expect(within(screen.getByText('Last night').closest('article')!).getByText((_, element) => element?.tagName === 'SMALL' && element.textContent?.includes(expectedTime) === true)).toBeTruthy();
  for (const content of ['Missing date', 'Invalid date']) {
    expect(within(screen.getByText(content).closest('article')!).getByText(/TIME UNAVAILABLE/)).toBeTruthy();
  }
  expect(screen.queryByText(/· NOW/)).toBeNull();
});


it('FE017 accepts slow responses without overlapping polls', async () => {
  let tick!: () => void;
  const timer = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => { if (delay === 2_000) tick = callback as () => void; return 123; });
  let finishOld!: (value: unknown) => void;
  let reads = 0;
  const payload = (content: string) => ({ channel: { id: 'room-1', name: 'Group room', participantAgentIds: [] }, turns: [{ type: 'message', role: 'user', content }], runs: [] });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/settings/identities') return {};
    reads++;
    if (reads === 2) return new Promise(resolve => { finishOld = resolve; });
    return payload(reads === 1 ? 'Initial idle' : 'External new message');
  });
  try {
    render(<GroupChannelsPage channelId="room-1" agents={[]} />);
    await screen.findByText('Initial idle');
    await act(async () => { tick(); });
    await act(async () => { tick(); });
    expect(reads).toBe(2);
    await act(async () => { finishOld(payload('Slow successful message')); });
    await screen.findByText('Slow successful message');
    await act(async () => { tick(); });
    expect(screen.getByText('External new message')).toBeTruthy();
    expect(reads).toBe(3);
  } finally { timer.mockRestore(); }
});

it('clears only the submitted group draft when a delayed send succeeds', async () => {
  let resolveSend!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/settings/identities') return {};
    if (init?.method === 'POST') return new Promise(resolve => { resolveSend = resolve; });
    return { channel: { id: 'room-1', name: 'Group room', participantAgentIds: [] }, turns: [], runs: [] };
  });
  render(<GroupChannelsPage channelId="room-1" agents={[]} />);
  const composer = await screen.findByPlaceholderText('Message the group…');
  await act(async () => { composer.focus(); });
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(composer, { target: { value: 'submitted draft' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  fireEvent.change(composer, { target: { value: 'next unsent draft' } });
  await act(async () => { resolveSend({ ok: true }); });
  expect((composer as HTMLTextAreaElement).value).toBe('next unsent draft');
});

it('fences a delayed send completion from a newly navigated group', async () => {
  let resolveSend!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/settings/identities') return {};
    if (init?.method === 'POST') return new Promise(resolve => { resolveSend = resolve; });
    const id = String(path).includes('room-2') ? 'room-2' : 'room-1';
    return { channel: { id, name: id, participantAgentIds: [] }, turns: [], runs: [] };
  });
  const view = render(<GroupChannelsPage channelId="room-1" agents={[]} />);
  const composer = await screen.findByPlaceholderText('Message the group…');
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(composer, { target: { value: 'room one' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  view.rerender(<GroupChannelsPage channelId="room-2" agents={[]} />);
  const roomTwoComposer = await screen.findByPlaceholderText('Message the group…');
  fireEvent.change(roomTwoComposer, { target: { value: 'room two draft' } });
  await act(async () => { resolveSend({ ok: true }); });
  expect((roomTwoComposer as HTMLTextAreaElement).value).toBe('room two draft');
});

it('aborts hanging polling at its deadline and recovers on the next interval', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/settings/identities') return {};
    if (++reads === 1) return new Promise((_, reject) => {
      signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    });
    return { channel: { id: 'room-1', turns: [{ role: 'user', content: 'Recovered' }] } };
  });
  try {
    render(<GroupChannelsPage channelId="room-1" agents={[]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(reads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText('Recovered')).toBeTruthy();
  } finally { cleanup(); vi.useRealTimers(); }
});

it('reload renders persisted original and generated files with their storage owner', async () => {
  vi.mocked(api).mockResolvedValue({ channel: { id: 'room-1', turns: [
    { role: 'user', metadata: { attachmentAgentId: 'storage-owner', attachments: [{ name: 'original.txt', type: 'text/plain', artifactPath: 'attachments/original.txt' }] } },
    { role: 'agent', metadata: { fromAgentId: 'participant', outputArtifacts: [{ kind: 'file', name: 'result.txt', storageReference: 'artifacts/result.txt' }] } },
  ] } });
  for (let reload = 0; reload < 2; reload++) {
    const view = render(<GroupChannelsPage channelId="room-1" agents={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download original.txt' }));
    fireEvent.click(within(screen.getByRole('region', { name: '1 generated artifact' })).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(vi.mocked(fetchApi).mock.calls.length).toBe((reload + 1) * 2));
    expect(vi.mocked(fetchApi).mock.calls[reload * 2][0]).toContain('/storage-owner/');
    expect(vi.mocked(fetchApi).mock.calls[reload * 2 + 1][0]).toContain('/participant/');
    view.unmount();
  }
});

it.each([false, true])('submits attachment-only files and clears only with persistence receipt (%s)', async (confirmed) => {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/settings/identities') return {};
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body.message).toBe('Please analyze the attached files.');
      expect(body.attachments[0]).toMatchObject({ name: 'input.txt', type: 'text/plain', encoding: 'data-url' });
      return { ok: true, operatorTurn: { metadata: { attachments: confirmed ? [{ name: 'input.txt', artifactPath: 'attachments/input.txt' }] : [] } } };
    }
    return { channel: { id: 'room-1', turns: [] } };
  });
  render(<GroupChannelsPage channelId="room-1" agents={[]} />);
  await screen.findByPlaceholderText('Message the group…');
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['hello'], 'input.txt', { type: 'text/plain' })] } });
  await screen.findByRole('button', { name: 'Remove input.txt' });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => {
    if (confirmed) expect(screen.queryByRole('button', { name: 'Remove input.txt' })).toBeNull();
    else expect(screen.getByText(/server did not confirm attachment persistence/)).toBeTruthy();
  });
  if (!confirmed) expect(screen.getByRole('button', { name: 'Remove input.txt' })).toBeTruthy();
});

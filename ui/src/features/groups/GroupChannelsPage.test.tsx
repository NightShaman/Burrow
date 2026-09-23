import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget } from '../../app/apiTargets';
import { GroupChannelsPage } from './GroupChannelsPage';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the persisted session-store time for historical group turns, not Now', async () => {
  const ts = '2026-09-22T14:23:00.000Z';
  vi.mocked(apiForTarget).mockImplementation(async (_target, path) => {
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

  render(<GroupChannelsPage channelId="room-1" target={localApiTarget} agents={[]} />);
  await waitFor(() => expect(screen.getByText('Last night')).toBeTruthy());

  const expectedTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts)).toUpperCase();
  expect(within(screen.getByText('Last night').closest('article')!).getByText((_, element) => element?.tagName === 'SMALL' && element.textContent?.includes(expectedTime) === true)).toBeTruthy();
  for (const content of ['Missing date', 'Invalid date']) {
    expect(within(screen.getByText(content).closest('article')!).getByText(/TIME UNAVAILABLE/)).toBeTruthy();
  }
  expect(screen.queryByText(/· NOW/)).toBeNull();
});

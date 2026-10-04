import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { GroupChannelsPage } from './GroupChannelsPage';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('discovers external messages from an idle group on recurring refresh', async () => {
  vi.useFakeTimers(); let count = 0;
  vi.mocked(api).mockImplementation(async (path) => path === '/api/settings/identities' ? {} : { channel: { id: 'idle', name: 'Idle', participantAgentIds: [], runs: [], turns: ++count > 1 ? [{ id: 'external', content: 'External message' }] : [] } });
  await act(async () => { render(<GroupChannelsPage channelId="idle" agents={[]} />); });
  expect(screen.queryByText('External message')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('External message')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(count).toBe(3);
});
it('ignores a response from a group that is no longer open', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/settings/identities') return {};
    if (path.endsWith('/old')) return await new Promise(resolve => { finish = resolve; });
    return { channel: { id: 'new', name: 'New room', turns: [{ id: 'new-message', content: 'Current message' }], runs: [] } };
  });
  const view = render(<GroupChannelsPage channelId="old" agents={[]} />);
  await act(async () => { view.rerender(<GroupChannelsPage channelId="new" agents={[]} />); });
  await act(async () => { finish({ channel: { id: 'old', name: 'Obsolete room', turns: [{ id: 'old-message', content: 'Obsolete message' }], runs: [] } }); });
  expect(screen.queryByText('Obsolete message')).toBeNull();
  expect(screen.getByText('Current message')).toBeTruthy();
});

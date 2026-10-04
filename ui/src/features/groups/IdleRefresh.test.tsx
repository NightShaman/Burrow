import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget } from '../../app/apiTargets';
import { GroupChannelsPage } from './GroupChannelsPage';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), apiForTarget: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('discovers external messages from an idle group on recurring refresh', async () => {
  vi.useFakeTimers(); let count = 0;
  vi.mocked(apiForTarget).mockImplementation(async (_target, path) => path === '/api/settings/identities' ? {} : { channel: { id: 'idle', name: 'Idle', participantAgentIds: [], runs: [], turns: ++count > 1 ? [{ id: 'external', content: 'External message' }] : [] } });
  await act(async () => { render(<GroupChannelsPage channelId="idle" target={localApiTarget} agents={[]} />); });
  expect(screen.queryByText('External message')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('External message')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(count).toBe(3);
});
it('ignores a response from a group that is no longer open', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(apiForTarget).mockImplementation(async (_target, path) => {
    if (path === '/api/settings/identities') return {};
    if (path.endsWith('/old')) return await new Promise(resolve => { finish = resolve; });
    return { channel: { id: 'new', name: 'New room', turns: [{ id: 'new-message', content: 'Current message' }], runs: [] } };
  });
  const view = render(<GroupChannelsPage channelId="old" target={localApiTarget} agents={[]} />);
  await act(async () => { view.rerender(<GroupChannelsPage channelId="new" target={localApiTarget} agents={[]} />); });
  await act(async () => { finish({ channel: { id: 'old', name: 'Obsolete room', turns: [{ id: 'old-message', content: 'Obsolete message' }], runs: [] } }); });
  expect(screen.queryByText('Obsolete message')).toBeNull();
  expect(screen.getByText('Current message')).toBeTruthy();
});

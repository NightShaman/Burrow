import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus, accountUsageStatus, type AccountUsageCard } from './AccountStatus';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { OpenAiResets } from './OpenAiResets';

const server = Date.parse('2026-11-12T00:00:00Z');
const iso = (offset = 0) => new Date(server + offset).toISOString();
const provider = {
  id: 'clock-integration',
  provider: 'OpenAI',
  url: 'https://openai.com',
  apiType: 'openai-responses',
  apiKey: '',
  models: [],
  oauthConfigured: true,
};
const status = {
  status: 'available',
  label: 'Active',
  reason: 'usage_available',
  scope: 'account',
  checkedAt: iso(),
  resetAt: null,
};
const base: AccountUsageCard = {
  id: 'clock',
  name: 'OpenAI',
  vendor: 'OpenAI',
  plan: null,
  state: 'ready',
  bars: [],
  accountStatus: status,
  clock: { serverMs: server, receivedAt: 100 },
};
const credits = {
  ok: true,
  fetchedAt: iso(),
  credits: {
    availableCount: 1,
    nearestExpiresAt: iso(1_800_000),
    available: [{ id: 'credit', expiresAt: iso(1_800_000) }],
  },
};
function mockResponses() {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.includes('reset-credits')
          ? credits
          : {
              usage: {
                accountStatus: status,
                windows: [
                  { key: 'primary', label: 'Primary', usedPercent: 20, resetAt: iso(3_600_000) },
                ],
              },
            },
        { headers: { date: new Date(server).toUTCString() } },
      ),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([-3_600_000, 3_600_000])(
  'renders fresh accounts, reset credits and countdowns with offset %s',
  async (offset) => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(server + offset);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    mockResponses();
    const first = render(
      <ConfirmProvider>
        <AccountStatus providers={[provider]} />
      </ConfirmProvider>,
    );
    await screen.findByText('Available');
    await screen.findByText('1 banked');
    expect(screen.getByText('1h')).toBeTruthy();
    wall.mockReturnValue(server - offset);
    first.rerender(
      <ConfirmProvider>
        <AccountStatus providers={[provider]} />
      </ConfirmProvider>,
    );
    expect(screen.getByText('Available')).toBeTruthy();
    first.unmount();
    // No new response: cached status must keep its original monotonic time anchor.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    render(
      <ConfirmProvider>
        <AccountStatus providers={[provider]} />
      </ConfirmProvider>,
    );
    expect(screen.getByText('Available')).toBeTruthy();
  },
);
it('ages cached status and expires restrictions using elapsed time, retaining actual restrictions', () => {
  vi.spyOn(Date, 'now').mockReturnValue(server + 86_400_000);
  expect(accountUsageStatus(base, 100).label).toBe('Available');
  expect(accountUsageStatus(base, 600_100).label).toBe('Available');
  expect(accountUsageStatus(base, 600_101).label).toBe('Stale');
  expect(
    accountUsageStatus({ ...base, accountStatus: { ...status, checkedAt: iso(-660_000) } }, 100)
      .label,
  ).toBe('Stale');
  const limited = {
    ...base,
    accountStatus: {
      ...status,
      status: 'rate_limited',
      label: 'Rate Limited',
      resetAt: iso(60_000),
    },
  };
  expect(accountUsageStatus(limited, 100).label).toBe('Rate Limited');
  expect(accountUsageStatus(limited, 60_100).label).toBe('Stale');
  expect(accountUsageStatus({ ...base, clock: null }, 100).label).toBe('Unknown');
  expect(accountUsageStatus({ ...base, state: 'error' }, 100).label).toBe('Usage unavailable');
});
it('timer aging does not depend on wall-clock jumps', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(100);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(server + 3_600_000);
  mockResponses();
  render(
    <ConfirmProvider>
      <AccountStatus providers={[{ ...provider, id: 'timer-clock' }]} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  expect(screen.getByText('Available')).toBeTruthy();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  elapsed.mockReturnValue(600_101);
  wall.mockReturnValue(server - 3_600_000);
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(screen.getByText('Stale')).toBeTruthy();
});
it('a clock jump while confirming does not block a valid reset', async () => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(server + 3_600_000);
  vi.spyOn(performance, 'now').mockReturnValue(100);
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
    Response.json(
      init?.method === 'POST'
        ? { ok: true, code: 'reset', usageRefresh: { ok: true }, creditsRefresh: credits }
        : credits,
      { headers: { date: new Date(server).toUTCString() } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ConfirmProvider>
      <OpenAiResets connectionId="confirm-clock" name="OpenAI" onUsageRefresh={vi.fn()} />
    </ConfirmProvider>,
  );
  await screen.findByText('1 banked');
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }));
  await screen.findByRole('alertdialog');
  wall.mockReturnValue(server + 86_400_000);
  fireEvent.click(screen.getByRole('button', { name: 'Consume one reset' }));
  await waitFor(() => expect(screen.getByText('Reset used.')).toBeTruthy());
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

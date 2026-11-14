import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus, accountUsageStatus, useAccountUsage } from './AccountStatus';
import { ConfirmProvider } from '../../app/ConfirmDialog';

const server = Date.parse('2026-11-14T15:00:00Z');
const usage = {
  windows: [
    { key: 'five_hour', usedPercent: 20, resetAt: new Date(server + 3600_000).toISOString() },
  ],
};
const body = (age = 0) => ({
  ok: true,
  usage,
  fetchedAt: new Date(server - age).toISOString(),
  serverTime: new Date(server).toISOString(),
  sampleAgeMs: age,
  lastSuccess: { usage, fetchedAt: new Date(server - age).toISOString() },
});
const failure = (age: number | null = 240_000) => ({
  ...body(age ?? 0),
  ok: false,
  usage: null,
  sampleAgeMs: age,
  fetchedAt: age === null ? null : body(age).fetchedAt,
  lastSuccess: age === null ? null : body(age).lastSuccess,
  error: 'anthropic_oauth_usage_failed:429',
  lastError: {
    status: 429,
    error: 'anthropic_oauth_usage_failed:429',
    at: new Date(server).toISOString(),
  },
  retryAfterMs: 60_000,
});
const provider = (id: string) => ({
  id,
  provider: 'Anthropic',
  apiType: 'anthropic-messages',
  url: '',
  apiKey: '',
  models: [],
  oauthConfigured: true,
});
function respond(value: unknown, status = 200) {
  const fetcher = vi.fn(async () =>
    Response.json(value, { status, headers: { date: new Date(server).toUTCString() } }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function setup() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockReturnValue(100);
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses retained usage on initial 429 without transport warnings, telemetry or false quota restriction', async () => {
  setup();
  respond(failure(), 429);
  render(
    <ConfirmProvider>
      <AccountStatus providers={[provider('initial-429')]} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  expect(screen.getByText('80%')).toBeTruthy();
  expect(screen.getByText('Available')).toBeTruthy();
  expect(screen.queryByText(/Usage rate limited|Updated|retry in/)).toBeNull();
  expect(screen.queryByText('anthropic_oauth_usage_failed:429')).toBeNull();
  expect(screen.queryByText('Limit Exceeded')).toBeNull();
  expect(screen.getByText('1h')).toBeTruthy();
});
it('does not invent percentage or sample time when a throttled account has never succeeded', async () => {
  setup();
  respond(failure(null), 429);
  render(
    <ConfirmProvider>
      <AccountStatus providers={[provider('empty-429')]} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.queryByText(/Usage rate limited|Updated|retry in/)).toBeNull();
  expect(screen.queryByText('Available')).toBeNull();
  expect(screen.queryByText('80%')).toBeNull();
});
it('ages server-reported samples monotonically and recovers at the next 30-second poll', async () => {
  setup();
  vi.spyOn(Date, 'now').mockReturnValue(server + 86_400_000);
  const fetcher = respond(body());
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(100);
  const view = renderHook(() => useAccountUsage([provider('age-and-recover')]));
  await act(async () => {});
  expect(accountUsageStatus(view.result.current[0], 30_099).label).toBe('Available');
  expect(accountUsageStatus(view.result.current[0], 30_100).label).toBe('Available');
  fetcher.mockImplementation(async () => Response.json(failure(), { status: 429 }));
  elapsed.mockReturnValue(30_100);
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(accountUsageStatus(view.result.current[0], 90_100).label).toBe('Available');
  fetcher.mockImplementation(async () => Response.json(body()));
  elapsed.mockReturnValue(90_100);
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(accountUsageStatus(view.result.current[0], 90_100).label).toBe('Available');
  expect(view.result.current[0].rateLimited).toBe(false);
  expect(view.result.current[0].retry).toBeNull();
});
it('preserves sample and clock on network failure and rate-limit state across remounts', async () => {
  setup();
  respond(failure(), 429);
  const p = [provider('remount-429')];
  const first = renderHook(() => useAccountUsage(p));
  await act(async () => {});
  first.unmount();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  const second = renderHook(() => useAccountUsage(p));
  expect(second.result.current[0].state).toBe('error');
  expect(second.result.current[0].rateLimited).toBe(true);
  second.unmount();
  respond(body());
  const third = renderHook(() => useAccountUsage(p));
  await act(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('offline');
    }),
  );
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(third.result.current[0].bars[0].remainingPercent).toBe(80);
  expect(third.result.current[0].clock?.serverMs).toBe(server);
  expect(accountUsageStatus(third.result.current[0]).label).toBe('Available');
});
it('accepts old backend fetchedAt with HTTP server clock but never uses PC wall time', async () => {
  setup();
  vi.spyOn(Date, 'now').mockReturnValue(server - 86_400_000);
  respond({ usage, fetchedAt: new Date(server - 180_000).toISOString() });
  const view = renderHook(() => useAccountUsage([provider('old-backend')]));
  await act(async () => {});
  expect(accountUsageStatus(view.result.current[0]).label).toBe('Available');
});
it('missing age does not override known account usage with a polling status', async () => {
  setup();
  respond({ usage });
  const view = renderHook(() => useAccountUsage([provider('unknown-age')]));
  await act(async () => {});
  expect(accountUsageStatus(view.result.current[0]).label).toBe('Available');
});
it('clears retained state when the server explicitly has no sample for a rebound connection', async () => {
  setup();
  const fetcher = respond(body());
  const view = renderHook(() => useAccountUsage([provider('rebound')]));
  await act(async () => {});
  fetcher.mockImplementation(async () => Response.json(failure(null), { status: 429 }));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(view.result.current[0].bars).toEqual([]);
  expect(view.result.current[0].sample).toBeNull();
});

it('keeps rendered status, tone and percentages stable across successful, throttled and offline polls', async () => {
  setup();
  const fetcher = respond(body());
  const { container } = render(
    <ConfirmProvider>
      <AccountStatus providers={[provider('steady-render')]} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  const assertSteady = () => {
    expect(screen.getByText('Available')).toBeTruthy();
    expect(container.querySelector('.account-connection-status.active')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(
      screen.queryByText(/Usage rate limited|Updated|retry in|Usage unavailable|Stale/),
    ).toBeNull();
  };
  assertSteady();
  for (const response of [
    () => Promise.resolve(Response.json(failure(), { status: 429 })),
    () => Promise.reject(Error('offline')),
    () => Promise.resolve(Response.json(body())),
  ]) {
    fetcher.mockImplementation(response);
    await act(async () => vi.advanceTimersByTime(30_000));
    assertSteady();
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('does not hide known quota exhaustion behind a failed usage refresh', async () => {
  setup();
  const limited = failure();
  limited.lastSuccess = {
    ...limited.lastSuccess!,
    usage: { windows: [{ ...usage.windows[0], usedPercent: 100 }] },
  };
  respond(limited, 429);
  const { container } = render(
    <ConfirmProvider>
      <AccountStatus providers={[provider('real-exhaustion')]} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  expect(screen.getByText('Limit Exceeded')).toBeTruthy();
  expect(container.querySelector('.account-connection-status.quota-exceeded')).toBeTruthy();
  expect(screen.getByText('0%')).toBeTruthy();
});

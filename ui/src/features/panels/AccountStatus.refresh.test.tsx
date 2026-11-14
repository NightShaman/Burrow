import { act, cleanup, render, screen, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus, useAccountUsage } from './AccountStatus';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const providers: SavedProvider[] = [
  { id: 'refresh-anthropic', provider: 'Anthropic', apiType: 'anthropic-messages' },
  { id: 'refresh-openai', provider: 'OpenAI', apiType: 'openai-responses' },
].map((provider) => ({
  ...provider,
  url: '',
  apiKey: '',
  models: [],
  oauthConfigured: true,
}));
const usage = (usedPercent: number) => ({
  usage: {
    windows: [
      { key: 'primary', usedPercent, resetAt: null },
      { key: 'five_hour', usedPercent, resetAt: null },
    ],
  },
});
const usageCalls = () =>
  vi.mocked(api).mock.calls.filter(([path]) => path.includes('/oauth/usage'));
function mockUsage() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/reset-credits') ? { ok: false } : usage(20),
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('refreshes rendered Anthropic and OpenAI percentages every 30 seconds without remounting', async () => {
  mockUsage();
  const view = render(
    <ConfirmProvider>
      <AccountStatus providers={providers} />
    </ConfirmProvider>,
  );
  await act(async () => {});
  expect(screen.getAllByText('80%')).toHaveLength(4);
  expect(usageCalls()).toHaveLength(2);

  await act(async () => vi.advanceTimersByTime(29_999));
  expect(usageCalls()).toHaveLength(2);
  vi.mocked(api).mockResolvedValue(usage(35));
  await act(async () => vi.advanceTimersByTime(1));
  expect(usageCalls()).toHaveLength(4);
  expect(screen.getAllByText('65%')).toHaveLength(4);
  expect(screen.queryByText('Checking')).toBeNull();

  vi.mocked(api).mockResolvedValue(usage(45));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(usageCalls()).toHaveLength(6);
  expect(screen.getAllByText('55%')).toHaveLength(4);
  view.unmount();
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(usageCalls()).toHaveLength(6);
});

it('uses 30 seconds by default and skips overlapping polls until the pending batch completes', async () => {
  mockUsage();
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useAccountUsage([providers[0]]));
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(usageCalls()).toHaveLength(1);
  await act(async () => finish(usage(25)));
  expect(view.result.current[0].bars[0].remainingPercent).toBe(75);
  vi.mocked(api).mockResolvedValue(usage(30));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(usageCalls()).toHaveLength(2);
  expect(view.result.current[0].bars[0].remainingPercent).toBe(70);
});

it('keeps last successful percentages on a failed poll and recovers on the next tick', async () => {
  mockUsage();
  const view = renderHook(() => useAccountUsage(providers));
  await act(async () => {});
  vi.mocked(api).mockRejectedValue(new Error('Usage service unavailable'));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(view.result.current.map((card) => card.state)).toEqual(['error', 'error']);
  expect(view.result.current.map((card) => card.bars[0].remainingPercent)).toEqual([80, 80]);
  vi.mocked(api).mockResolvedValue(usage(40));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(view.result.current.map((card) => card.state)).toEqual(['ready', 'ready']);
  expect(view.result.current.map((card) => card.bars[0].remainingPercent)).toEqual([60, 60]);
});

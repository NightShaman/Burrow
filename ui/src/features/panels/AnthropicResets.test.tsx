import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { AnthropicResets } from './AnthropicResets';
import { anthropicCard, useAccountUsage, type AccountUsageCard } from './AccountStatus';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
let sequence = 0;
const inventory = {
  ok: true,
  fetchedAt: '2030-01-01T00:00:00Z',
  fullResets: { availableCount: 2, nearestExpiresAt: null },
};
const posts = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST');
function setup(id = `anthropic-${++sequence}`) {
  const refresh = vi.fn();
  const view = render(
    <ConfirmProvider>
      <AnthropicResets connectionId={id} name="Claude" onUsageRefresh={refresh} />
    </ConfirmProvider>,
  );
  return { ...view, refresh, id };
}
async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }));
  await screen.findByRole('alertdialog');
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Consume one Full reset' }));
}
it('fetches only manually and cancellation never posts', async () => {
  vi.mocked(api).mockResolvedValue(inventory);
  setup();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }));
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(posts()).toHaveLength(0);
});
it.each(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable', 'error'])(
  'honors definite %s even in thrown HTTP errors and refreshes',
  async (code) => {
    vi.mocked(api).mockImplementation(async (_path, init) => {
      if (init?.method === 'POST')
        throw Object.assign(new Error('HTTP 503'), {
          status: 503,
          details: JSON.stringify({ code, ambiguous: false }),
        });
      return inventory;
    });
    const { refresh, id } = setup();
    await confirm();
    await screen.findByText(/2 Full resets now available/);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({
      connectionId: id,
      confirmed: true,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(api).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
  },
);
it.each([{ code: 'reset', ambiguous: true }, { code: 'unexpected' }, null])(
  'locks unknown result %j across remount',
  async (result) => {
    vi.mocked(api).mockImplementation(async (_path, init) =>
      init?.method === 'POST' ? result : inventory,
    );
    const { unmount, id } = setup();
    await confirm();
    await screen.findByText(/Reset outcome unknown/);
    unmount();
    setup(id);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(2);
  },
);
it('GET failure cannot send activation', async () => {
  vi.mocked(api).mockRejectedValue(new Error('offline'));
  setup();
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText(/No reset sent/);
  expect(posts()).toHaveLength(0);
});
it('retains inventory and independent freshness on omission and failure; authoritative null/zero clears', () => {
  const freshness = { fetchedAt: '2029-01-01T00:00:00Z', sampleAgeMs: 90000, stale: true };
  const base: AccountUsageCard = {
    id: 'retention',
    name: 'Claude',
    vendor: 'Anthropic',
    plan: null,
    state: 'ready',
    bars: [],
    fullResets: inventory.fullResets,
    fullResetsFreshness: freshness,
    inventoryReceivedAt: 1,
  };
  for (const result of [
    { usage: { windows: [] } },
    { ok: false, usage: null },
    { usage: { windows: [], fullResets: { availableCount: -1, nearestExpiresAt: null } } },
  ]) {
    const next = anthropicCard(base, result);
    expect(next.fullResets).toEqual(inventory.fullResets);
    expect(next.fullResetsFreshness).toEqual(freshness);
    expect(next.inventoryReceivedAt).toBe(1);
  }
  const next = anthropicCard(base, {
    usage: { windows: [], fullResets: inventory.fullResets, fullResetsFreshness: freshness },
    fetchedAt: '2030-01-01T00:00:00Z',
    sampleAgeMs: 0,
  });
  expect(next.fullResetsFreshness).toEqual(freshness);
  expect(anthropicCard(base, { usage: { windows: [], fullResets: null } }).fullResets).toBeNull();
  expect(
    anthropicCard(base, {
      usage: { windows: [], fullResets: { availableCount: 0, nearestExpiresAt: null } },
    }).fullResets?.availableCount,
  ).toBe(0);
});
it('fences a pending POST across remount and retains the fence after a transport failure', async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(api).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST')
      return await new Promise((_resolve, fail) => {
        reject = fail;
      });
    return inventory;
  });
  const { unmount, id } = setup();
  await confirm();
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  unmount();
  setup(id);
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  reject(new Error('timeout'));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(posts()).toHaveLength(1);
});
it('refresh failure preserves the definite activation outcome', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce({ code: 'reset' })
    .mockRejectedValueOnce(new Error('offline'));
  const { refresh } = setup();
  await confirm();
  await screen.findByText('Full reset used. Reset availability refresh failed.');
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false);
});
it('zero manual inventory prevents confirmation and POST', async () => {
  vi.mocked(api).mockResolvedValue({
    ...inventory,
    fullResets: { availableCount: 0, nearestExpiresAt: null },
  });
  setup();
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('No Full resets available.');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(posts()).toHaveLength(0);
});
it('retains inventory through successful omission, network failure, HTTP failure, and remount', async () => {
  const freshness = { fetchedAt: '2029-01-01T00:00:00Z', sampleAgeMs: 80000, stale: false };
  vi.mocked(api).mockResolvedValueOnce({
    usage: { windows: [], fullResets: inventory.fullResets, fullResetsFreshness: freshness },
  });
  const providers = [
    {
      id: 'hook-retention',
      provider: 'Anthropic',
      apiType: 'anthropic-messages',
      url: '',
      apiKey: '',
      models: [],
      oauthConfigured: true,
    },
  ];
  const view = renderHook(({ revision }) => useAccountUsage(providers, 60000, revision), {
    initialProps: { revision: 0 },
  });
  await waitFor(() => expect(view.result.current[0]?.fullResets).toEqual(inventory.fullResets));
  vi.mocked(api).mockResolvedValueOnce({ usage: { windows: [] }, sampleAgeMs: 0 });
  view.rerender({ revision: 1 });
  await waitFor(() => expect(view.result.current[0]?.fullResetsFreshness?.stale).toBe(true));
  expect(view.result.current[0].fullResetsFreshness?.fetchedAt).toBe(freshness.fetchedAt);
  expect(view.result.current[0].fullResets).toEqual(inventory.fullResets);
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  view.rerender({ revision: 2 });
  await waitFor(() => expect(view.result.current[0]?.state).toBe('error'));
  expect(view.result.current[0].fullResets).toEqual(inventory.fullResets);
  view.unmount();
  vi.mocked(api).mockImplementationOnce(async (_path, _init, options) => {
    options?.onResponse?.(
      new Response(JSON.stringify({ ok: false, usage: null }), { status: 503 }),
    );
    throw new Error('HTTP 503');
  });
  const remount = renderHook(() => useAccountUsage(providers));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(4));
  expect(remount.result.current[0].fullResets).toEqual(inventory.fullResets);
  expect(remount.result.current[0].fullResetsFreshness?.stale).toBe(true);
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus, AnthropicResetInventory } from './AccountStatus';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  null,
  undefined,
  { availableCount: -1, nearestExpiresAt: null },
  { availableCount: 1.5, nearestExpiresAt: null },
  { availableCount: 2, nearestExpiresAt: 'bad' },
])('hides unavailable or malformed inventory %j', (inventory) => {
  const { container } = render(<AnthropicResetInventory inventory={inventory} now={0} />);
  expect(container.textContent).toBe('');
});
it('shows zero without implying unavailable and has no redemption control', () => {
  render(
    <AnthropicResetInventory inventory={{ availableCount: 0, nearestExpiresAt: null }} now={0} />,
  );
  expect(screen.getByText('0 Full')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('expiry unknown')).toBeNull();
});
it('uses supplied server clock for expiry and marks elapsed inventory pending refresh', () => {
  const { rerender } = render(
    <AnthropicResetInventory
      inventory={{ availableCount: 3, nearestExpiresAt: '2030-01-01T01:00:00Z' }}
      now={Date.parse('2030-01-01T00:00:00Z')}
    />,
  );
  expect(screen.getByText('expires 1h')).toBeTruthy();
  rerender(
    <AnthropicResetInventory
      inventory={{ availableCount: 3, nearestExpiresAt: '2030-01-01T01:00:00Z' }}
      now={Date.parse('2030-01-01T02:00:00Z')}
    />,
  );
  expect(screen.getByText('Full resets awaiting refresh')).toBeTruthy();
  expect(screen.queryByText('3 Full')).toBeNull();
});
it('carries inventory through the existing Anthropic usage fetch only', async () => {
  vi.mocked(api).mockResolvedValue({
    usage: { windows: [], fullResets: { availableCount: 4, nearestExpiresAt: null } },
  });
  render(
    <ConfirmProvider>
      <AccountStatus
        providers={[
          {
            id: 'inventory-integration',
            provider: 'Anthropic',
            apiType: 'anthropic-messages',
            url: '',
            apiKey: '',
            models: [],
            oauthConfigured: true,
          },
        ]}
      />
    </ConfirmProvider>,
  );
  await waitFor(() => expect(screen.getByText('4 Full')).toBeTruthy());
  expect(screen.getByText('expiry unknown')).toBeTruthy();
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
    '/api/anthropic/oauth/usage?connectionId=inventory-integration',
  ]);
  expect(screen.getByRole('button', { name: 'Use reset' })).toBeTruthy();
});

it('uses the OpenAI earliest-expiry hover without inventory freshness text or hover', async () => {
  const expiry = '2030-01-01T01:00:00Z';
  vi.mocked(api).mockResolvedValue({
    usage: {
      windows: [],
      fullResets: { availableCount: 3, nearestExpiresAt: expiry },
      fullResetsFreshness: { fetchedAt: '2030-01-01T00:00:00Z', sampleAgeMs: 180000, stale: true },
    },
  });
  const { container } = render(
    <ConfirmProvider>
      <AccountStatus
        providers={[
          {
            id: 'parity',
            provider: 'Anthropic',
            apiType: 'anthropic-messages',
            url: '',
            apiKey: '',
            models: [],
            oauthConfigured: true,
          },
        ]}
      />
    </ConfirmProvider>,
  );
  await waitFor(() => expect(screen.getByText('3 Full')).toBeTruthy());
  expect(container.querySelector('.account-resets-summary')?.getAttribute('title')).toBe(
    `Earliest expiry: ${new Date(expiry).toLocaleString()}`,
  );
  expect(container.textContent).not.toMatch(/Inventory (fresh|stale)/);
  expect(container.querySelector('[title^="Inventory"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Use reset' })).toBeTruthy();
});

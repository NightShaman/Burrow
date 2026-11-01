import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type ModelConnection } from './api';
import { useRuntimeDashboard } from './useRuntimeDashboard';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const connection = (id: string, overrides: Partial<ModelConnection> = {}): ModelConnection => ({
  id, provider: id, apiType: 'openai-responses', baseUrl: 'https://provider.invalid',
  apiKeyConfigured: true, models: [{ id: 'model', selected: true }], ...overrides,
});

it.each([
  connection('direct'),
  connection('anthropic', { apiType: 'anthropic-messages' }),
  connection('pool', { apiType: 'openai-lb', pool: { enabled: true, memberConnectionIds: ['direct'] } }),
  connection('oauth', { auth: { type: 'oauth', source: 'openai-oauth' } }),
])('does not discover or poll quotas for $id on mount, timer ticks or inventory refresh', async selected => {
  vi.useFakeTimers();
  const other = connection('other');
  vi.mocked(api).mockImplementation(async path => path === '/api/settings/model-connections'
    ? { connections: [selected, other] } : { operator: { name: 'Operator', avatar: 'OP' } });
  const options = { runtimeProviders: { current: [] }, setAgents: vi.fn(), reportError: vi.fn() };
  const hook = renderHook(() => useRuntimeDashboard(options));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.modelConnectionsLoaded).toBe(true);
  expect(hook.result.current.providerConnectionStatus).toBe('unknown');
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  await act(async () => { await hook.result.current.refreshModelConnections(); await vi.advanceTimersByTimeAsync(60_000); });
  expect(hook.result.current.providerConnectionStatus).toBe('unknown');
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/discover'))).toBe(false);
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/oauth/usage'))).toBe(false);
});

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type ModelConnection } from './api';
import { useRuntimeDashboard } from './useRuntimeDashboard';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const connection = (id: string, overrides: Partial<ModelConnection> = {}): ModelConnection => ({
  id, provider: id, apiType: 'openai-responses', baseUrl: 'https://provider.invalid',
  apiKeyConfigured: true, models: [{ id: 'model', selected: true }], ...overrides,
});

it.each([
  connection('direct'),
  connection('pool', { apiType: 'openai-lb', pool: { enabled: true, memberConnectionIds: ['direct'] } }),
  connection('oauth', { auth: { type: 'oauth', source: 'openai-oauth' } }),
])('never discovers $id on mount, timer ticks, selection changes or inventory refresh', async selected => {
  vi.useFakeTimers();
  const other = connection('other');
  vi.mocked(api).mockImplementation(async path => path === '/api/settings/model-connections'
    ? { connections: [selected, other] } : { operator: { name: 'Operator', avatar: 'OP' } });
  const options = { runtimeProviders: { current: [] }, setAgents: vi.fn(), reportError: vi.fn() };
  const hook = renderHook(({ selectedProvider }) => useRuntimeDashboard({ ...options, selectedProvider }), { initialProps: { selectedProvider: selected.provider } });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.modelConnectionsLoaded).toBe(true);
  expect(hook.result.current.providerConnectionStatus).toBe('unknown');
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  hook.rerender({ selectedProvider: other.provider });
  await act(async () => { await hook.result.current.refreshModelConnections(); await vi.advanceTimersByTimeAsync(60_000); });
  expect(hook.result.current.providerConnectionStatus).toBe('unknown');
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/discover'))).toBe(false);
});

it.each([
  ['openai', connection('Personal account', { auth: { type: 'oauth', source: 'openai-oauth' } })],
  ['anthropic', connection('Claude account', { apiType: 'anthropic-messages' })],
] as const)('preserves immediate and five-minute %s usage polling without discovery', async (endpoint, selected) => {
  vi.useFakeTimers();
  const usage = { marker: endpoint };
  const usagePath = `/api/${endpoint}/oauth/usage?connectionId=${encodeURIComponent(selected.id)}`;
  vi.mocked(api).mockImplementation(async path => path === '/api/settings/model-connections'
    ? { connections: [selected] } : path === usagePath ? { usage } : { operator: { name: 'Operator', avatar: 'OP' } });
  const hook = renderHook(() => useRuntimeDashboard({ selectedProvider: selected.provider, runtimeProviders: { current: [] }, setAgents, reportError }));
  const usageCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path === usagePath);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(usageCalls()).toHaveLength(1);
  expect(endpoint === 'openai' ? hook.result.current.openAiUsage : hook.result.current.anthropicUsage).toEqual(usage);
  await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
  expect(usageCalls()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(usageCalls()).toHaveLength(2);
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/discover'))).toBe(false);
  hook.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(usageCalls()).toHaveLength(2);
});

const setAgents = vi.fn();
const reportError = vi.fn();

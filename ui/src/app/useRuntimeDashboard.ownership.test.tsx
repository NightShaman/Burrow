import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from './api';
import { useRuntimeDashboard } from './useRuntimeDashboard';
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
it('hydrates local providers and operator identity through local endpoints only', async () => {
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/model-connections' ? { connections: [{ id: 'local', provider: 'openai', apiType: 'openai', baseUrl: 'https://provider.invalid', models: [{ id: 'm', selected: true }] }] } : path === '/api/settings/identities' ? { operator: { name: 'Rob', avatar: 'R' } } : { accounts: [] });
 const runtimeProviders = { current: [] as any[] }; const setAgents = vi.fn(); const reportError = vi.fn();
 const { result } = renderHook(() => useRuntimeDashboard({ runtimeProviders, setAgents, reportError }));
 await waitFor(() => expect(result.current.savedProviders[0]?.id).toBe('local'));
 expect(result.current.operatorProfile.name).toBe('Rob');
 expect(vi.mocked(api).mock.calls.every(([path]) => typeof path === 'string' && path.startsWith('/api/'))).toBe(true);
});

it('exposes automatic pool union catalogs alongside direct accounts to normal model pickers', async () => {
 const connections = [
  { id: 'direct', provider: 'Personal', apiType: 'openai-responses', baseUrl: 'https://example.invalid', models: [{ id: 'gpt-5.5', selected: true }] },
  { id: 'pool', provider: 'Daily drivers', apiType: 'openai-lb', pool: { enabled: true, memberConnectionIds: ['direct', 'other'] }, models: [{ id: 'gpt-5.5', selected: true }, { id: 'gpt-5.6', selected: true }] },
  { id: 'second-pool', provider: 'Overflow', apiType: 'anthropic-lb', pool: { enabled: true, memberConnectionIds: ['claude'] }, models: [{ id: 'claude-sonnet-4-6', selected: true }] },
 ];
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/model-connections' ? { connections } : path === '/api/settings/identities' ? { operator: { name: 'Rob', avatar: 'R' } } : { accounts: [] });
 const runtimeProviders = { current: [] as any[] };
 const setAgents = vi.fn(); const reportError = vi.fn();
 const { unmount } = renderHook(() => useRuntimeDashboard({ runtimeProviders, setAgents, reportError }));
 await waitFor(() => expect(runtimeProviders.current).toHaveLength(3));
 expect(runtimeProviders.current.map(p => [p.id, p.models])).toEqual([
  ['direct', ['gpt-5.5']], ['pool', ['gpt-5.5', 'gpt-5.6']], ['second-pool', ['claude-sonnet-4-6']],
 ]);
 unmount();
});

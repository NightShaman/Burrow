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

import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { apiForTarget } from './api';
import { localApiTarget, type ApiTarget } from './apiTargets';
import { useRuntimeDashboard } from './useRuntimeDashboard';
vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), apiForTarget: vi.fn() }));
const A: ApiTarget = { id: 'A', name: 'A', baseUrl: 'https://a.invalid', enabled: true };
const B: ApiTarget = { ...A, id: 'B', name: 'B', baseUrl: 'https://b.invalid' };
const connection = (id: string) => ({ id, name: id, provider: 'openai', enabled: true, models: [{ id: 'same-model', name: 'same-model' }] });
for (const next of [localApiTarget, B]) it(`FE-028 fences delayed A providers and identity after switch to ${next.id}`, async () => {
  let providers!: (value: unknown) => void;
  let identity!: (value: unknown) => void;
  vi.mocked(apiForTarget).mockImplementation(async (target, path) => {
    if (path === '/api/settings/model-connections') {
      if (target?.baseUrl === A.baseUrl) return new Promise((resolve) => { providers = resolve; });
      return { connections: [connection(next.id)] };
    }
    if (path === '/api/settings/identities') {
      if (target?.baseUrl === A.baseUrl) return new Promise((resolve) => { identity = resolve; });
      return { operator: { name: next.id, avatar: 'N' } };
    }
    throw new Error('fixture unavailable');
  });
  const runtimeProviders = { current: [] as any[] };
  const setAgents = vi.fn(); const reportError = vi.fn();
  const { result, rerender } = renderHook(({ target }) => useRuntimeDashboard({ target, runtimeProviders, setAgents, reportError }), { initialProps: { target: A } });
  rerender({ target: next });
  await waitFor(() => expect(result.current.savedProviders[0]?.id).toBe(next.id));
  setAgents.mockClear();
  await act(async () => { providers({ connections: [connection('A')] }); identity({ operator: { name: 'A', avatar: 'A' } }); });
  expect(result.current.savedProviders[0]?.id).toBe(next.id);
  expect(runtimeProviders.current[0]?.id).toBe(next.id);
  expect(result.current.operatorProfile.name).toBe(next.id);
  expect(setAgents).not.toHaveBeenCalled();
});

it('FE-028 same ID with changed endpoint ignores old failures and keeps new identity/providers', async () => {
  let rejectProviders!: (error: Error) => void;
  let rejectIdentity!: (error: Error) => void;
  const next = { ...A, baseUrl: 'https://replacement.invalid' };
  vi.mocked(apiForTarget).mockImplementation(async (target, path) => {
    if (path === '/api/settings/model-connections') {
      if (target?.baseUrl === A.baseUrl) return new Promise((_, reject) => { rejectProviders = reject; });
      return { connections: [connection('replacement')] };
    }
    if (path === '/api/settings/identities') {
      if (target?.baseUrl === A.baseUrl) return new Promise((_, reject) => { rejectIdentity = reject; });
      return { operator: { name: 'Replacement', avatar: 'R' } };
    }
    throw new Error('fixture unavailable');
  });
  const runtimeProviders = { current: [] as any[] };
  const setAgents = vi.fn(); const reportError = vi.fn();
  const { result, rerender } = renderHook(({ target }) => useRuntimeDashboard({ target, runtimeProviders, setAgents, reportError }), { initialProps: { target: A } });
  rerender({ target: next });
  await waitFor(() => expect(result.current.savedProviders[0]?.id).toBe('replacement'));
  await waitFor(() => expect(result.current.operatorProfile.name).toBe('Replacement'));
  reportError.mockClear(); setAgents.mockClear();
  await act(async () => { rejectProviders(new Error('OLD PROVIDERS')); rejectIdentity(new Error('OLD IDENTITY')); });
  expect(reportError.mock.calls.flat().join(' ')).not.toMatch(/OLD PROVIDERS|OLD IDENTITY/);
  expect(setAgents).not.toHaveBeenCalled();
  expect(result.current.savedProviders[0]?.id).toBe('replacement');
  expect(runtimeProviders.current[0]?.id).toBe('replacement');
  expect(result.current.operatorProfile.name).toBe('Replacement');
});

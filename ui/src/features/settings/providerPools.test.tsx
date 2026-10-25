import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { compatiblePoolMembers } from './providerPools';
import { ModelConnections } from './ModelConnections';
import { useModelConnectionEditor } from './useModelConnectionEditor';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.mocked(api).mockReset());
const account = (id: string, family = 'OpenAI'): SavedProvider => ({ id, provider: id, apiType: family === 'OpenAI' ? 'openai-responses' : 'anthropic-messages', url: 'https://example.test', apiKey: '', models: ['shared'], auth: { type: 'oauth', provider: family } });
const accounts = [account('first'), account('second'), account('claude', 'Claude'), { ...account('key'), auth: { type: 'api_key', provider: 'OpenAI' } }];
const pool: SavedProvider = { ...account('pool'), provider: 'OpenAI LB', apiType: 'openai-lb', auth: undefined, pool: { enabled: false, memberConnectionIds: ['second', 'first'] }, connectionModels: [{ id: 'shared', selected: true }, { id: 'hidden', selected: false }] };

it('only offers matching-family OAuth members, never API keys or nested pools', () => {
  expect(compatiblePoolMembers('openai-lb', [...accounts, pool]).map(a => a.id)).toEqual(['first', 'second']);
  expect(compatiblePoolMembers('anthropic-lb', [...accounts, pool]).map(a => a.id)).toEqual(['claude']);
});

it.each(['openai-lb', 'anthropic-lb'])('discovers and saves %s without URL, own credentials or stale direct identity', async apiType => {
  vi.mocked(api).mockResolvedValue({ models: [{ id: 'shared', selected: true }] });
  const changed = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useModelConnectionEditor({ savedProviders: accounts, onModelConnectionsChanged: changed }));
  act(() => { result.current.editProvider(accounts[0]); result.current.setApiKey('secret'); result.current.setOauthIdToken('token'); });
  act(() => result.current.setApiType(apiType));
  expect(result.current.editingId).toBeNull();
  expect(result.current.apiKey).toBe('');
  const id = apiType === 'openai-lb' ? 'first' : 'claude';
  act(() => result.current.togglePoolMember(id));
  await act(async () => { await result.current.connect(); });
  const discovery = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
  expect(discovery).toMatchObject({ apiType, pool: { enabled: true, memberConnectionIds: [id], sticky: true, preferEarlierReset: false } });
  for (const key of ['id', 'baseUrl', 'apiKey', 'oauthTokens']) expect(discovery).not.toHaveProperty(key);
  await act(async () => { await result.current.saveProvider(); });
  const saved = JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body));
  expect(saved).toMatchObject({ apiType, models: [{ id: 'shared', selected: true }], pool: discovery.pool });
  for (const key of ['id', 'baseUrl', 'apiKey', 'oauthTokens']) expect(saved).not.toHaveProperty(key);
  expect(changed).toHaveBeenCalledOnce();
});

it('round-trips disabled pools, ordered membership and model selection; membership changes invalidate discovery', async () => {
  vi.mocked(api).mockResolvedValue({});
  const { result } = renderHook(() => useModelConnectionEditor({ savedProviders: accounts, onModelConnectionsChanged: vi.fn().mockResolvedValue(undefined) }));
  act(() => result.current.editProvider(pool));
  expect(result.current.poolEnabled).toBe(false);
  expect(result.current.memberConnectionIds).toEqual(['second', 'first']);
  await act(async () => { await result.current.saveProvider(); });
  const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
  expect(body).toMatchObject({ id: 'pool', pool: { enabled: false, memberConnectionIds: ['second', 'first'] }, models: pool.connectionModels });
  act(() => result.current.editProvider(pool));
  act(() => result.current.togglePoolMember('first'));
  expect(result.current.availableModels).toEqual([]);
  expect(result.current.connected).toBe(false);
});

it('rejects stale discovery after membership changes and surfaces successful-HTTP discovery errors', async () => {
  let resolve!: (v: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
  const { result } = renderHook(() => useModelConnectionEditor({ savedProviders: accounts, onModelConnectionsChanged: vi.fn() }));
  act(() => result.current.editProvider(pool));
  let pending!: Promise<unknown>;
  act(() => { pending = result.current.connect(); });
  act(() => result.current.togglePoolMember('first'));
  await act(async () => { resolve({ models: [{ id: 'stale' }] }); await pending; });
  expect(result.current.availableModels).toEqual([]);
  vi.mocked(api).mockResolvedValueOnce({ models: [], discovery: { error: 'member offline' } });
  await act(async () => { await result.current.connect(); });
  expect(result.current.requestError).toContain('member offline');
});

it('shows only account controls for pools, blocks empty membership, retains direct accounts, handles missing members', async () => {
  render(<ModelConnections loadBalancing savedProviders={[...accounts, { ...pool, pool: { enabled: true, memberConnectionIds: ['missing'] } }]} onModelConnectionsChanged={vi.fn()} mcpConnections={null} />);
  expect((screen.getByLabelText('Pool type') as HTMLSelectElement).value).toBe('openai-lb');
  expect(screen.queryByLabelText('URL')).toBeNull();
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(screen.queryByRole('button', { name: /^OpenAI OAuth|^Anthropic OAuth/ })).toBeNull();
  expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('first'));
  expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByText('Saved providers'));
  fireEvent.click(screen.getByRole('button', { name: /OpenAI LB.*accounts/ }));
  expect(screen.getByRole('alert').textContent).toContain('Remove unavailable accounts');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Unavailable account: missing'));
  fireEvent.click(screen.getByLabelText('second'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.queryByRole('button', { name: /first.*1 model/ })).toBeNull();
});


it('keeps direct Models separate from pool API types and saved pools', () => {
  render(<ModelConnections savedProviders={[...accounts, pool]} onModelConnectionsChanged={vi.fn()} mcpConnections={null} />);
  expect(screen.queryByRole('option', { name: 'OpenAI LB' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Anthropic LB' })).toBeNull();
  fireEvent.click(screen.getByText('Saved providers'));
  expect(screen.queryByRole('button', { name: /OpenAI LB.*accounts/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /first.*1 model/ }));
  expect(screen.getByLabelText('URL')).toBeTruthy();
  expect(screen.getByLabelText('OpenAI ID token')).toBeTruthy();
});

it.each(['openai-lb', 'anthropic-lb'])('pool surface saves and resets within Load Balancing: %s', async apiType => {
  vi.mocked(api).mockResolvedValue({});
  const saved = { ...pool, apiType, provider: apiType, pool: { enabled: true, memberConnectionIds: [apiType === 'openai-lb' ? 'first' : 'claude'] } };
  render(<ModelConnections loadBalancing savedProviders={[...accounts, saved]} onModelConnectionsChanged={vi.fn().mockResolvedValue(undefined)} mcpConnections={null} />);
  fireEvent.click(screen.getByText('Saved providers'));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(apiType + '.*accounts') }));
  expect((screen.getByLabelText('Pool type') as HTMLSelectElement).value).toBe(apiType);
  expect(screen.getByLabelText('Use shared')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect((screen.getByLabelText('Pool type') as HTMLSelectElement).value).toBe('openai-lb'));
  expect(screen.queryByLabelText('URL')).toBeNull();
  const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
  expect(body).toMatchObject({ id: 'pool', apiType, pool: saved.pool, models: pool.connectionModels });
  fireEvent.change(screen.getByLabelText('Pool type'), { target: { value: 'anthropic-lb' } });
  expect(screen.getByLabelText('claude')).toBeTruthy();
  expect(screen.queryByLabelText('first')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect((screen.getByLabelText('Pool type') as HTMLSelectElement).value).toBe('openai-lb');
});

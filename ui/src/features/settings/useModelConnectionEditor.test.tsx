import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { modelConnectionsApi } from './modelConnectionsApi';
import { useModelConnectionEditor } from './useModelConnectionEditor';

const confirmMock = vi.fn();

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));

const apiMock = vi.mocked(api);

function renderEditor(onModelConnectionsChanged = vi.fn().mockResolvedValue(undefined)) {
  return { ...renderHook(() => useModelConnectionEditor({ onModelConnectionsChanged })), onModelConnectionsChanged };
}

const savedProvider: SavedProvider = {
  id: 'provider-1',
  provider: 'Example',
  apiType: 'openai-responses',
  url: 'https://example.test/v1',
  apiKey: '',
  apiKeyConfigured: true,
  models: ['vision', 'manual'],
  modelLabels: { vision: 'Vision' },
  modelDiscoveredInputs: { vision: ['text', 'image'] },
  modelInputOverrides: { vision: ['text'] },
  manualModels: { manual: true },
};

describe('useModelConnectionEditor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    confirmMock.mockResolvedValue(true);
  });

  it('hydrates saved providers and resets the editor without losing model metadata', () => {
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));

    expect(result.current.editingId).toBe('provider-1');
    expect(result.current.provider).toBe('Example');
    expect(result.current.apiKeyConfigured).toBe(true);
    expect(result.current.availableModels).toEqual([
      expect.objectContaining({ id: 'vision', displayName: 'Vision', discoveredInput: ['text', 'image'], acceptedInputOverride: ['text'], acceptedInput: ['text'] }),
      expect.objectContaining({ id: 'manual', manual: true, acceptedInput: ['text'] }),
    ]);

    act(() => result.current.resetProvider());
    expect(result.current.editingId).toBeNull();
    expect(result.current.provider).toBe('');
    expect(result.current.availableModels).toEqual([]);
  });

  it('discovers models and saves the selected provider payload', async () => {
    vi.spyOn(modelConnectionsApi, 'discover').mockResolvedValue({ models: [{ id: 'model-a', selected: true, acceptedInput: ['text'] }] });
    apiMock.mockResolvedValue({});
    const { result, onModelConnectionsChanged } = renderEditor();
    act(() => {
      result.current.setProvider(' Example ');
      result.current.setUrl(' https://example.test/v1 ');
      result.current.setApiKey('secret');
    });

    await act(() => result.current.connect());
    expect(modelConnectionsApi.discover).toHaveBeenCalledWith(expect.objectContaining({ provider: 'Example', baseUrl: 'https://example.test/v1', apiKey: 'secret' }));
    expect(result.current.availableModels).toEqual([expect.objectContaining({ id: 'model-a' })]);

    await act(() => result.current.saveProvider());
    expect(apiMock).toHaveBeenCalledWith('/api/settings/model-connections', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ provider: 'Example', apiType: 'openai-chat-completions', baseUrl: 'https://example.test/v1', apiKey: 'secret', models: [{ id: 'model-a', selected: true, acceptedInput: ['text'] }] }),
    }));
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
    expect(result.current.provider).toBe('');
    expect(result.current.savedProvidersOpen).toBe(true);
  });

  it('retains the authorized OpenAI connection for discovery and manual selection', async () => {
    const connection = { id: 'oauth-1', provider: 'OpenAI', apiType: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api', authConfigured: true, models: [] };
    vi.spyOn(modelConnectionsApi, 'startOpenAiOAuth').mockResolvedValue({ connection, login: { id: 'login-1', status: 'waiting_for_code' } });
    vi.spyOn(modelConnectionsApi, 'submitOpenAiOAuthCode').mockResolvedValue({ login: { id: 'login-1', status: 'authorized', connection } });
    const discover = vi.spyOn(modelConnectionsApi, 'discover').mockRejectedValue(new Error('unavailable'));
    const { result, onModelConnectionsChanged } = renderEditor();
    // Deliberately populate stale editor data before authorization.
    act(() => result.current.editProvider(savedProvider));
    act(() => result.current.openOpenAiOAuth());
    await act(() => result.current.openAiFlow.start());
    act(() => result.current.openAiFlow.setCode('callback'));
    await act(() => result.current.openAiFlow.submit());

    expect(result.current.editingId).toBe('oauth-1');
    expect(result.current.provider).toBe('OpenAI');
    expect(result.current.connected).toBe(true);
    expect(result.current.apiKeyConfigured).toBe(true);
    expect(result.current.availableModels).toEqual([]);
    expect(apiMock).not.toHaveBeenCalled();
    expect(onModelConnectionsChanged).not.toHaveBeenCalled();
    expect(result.current.oauthModal).toBe('openai');
    expect(result.current.openAiFlow.error).toContain('unavailable');

    await act(() => result.current.connect());
    expect(discover).toHaveBeenCalledWith({ id: 'oauth-1', provider: 'OpenAI', apiType: 'openai-responses', baseUrl: connection.baseUrl, apiKey: '', models: [] });
    expect(result.current.requestError).toContain('Add model IDs manually');
    act(() => result.current.setManualModel('gpt-manual'));
    act(() => result.current.addManualModel());
    apiMock.mockRejectedValueOnce(new Error('save failed'));
    await act(() => result.current.saveProvider());
    expect(result.current.editingId).toBe('oauth-1');
    expect(result.current.availableModels[0].id).toBe('gpt-manual');
    expect(result.current.requestError).toContain('save failed');
    apiMock.mockResolvedValueOnce({});
    await act(() => result.current.saveProvider());
    const payload = JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string);
    expect(payload).toEqual(expect.objectContaining({ id: 'oauth-1', provider: 'OpenAI', apiType: 'openai-responses', baseUrl: connection.baseUrl, models: [expect.objectContaining({ id: 'gpt-manual', selected: true })] }));
    expect(payload).not.toHaveProperty('apiKey');
    expect(result.current.editingId).toBeNull();
  });

  it('does not close OpenAI authorization when refreshing connections fails', async () => {
    const connection = { id: 'oauth-1', authConfigured: true, models: [] };
    vi.spyOn(modelConnectionsApi, 'startOpenAiOAuth').mockResolvedValue({ connection, login: { id: 'login-1', status: 'waiting_for_code' } });
    vi.spyOn(modelConnectionsApi, 'submitOpenAiOAuthCode').mockResolvedValue({ login: { id: 'login-1', status: 'authorized', connection } });
    vi.spyOn(modelConnectionsApi, 'discover').mockResolvedValue({ models: [{ id: 'gpt-test', selected: true }] });
    const { result } = renderEditor(vi.fn().mockRejectedValue(new Error('refresh failed')));
    act(() => result.current.openOpenAiOAuth());
    await act(() => result.current.openAiFlow.start());
    act(() => result.current.openAiFlow.setCode('callback'));
    await act(() => result.current.openAiFlow.submit());
    expect(result.current.oauthModal).toBe('openai');
    expect(result.current.editingId).toBe('oauth-1');
    expect(result.current.openAiFlow.error).toContain('refresh failed');
  });

  it('automatically discovers authorized models and isolates sequential accounts and stale discovery', async () => {
    const first = { id: 'account-a', authConfigured: true, models: [] };
    const second = { id: 'account-b', authConfigured: true, models: [] };
    vi.spyOn(modelConnectionsApi, 'startOpenAiOAuth')
      .mockResolvedValueOnce({ connection: first, login: { id: 'login-a', status: 'waiting_for_code' } })
      .mockResolvedValueOnce({ connection: second, login: { id: 'login-b', status: 'waiting_for_code' } });
    vi.spyOn(modelConnectionsApi, 'submitOpenAiOAuthCode')
      .mockResolvedValueOnce({ login: { id: 'login-a', status: 'authorized', connection: first } })
      .mockResolvedValueOnce({ login: { id: 'login-b', status: 'authorized', connection: second } });
    let resolveFirst!: (value: { models: Array<{ id: string; selected: boolean }> }) => void;
    const discover = vi.spyOn(modelConnectionsApi, 'discover')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ models: [{ id: 'model-b', selected: true }] });
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    act(() => result.current.openOpenAiOAuth());
    await act(() => result.current.openAiFlow.start());
    act(() => result.current.openAiFlow.setCode('a'));
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.openAiFlow.submit(); await Promise.resolve(); });
    act(() => result.current.openOpenAiOAuth());
    expect(result.current.availableModels).toEqual([]);
    await act(() => result.current.openAiFlow.start());
    act(() => result.current.openAiFlow.setCode('b'));
    await act(() => result.current.openAiFlow.submit());
    expect(discover.mock.calls.map(([payload]) => payload.id)).toEqual(['account-a', 'account-b']);
    expect(discover.mock.calls[1][0]).toEqual({ id: 'account-b', provider: 'OpenAI', apiType: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api', apiKey: '', models: [] });
    expect(result.current.oauthModal).toBeNull();
    expect(result.current.connected).toBe(true);
    expect(result.current.availableModels).toEqual([{ id: 'model-b', selected: true }]);
    await act(async () => { resolveFirst({ models: [{ id: 'model-a', selected: true }] }); await pending; });
    expect(result.current.editingId).toBe('account-b');
    expect(result.current.availableModels).toEqual([{ id: 'model-b', selected: true }]);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('keeps manual model IDs unique and updates capability overrides', () => {
    const { result } = renderEditor();
    act(() => result.current.setManualModel('manual-model'));
    act(() => result.current.addManualModel());
    expect(result.current.availableModels).toEqual([expect.objectContaining({ id: 'manual-model', manual: true })]);

    act(() => result.current.setManualModel('manual-model'));
    act(() => {
      result.current.addManualModel();
      result.current.toggleModelInput('manual-model', 'image');
    });
    expect(result.current.availableModels).toHaveLength(1);
    expect(result.current.availableModels[0]).toEqual(expect.objectContaining({ acceptedInputOverride: ['text', 'image'] }));

    act(() => result.current.setModelInputAuto('manual-model', true));
    expect(result.current.availableModels[0].acceptedInputOverride).toBeUndefined();
  });

  it('confirms deletion and refreshes saved connections', async () => {
    apiMock.mockResolvedValue({});
    const { result, onModelConnectionsChanged } = renderEditor();
    await act(() => result.current.deleteProvider(savedProvider));

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete provider?', tone: 'danger' }));
    expect(apiMock).toHaveBeenCalledWith('/api/settings/model-connections/provider-1', { method: 'DELETE' });
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
  });
});

it.each(['edit', 'cancel'])('FE029 ignores ordinary discovery after %s for success and failure', async action => {
 for (const fail of [false,true]) {
  let resolve!: (value:any)=>void, reject!:(error:Error)=>void;
  const pending = new Promise<any>((yes,no)=>{resolve=yes;reject=no;});
  vi.spyOn(modelConnectionsApi,'discover').mockReturnValue(pending);
  const {result,unmount} = renderEditor();
  act(()=>result.current.editProvider(savedProvider));
  let work!:Promise<any>; act(()=>{work=result.current.connect();});
  act(()=> action === 'edit' ? result.current.editProvider({...savedProvider,id:'B',provider:'B',models:['b']}) : result.current.resetProvider());
  await act(async()=>{if(fail) reject(new Error('stale'));else resolve({models:[{id:'stale'}]});await work;});
  expect(result.current.availableModels.map(m=>m.id)).toEqual(action === 'edit' ? ['b'] : []);
  expect(result.current.requestError).toBe(''); expect(result.current.requestState).toBe('idle');
  expect(result.current.connected).toBe(action === 'edit');
  unmount();vi.restoreAllMocks();
 }
});

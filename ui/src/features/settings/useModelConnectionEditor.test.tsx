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

  it('reauthorizes an edited OpenAI connection in place and leaves its settings intact when start fails', async () => {
    vi.spyOn(modelConnectionsApi, 'startOpenAiOAuth').mockRejectedValue(new Error('operator cancelled'));
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));

    act(() => result.current.openOpenAiOAuth());
    expect(result.current.editingId).toBe('provider-1');
    expect(result.current.provider).toBe('Example');
    expect(result.current.availableModels.map((model) => model.id)).toEqual(['vision', 'manual']);

    await act(() => result.current.openAiFlow.start(result.current.editingId ?? undefined));
    expect(modelConnectionsApi.startOpenAiOAuth).toHaveBeenCalledWith('provider-1');
    expect(result.current.editingId).toBe('provider-1');
    expect(result.current.provider).toBe('Example');
    expect(result.current.availableModels.map((model) => model.id)).toEqual(['vision', 'manual']);
    expect(result.current.openAiFlow.error).toContain('operator cancelled');
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

  const fillTokens = (editor: ReturnType<typeof useModelConnectionEditor>) => {
    editor.setOauthIdToken(' id-secret ');
    editor.setOauthAccessToken(' access-secret ');
    editor.setOauthRefreshToken(' refresh-secret ');
  };
  const tokens = (editor: ReturnType<typeof useModelConnectionEditor>) =>
    [editor.oauthIdToken, editor.oauthAccessToken, editor.oauthRefreshToken];

  it('posts exact OAuth token keys on the existing connection without changing model metadata', async () => {
    apiMock.mockResolvedValue({});
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    const models = result.current.availableModels;
    act(() => fillTokens(result.current));
    await act(() => result.current.saveProvider());
    expect(apiMock).toHaveBeenCalledExactlyOnceWith('/api/settings/model-connections', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: savedProvider.id, provider: savedProvider.provider,
        apiType: savedProvider.apiType, baseUrl: savedProvider.url,
        oauthTokens: { id_token: 'id-secret', access_token: 'access-secret', refresh_token: 'refresh-secret' }, models }),
    });
    expect(tokens(result.current)).toEqual(['', '', '']);
  });

  it.each([false, true])('omits blank token fields and the whole empty object (partial=%s)', async (partial) => {
    apiMock.mockResolvedValue({});
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    act(() => {
      result.current.setOauthIdToken('   ');
      result.current.setOauthAccessToken(partial ? ' access ' : '\t');
      result.current.setOauthRefreshToken('');
      result.current.setApiKey('   ');
    });
    await act(() => result.current.saveProvider());
    const payload = JSON.parse(apiMock.mock.calls[0][1]!.body as string);
    expect(payload.id).toBe(savedProvider.id);
    expect(payload).not.toHaveProperty('apiKey');
    if (partial) expect(payload.oauthTokens).toEqual({ access_token: 'access' });
    else expect(payload).not.toHaveProperty('oauthTokens');
  });

  it('clears secrets after a successful POST while refresh is still pending and subsequently fails', async () => {
    let rejectRefresh!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_, reject) => { rejectRefresh = reject; }));
    apiMock.mockResolvedValue({});
    const { result } = renderEditor(refresh);
    act(() => result.current.editProvider(savedProvider));
    act(() => { fillTokens(result.current); result.current.setApiKey('key-secret'); });
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.saveProvider(); await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.requestState).toBe('saving');
    expect(tokens(result.current)).toEqual(['', '', '']);
    expect(result.current.apiKey).toBe('');
    await act(async () => { rejectRefresh(new Error('refresh failed')); await saving; });
    expect(result.current.requestError).toContain('refresh failed');
    expect(tokens(result.current)).toEqual(['', '', '']);
    expect(result.current.editingId).toBe(savedProvider.id);
  });

  it.each([false, true])('ignores stale save success after A→B→A while preserving inventory refresh (refreshFails=%s)', async (refreshFails) => {
    let resolvePost!: (value: unknown) => void;
    const post = new Promise((resolve) => { resolvePost = resolve; });
    apiMock.mockImplementation(() => post);
    const refresh = vi.fn(() => refreshFails ? Promise.reject(new Error('refresh failed')) : Promise.resolve());
    const { result } = renderEditor(refresh);
    act(() => result.current.editProvider(savedProvider));
    act(() => { fillTokens(result.current); result.current.setApiKey('old-a-secret'); });
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.saveProvider(); await Promise.resolve(); });
    expect(result.current.requestState).toBe('saving');

    act(() => result.current.editProvider({ ...savedProvider, id: 'provider-b', provider: 'Provider B', models: ['b'] }));
    act(() => result.current.editProvider(savedProvider));
    act(() => {
      result.current.setApiKey('new-a-secret');
      result.current.setOauthIdToken('new-id');
      result.current.setOauthAccessToken('new-access');
      result.current.setOauthRefreshToken('new-refresh');
    });

    await act(async () => { resolvePost({}); await saving; });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.editingId).toBe(savedProvider.id);
    expect(result.current.provider).toBe(savedProvider.provider);
    expect(result.current.apiKey).toBe('new-a-secret');
    expect(tokens(result.current)).toEqual(['new-id', 'new-access', 'new-refresh']);
    expect(result.current.requestState).toBe('idle');
    expect(result.current.requestError).toBe('');
    expect(result.current.savedProvidersOpen).toBe(false);
  });

  it('ignores stale save success after cancel and new editor without clearing new secrets', async () => {
    let resolvePost!: (value: unknown) => void;
    const post = new Promise((resolve) => { resolvePost = resolve; });
    apiMock.mockImplementation(() => post);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderEditor(refresh);
    act(() => result.current.editProvider(savedProvider));
    act(() => { fillTokens(result.current); result.current.setApiKey('old-secret'); });
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.saveProvider(); await Promise.resolve(); });

    act(() => result.current.resetProvider());
    act(() => {
      result.current.setProvider('New Provider');
      result.current.setUrl('https://new.example/v1');
      result.current.setApiKey('new-secret');
      result.current.setOauthAccessToken('new-token');
      result.current.setManualModel('new-model');
    });
    act(() => result.current.addManualModel());

    await act(async () => { resolvePost({}); await saving; });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.editingId).toBeNull();
    expect(result.current.provider).toBe('New Provider');
    expect(result.current.url).toBe('https://new.example/v1');
    expect(result.current.apiKey).toBe('new-secret');
    expect(tokens(result.current)).toEqual(['', 'new-token', '']);
    expect(result.current.availableModels).toEqual([expect.objectContaining({ id: 'new-model' })]);
    expect(result.current.requestState).toBe('idle');
    expect(result.current.requestError).toBe('');
  });

  it('ignores stale POST failure after switching editors', async () => {
    let rejectPost!: (error: Error) => void;
    const post = new Promise((_, reject) => { rejectPost = reject; });
    apiMock.mockImplementation(() => post);
    const { result, onModelConnectionsChanged } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.saveProvider(); await Promise.resolve(); });

    act(() => result.current.editProvider({ ...savedProvider, id: 'provider-b', provider: 'Provider B', models: ['b'] }));
    await act(async () => { rejectPost(new Error('late write failed')); await saving; });
    expect(onModelConnectionsChanged).not.toHaveBeenCalled();
    expect(result.current.editingId).toBe('provider-b');
    expect(result.current.provider).toBe('Provider B');
    expect(result.current.availableModels.map((model) => model.id)).toEqual(['b']);
    expect(result.current.requestState).toBe('idle');
    expect(result.current.requestError).toBe('');
  });

  it.each([false, true])('keeps B drafts and busy state when A finishes a delayed refresh (refreshFails=%s)', async (refreshFails) => {
    let resolveRefresh!: () => void;
    let rejectRefresh!: (error: Error) => void;
    const refreshPending = new Promise<void>((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; });
    let resolveB!: (value: unknown) => void;
    apiMock.mockResolvedValueOnce({}).mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const refresh = vi.fn().mockReturnValueOnce(refreshPending).mockResolvedValue(undefined);
    const { result } = renderEditor(refresh);
    act(() => result.current.editProvider(savedProvider));
    act(() => result.current.setApiKey('a-secret'));
    let savingA!: Promise<void>;
    await act(async () => { savingA = result.current.saveProvider(); await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.apiKey).toBe('');

    act(() => result.current.editProvider({ ...savedProvider, id: 'provider-b', provider: 'Provider B', models: ['b'] }));
    act(() => { result.current.setApiKey('b-secret'); fillTokens(result.current); });
    let savingB!: Promise<void>;
    await act(async () => { savingB = result.current.saveProvider(); await Promise.resolve(); });
    await act(async () => { if (refreshFails) rejectRefresh(new Error('late refresh failed')); else resolveRefresh(); await savingA; });
    expect(result.current.editingId).toBe('provider-b');
    expect(result.current.apiKey).toBe('b-secret');
    expect(tokens(result.current)).toEqual([' id-secret ', ' access-secret ', ' refresh-secret ']);
    expect(result.current.requestState).toBe('saving');
    expect(result.current.requestError).toBe('');
    expect(JSON.parse(apiMock.mock.calls[1][1]!.body as string)).toEqual(expect.objectContaining({ id: 'provider-b', apiKey: 'b-secret' }));
    await act(async () => { resolveB({}); await savingB; });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.current.editingId).toBeNull();
    expect(result.current.requestState).toBe('idle');
  });

  it('retains token drafts after a failed POST and submits the same payload on retry', async () => {
    apiMock.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce({});
    const { result, onModelConnectionsChanged } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    act(() => fillTokens(result.current));
    await act(() => result.current.saveProvider());
    expect(tokens(result.current)).toEqual([' id-secret ', ' access-secret ', ' refresh-secret ']);
    expect(result.current.requestError).toContain('write failed');
    expect(onModelConnectionsChanged).not.toHaveBeenCalled();
    await act(() => result.current.saveProvider());
    expect(apiMock.mock.calls[1]).toEqual(apiMock.mock.calls[0]);
    expect(tokens(result.current)).toEqual(['', '', '']);
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'switch'])('clears token drafts on %s', (action) => {
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    act(() => fillTokens(result.current));
    act(() => action === 'cancel' ? result.current.resetProvider()
      : result.current.editProvider({ ...savedProvider, id: 'other' }));
    expect(tokens(result.current)).toEqual(['', '', '']);
    expect(result.current.editingId).toBe(action === 'cancel' ? null : 'other');
  });

  it.each([
    [{ auth: { provider: 'OpenAI' } }, true],
    [{ auth: { type: 'oauth' } }, true],
    [{ auth: { source: 'openai-oauth' } }, true],
    [{ authSource: 'openai-oauth' }, true],
    [{ oauthConfigured: true }, true],
    [{ auth: { type: 'api_key' }, apiKeyConfigured: true }, false],
    [{}, false],
  ] as const)('detects OAuth from saved metadata %j', (metadata, expected) => {
    const { result } = renderEditor();
    act(() => result.current.editProvider({ ...savedProvider, ...metadata }));
    expect(result.current.oauthConnection).toBe(expected);
  });

  it('confirms deletion and refreshes saved connections', async () => {
    apiMock.mockResolvedValue({});
    const { result, onModelConnectionsChanged } = renderEditor();
    await act(() => result.current.deleteProvider(savedProvider));

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete provider?', tone: 'danger' }));
    expect(apiMock).toHaveBeenCalledWith('/api/settings/model-connections/provider-1', { method: 'DELETE' });
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
  });

  it('does not reset the current editor after a late delete refresh for a previously edited provider', async () => {
    let resolveDelete!: (value: unknown) => void;
    apiMock.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));
    const { result, onModelConnectionsChanged } = renderEditor();
    act(() => result.current.editProvider(savedProvider));
    let deleting!: Promise<void>;
    await act(async () => { deleting = result.current.deleteProvider(savedProvider); await Promise.resolve(); });

    act(() => result.current.editProvider({ ...savedProvider, id: 'provider-b', provider: 'Provider B', models: ['b'] }));
    await act(async () => { resolveDelete({}); await deleting; });

    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
    expect(result.current.editingId).toBe('provider-b');
    expect(result.current.provider).toBe('Provider B');
    expect(result.current.availableModels.map((model) => model.id)).toEqual(['b']);
    expect(result.current.requestError).toBe('');
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

describe('unsaved provider write ownership', () => {
  it('does not repeat a successful POST when inventory refresh fails', async () => {
    apiMock.mockResolvedValue({});
    const { result } = renderEditor(vi.fn().mockRejectedValue(new Error('inventory offline')));
    act(() => result.current.editProvider(savedProvider));
    act(() => result.current.setProvider('Renamed'));
    await act(async () => { await result.current.saveProvider(); });
    expect(result.current.requestError).toContain('refresh failed');
    await act(async () => { await result.current.saveProvider(); });
    expect(apiMock.mock.calls.filter(([path, init]) => path === '/api/settings/model-connections' && init?.method === 'POST')).toHaveLength(1);
    expect(result.current.provider).toBe('Renamed');
  });

  it('retains a newer draft instead of resetting it after a slow refresh', async () => {
    let finishRefresh!: () => void;
    apiMock.mockResolvedValue({});
    const { result } = renderEditor(vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; })));
    act(() => result.current.editProvider(savedProvider));
    act(() => result.current.setProvider('First edit'));
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.saveProvider(); await Promise.resolve(); });
    act(() => result.current.setProvider('Later edit'));
    await act(async () => { finishRefresh(); await saving; });
    expect(result.current.provider).toBe('Later edit');
    expect(result.current.editingId).toBe(savedProvider.id);
    expect(result.current.savedProvidersOpen).toBe(false);
    expect(apiMock.mock.calls.filter(([path, init]) => path === '/api/settings/model-connections' && init?.method === 'POST')).toHaveLength(1);
  });
});

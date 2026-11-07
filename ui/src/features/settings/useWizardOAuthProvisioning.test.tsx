import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWizardOAuthProvisioning } from './useWizardOAuthProvisioning';
import { api } from '../../app/api';

const flows = vi.hoisted(() => ({
  open: {} as any,
  claude: {} as any,
  resetOpen: vi.fn(),
  resetClaude: vi.fn(),
}));
vi.mock('../../app/api', () => ({ api: vi.fn() }));
vi.mock('./useOpenAiOAuthConnectionFlow', () => ({
  useOpenAiOAuthConnectionFlow: (options: any) => {
    flows.open = options;
    return {
      login: null,
      code: '',
      setCode: vi.fn(),
      requestState: 'idle',
      error: '',
      start: vi.fn(),
      submit: vi.fn(),
      reset: flows.resetOpen,
    };
  },
}));
vi.mock('./useClaudeCodeLoginFlow', () => ({
  useClaudeCodeLoginFlow: (options: any) => {
    flows.claude = options;
    return {
      login: null,
      code: '',
      setCode: vi.fn(),
      requestState: 'idle',
      error: '',
      start: vi.fn(),
      submit: vi.fn(),
      reset: flows.resetClaude,
    };
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(['openai', 'anthropic'] as const)(
  'discovers and saves authorized %s connection before selecting it',
  async (kind) => {
    const setProviders = vi.fn(),
      setConnectionId = vi.fn(),
      setModel = vi.fn();
    const connection = {
      id: 'c1',
      provider: 'OpenAI',
      apiType: 'openai-responses',
      baseUrl: 'https://example.test',
    };
    vi.mocked(api)
      .mockResolvedValueOnce({ models: [{ id: 'm1', discoveredInput: ['text'] }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ connections: [{ ...connection, models: ['m1'] }] });
    const { result } = renderHook(() =>
      useWizardOAuthProvisioning({ setProviders, setConnectionId, setModel }),
    );
    await act(() => result.current.startWizardOAuth(kind));
    expect(result.current.oauthProvider).toBe(kind);
    const flow = kind === 'openai' ? flows.open : flows.claude;
    await act(async () => {
      flow.onConnection(connection);
      await (kind === 'openai' ? flow.onAuthorized() : flow.onImported());
    });
    expect(vi.mocked(api).mock.calls.map((call) => call[0])).toEqual([
      '/api/settings/model-connections/discover',
      '/api/settings/model-connections',
      '/api/settings/model-connections',
    ]);
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body)).models).toEqual([
      { id: 'm1', discoveredInput: ['text'], selected: true, acceptedInput: ['text'] },
    ]);
    expect(setProviders).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'c1', models: ['m1'] }),
    ]);
    expect(setConnectionId).toHaveBeenCalledWith('c1');
    expect(setModel).toHaveBeenCalledWith('m1');
    expect(result.current.oauthProvider).toBeNull();
  },
);

it('reset clears the connection and resets both flows', async () => {
  const { result } = renderHook(() =>
    useWizardOAuthProvisioning({
      setProviders: vi.fn(),
      setConnectionId: vi.fn(),
      setModel: vi.fn(),
    }),
  );
  await act(() => result.current.startWizardOAuth('openai'));
  act(() => {
    flows.open.onConnection({ id: 'old' });
    result.current.resetWizardOAuth();
  });
  expect(result.current.oauthProvider).toBeNull();
  expect(flows.resetOpen).toHaveBeenCalledTimes(2);
  expect(flows.resetClaude).toHaveBeenCalledTimes(2);
  await expect(flows.open.onAuthorized()).rejects.toThrow('connection details were unavailable');
  expect(api).not.toHaveBeenCalled();
});

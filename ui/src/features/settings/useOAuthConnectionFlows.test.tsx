import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelConnectionsApi, type ClaudeCodeLogin, type OpenAiOAuthLogin } from './modelConnectionsApi';
import { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';

vi.mock('./modelConnectionsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modelConnectionsApi')>()),
  modelConnectionsApi: {
    discover: vi.fn(),
    startOpenAiOAuth: vi.fn(),
    getOpenAiOAuthLogin: vi.fn(),
    submitOpenAiOAuthCode: vi.fn(),
    cancelOpenAiOAuth: vi.fn(),
    startClaudeCodeLogin: vi.fn(),
    getClaudeCodeLogin: vi.fn(),
    submitClaudeCode: vi.fn(),
    cancelClaudeCodeLogin: vi.fn(),
    importClaudeCodeLogin: vi.fn(),
  },
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const openAiLogin = (status: string): OpenAiOAuthLogin => ({ id: 'openai-login', status });
const claudeLogin = (status: string): ClaudeCodeLogin => ({ id: 'claude-login', status });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OAuth connection flow polling', () => {
  it('serializes OpenAI polling and completes an authorized login once', async () => {
    vi.mocked(modelConnectionsApi.startOpenAiOAuth).mockResolvedValue({ connection: { id: 'openai' }, login: openAiLogin('waiting_for_callback') });
    const poll = deferred<{ login: OpenAiOAuthLogin }>();
    vi.mocked(modelConnectionsApi.getOpenAiOAuthLogin).mockReturnValue(poll.promise);
    const onConnection = vi.fn();
    const onAuthorized = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useOpenAiOAuthConnectionFlow({ onConnection, onAuthorized }));

    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(modelConnectionsApi.getOpenAiOAuthLogin).toHaveBeenCalledOnce();

    await act(async () => poll.resolve({ login: { ...openAiLogin('authorized'), connection: { id: 'openai' } } }));
    expect(onAuthorized).toHaveBeenCalledOnce();
    expect(onConnection).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(onAuthorized).toHaveBeenCalledOnce();
  });

  it('ignores an obsolete OpenAI poll after reset', async () => {
    vi.mocked(modelConnectionsApi.startOpenAiOAuth).mockResolvedValue({ connection: { id: 'openai' }, login: openAiLogin('waiting_for_callback') });
    const poll = deferred<{ login: OpenAiOAuthLogin }>();
    vi.mocked(modelConnectionsApi.getOpenAiOAuthLogin).mockReturnValue(poll.promise);
    const onAuthorized = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useOpenAiOAuthConnectionFlow({ onConnection: vi.fn(), onAuthorized }));

    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    act(() => result.current.reset());
    await act(async () => poll.resolve({ login: { ...openAiLogin('authorized'), connection: { id: 'openai' } } }));

    expect(result.current.login).toBeNull();
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it('ignores a start response after the OpenAI flow unmounts', async () => {
    const start = deferred<{ connection: { id: string }; login: OpenAiOAuthLogin }>();
    vi.mocked(modelConnectionsApi.startOpenAiOAuth).mockReturnValue(start.promise);
    const onConnection = vi.fn();
    const view = renderHook(() => useOpenAiOAuthConnectionFlow({ onConnection, onAuthorized: vi.fn().mockResolvedValue(undefined) }));

    act(() => { void view.result.current.start(); });
    view.unmount();
    await act(async () => start.resolve({ connection: { id: 'openai' }, login: openAiLogin('waiting_for_callback') }));
    expect(onConnection).not.toHaveBeenCalled();
  });

  it('serializes Claude polling and ignores an obsolete response after reset', async () => {
    vi.mocked(modelConnectionsApi.startClaudeCodeLogin).mockResolvedValue({ connection: { id: 'claude' }, login: claudeLogin('waiting_for_code') });
    const poll = deferred<{ login: ClaudeCodeLogin }>();
    vi.mocked(modelConnectionsApi.getClaudeCodeLogin).mockReturnValue(poll.promise);
    const { result } = renderHook(() => useClaudeCodeLoginFlow({ onConnection: vi.fn(), onImported: vi.fn().mockResolvedValue(undefined) }));

    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(modelConnectionsApi.getClaudeCodeLogin).toHaveBeenCalledOnce();

    act(() => result.current.reset());
    await act(async () => poll.resolve({ login: claudeLogin('ready_to_import') }));
    expect(result.current.login).toBeNull();
  });

  it('auto-imports each authorized Claude login only once', async () => {
    vi.mocked(modelConnectionsApi.startClaudeCodeLogin).mockResolvedValue({ connection: { id: 'claude' }, login: claudeLogin('authorized') });
    vi.mocked(modelConnectionsApi.importClaudeCodeLogin).mockResolvedValue({ login: claudeLogin('imported') });
    const onImported = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useClaudeCodeLoginFlow({ onConnection: vi.fn(), onImported, autoImport: true }));

    await act(() => result.current.start());
    await act(async () => undefined);

    expect(modelConnectionsApi.importClaudeCodeLogin).toHaveBeenCalledOnce();
    expect(onImported).toHaveBeenCalledOnce();
  });
});

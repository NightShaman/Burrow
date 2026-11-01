import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from './api';
import { useModelSelectionWriter } from './useModelSelectionWriter';
import type { Agent, SavedProvider } from './types';
vi.mock('./api', () => ({ api: vi.fn() }));
it('serializes rapid intents, merges patches and ignores old acknowledgements', async () => {
  const agent = {
    id: 'a',
    provider: 'Fixture',
    model: 'one',
    effort: 'low',
    temperature: 0.2,
  } as Agent;
  const provider = { id: 'p', provider: 'Fixture', models: ['one', 'two'] } as SavedProvider;
  let release!: (value: unknown) => void;
  vi.mocked(api)
    .mockImplementationOnce((_path, _init) => new Promise((resolve) => (release = resolve)))
    .mockResolvedValueOnce({
      selection: { model: 'two', reasoningEffort: 'low', temperature: 0.9 },
    });
  const commit = vi.fn(),
    report = vi.fn();
  const { result } = renderHook(() => useModelSelectionWriter([provider], commit, report));
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current(agent, { temperature: 0.1 });
  });
  act(() => {
    void result.current(agent, { temperature: 0.9 });
    void result.current(agent, { model: 'two' });
  });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({ selection: { model: 'one', reasoningEffort: 'low', temperature: 0.1 } });
    await pending;
  });
  expect(api).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toMatchObject({
    model: 'two',
    temperature: 0.9,
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ model: 'two', temperature: 0.9 }),
  );
  expect(report).not.toHaveBeenCalled();
});

it('persists native mode independently, preserving raw default effort and captured owner', async () => {
  const provider = {
    id: 'p',
    provider: 'Native',
    apiType: 'anthropic-messages',
    models: ['native'],
  } as SavedProvider;
  const agent = {
    id: 'ui-a',
    resourceId: 'resource/a',
    provider: 'Native',
    model: 'native',
    thinkingMode: 'adaptive',
    effort: 'off',
    temperature: 0.2,
  } as Agent;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({
    selection: {
      model: 'native',
      thinkingMode: 'between_tools',
      reasoningEffort: 'off',
      temperature: 0.2,
    },
  });
  const commit = vi.fn();
  const { result } = renderHook(() => useModelSelectionWriter([provider], commit, vi.fn()));
  await act(async () => {
    expect(await result.current(agent, { thinkingMode: 'between_tools' })).toBe(true);
  });
  expect(vi.mocked(api).mock.calls[0][0]).toBe('/api/agents/resource%2Fa/model-selection');
  expect(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)).toEqual({
    connectionId: 'p',
    model: 'native',
    thinkingMode: 'between_tools',
    reasoningEffort: 'off',
    temperature: 0.2,
  });
  expect(commit).toHaveBeenCalledWith(
    'ui-a',
    expect.objectContaining({ thinkingMode: 'between_tools', effort: 'off' }),
  );
});

it('waits for queued native intent acknowledgement and reports its failure to every waiter', async () => {
  const provider = {
    id: 'p',
    provider: 'Native',
    apiType: 'anthropic-messages',
    models: ['native'],
  } as SavedProvider;
  const agent = {
    id: 'a',
    provider: 'Native',
    model: 'native',
    thinkingMode: 'default',
    effort: 'off',
    temperature: 0.2,
  } as Agent;
  let release!: (value: unknown) => void;
  vi.mocked(api).mockReset();
  vi.mocked(api)
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockRejectedValueOnce(new Error('rejected mode'));
  const commit = vi.fn(),
    report = vi.fn();
  const { result } = renderHook(() => useModelSelectionWriter([provider], commit, report));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  const settled = vi.fn();
  act(() => {
    first = result.current(agent, { temperature: 0.7 });
    second = result.current(agent, { thinkingMode: 'adaptive' });
    void second.then(settled);
  });
  expect(settled).not.toHaveBeenCalled();
  await act(async () => {
    release({
      selection: {
        model: 'native',
        reasoningEffort: 'off',
        thinkingMode: 'default',
        temperature: 0.7,
      },
    });
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });
  expect(commit).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(expect.stringContaining('rejected mode'));
  expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toMatchObject({
    thinkingMode: 'adaptive',
    reasoningEffort: 'off',
    temperature: 0.7,
  });
});

it('rejects a native acknowledgement that silently substitutes mode or effort', async () => {
  const provider = {
    id: 'p',
    provider: 'Native',
    apiType: 'anthropic-messages',
    models: ['native'],
  } as SavedProvider;
  const agent = {
    id: 'a',
    provider: 'Native',
    model: 'native',
    thinkingMode: null,
    effort: 'off',
    temperature: 0.2,
  } as Agent;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({
    selection: { model: 'native', reasoningEffort: 'high', thinkingMode: 'default' },
  });
  const commit = vi.fn(),
    report = vi.fn();
  const { result } = renderHook(() => useModelSelectionWriter([provider], commit, report));
  await act(async () => {
    expect(await result.current(agent, { thinkingMode: 'adaptive' })).toBe(false);
  });
  expect(commit).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(expect.stringContaining('acknowledgement'));
});

it('sends independent native mode through an Anthropic pool and reports pending lifetime', async () => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({
    selection: {
      model: 'native',
      thinkingMode: 'adaptive',
      reasoningEffort: 'off',
      temperature: 0.2,
    },
  });
  const agent = {
    id: 'a',
    provider: 'Pool',
    model: 'native',
    thinkingMode: null,
    effort: 'off',
    temperature: 0.2,
  } as Agent;
  const provider = {
    id: 'p',
    provider: 'Pool',
    apiType: 'anthropic-lb',
    models: ['native'],
  } as SavedProvider;
  const pending = vi.fn();
  const { result } = renderHook(() =>
    useModelSelectionWriter([provider], vi.fn(), vi.fn(), pending),
  );
  await act(async () => {
    await result.current(agent, { thinkingMode: 'adaptive' });
  });
  expect(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)).toMatchObject({
    thinkingMode: 'adaptive',
    reasoningEffort: 'off',
  });
  expect(pending.mock.calls).toEqual([
    ['a', true],
    ['a', false],
  ]);
});

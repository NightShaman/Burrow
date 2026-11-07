import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatModelSelector } from './ChatModelSelector';
import { useModelSelectionWriter } from '../../app/useModelSelectionWriter';
import { api } from '../../app/api';
import type { Agent, SavedProvider } from '../../app/types';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const provider = { id: 'lb', provider: 'LB', models: ['model'] } as SavedProvider;
const agent = {
  id: 'a',
  provider: 'LB',
  modelConnectionId: 'lb',
  model: 'model',
  effort: 'low',
  temperature: 0.2,
} as Agent;
const props = {
  selected: agent,
  savedProviders: [provider],
  updateAgent: vi.fn(),
  sessions: [{ id: 'default' }],
  sessionId: 'default',
  onSessionChange: vi.fn(),
  onNewSession: vi.fn(),
  onNewNamedSession: vi.fn(),
  onCreateGroup: vi.fn(),
};
const slider = () => screen.getByRole('slider') as HTMLInputElement;
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
it('shows each movement immediately and stays enabled during slow saves, ignoring older completion', async () => {
  const first = deferred(),
    second = deferred();
  const updateAgent = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
  fireEvent.change(slider(), { target: { value: '0.7' } });
  view.rerender(<ChatModelSelector {...props} updateAgent={updateAgent} savingSelection />);
  expect(slider().disabled).toBe(false);
  expect(slider().hasAttribute('data-saving-disabled')).toBe(false);
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('combobox', { name: 'Model' }).getAttribute('data-saving-disabled')).toBe(
    'true',
  );
  expect(screen.getByRole('status').classList.contains('sr-only')).toBe(true);
  expect(slider().value).toBe('0.7');
  fireEvent.change(slider(), { target: { value: '1.4' } });
  expect(slider().value).toBe('1.4');
  expect(screen.getByText('1.4')).toBeTruthy();
  await act(async () => {
    first.resolve(true);
    await first.promise;
  });
  expect(slider().value).toBe('1.4');
  view.rerender(
    <ChatModelSelector
      {...props}
      selected={{ ...agent, temperature: 1.4 }}
      updateAgent={updateAgent}
    />,
  );
  await act(async () => {
    second.resolve(true);
    await second.promise;
  });
  expect(slider().value).toBe('1.4');
});
it.each([false, 'reject'])('restores confirmed value after save failure %s', async (failure) => {
  const pending = deferred();
  render(<ChatModelSelector {...props} updateAgent={() => pending.promise} />);
  fireEvent.change(slider(), { target: { value: '1.2' } });
  expect(slider().value).toBe('1.2');
  await act(async () => {
    if (failure === false) pending.resolve(false);
    else pending.reject(new Error('offline'));
  });
  expect(slider().value).toBe('0.2');
});
it('keeps pending values owner-scoped and does not clear a returned owner with a departed completion', async () => {
  const a = deferred(),
    b = deferred();
  const updateAgent = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const view = render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
  fireEvent.change(slider(), { target: { value: '1.1' } });
  view.rerender(
    <ChatModelSelector
      {...props}
      selected={{ ...agent, id: 'b', temperature: 0.6 }}
      updateAgent={updateAgent}
    />,
  );
  expect(slider().value).toBe('0.6');
  fireEvent.change(slider(), { target: { value: '1.8' } });
  view.rerender(<ChatModelSelector {...props} updateAgent={updateAgent} />);
  expect(slider().value).toBe('1.1');
  await act(async () => {
    b.resolve(false);
  });
  expect(slider().value).toBe('1.1');
  await act(async () => {
    a.resolve(false);
  });
  expect(slider().value).toBe('0.2');
});
it('retains deliberate locks, unavailable connections and unrelated save locks', () => {
  const view = render(<ChatModelSelector {...props} locked />);
  expect(slider().disabled).toBe(true);
  expect(slider().hasAttribute('data-saving-disabled')).toBe(false);
  expect(screen.getByRole('combobox', { name: 'Model' }).hasAttribute('data-saving-disabled')).toBe(
    false,
  );
  view.rerender(<ChatModelSelector {...props} savingSelection />);
  expect(slider().disabled).toBe(true);
  expect(slider().getAttribute('data-saving-disabled')).toBe('true');
  view.rerender(<ChatModelSelector {...props} savedProviders={[]} />);
  expect(slider().disabled).toBe(true);
  expect(slider().hasAttribute('data-saving-disabled')).toBe(false);
});
it('coalesces a continuous drag through the real writer and persists the final value', async () => {
  const first = deferred(),
    last = deferred();
  vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const report = vi.fn();
  function Harness() {
    const [selected, setSelected] = useState(agent);
    const [pending, setPending] = useState(false);
    const write = useModelSelectionWriter(
      [provider],
      (_id, patch) => setSelected((current) => ({ ...current, ...patch })),
      report,
      (_id, busy) => setPending(busy),
    );
    return (
      <ChatModelSelector
        {...props}
        selected={selected}
        savingSelection={pending}
        updateAgent={(patch) => write(selected, patch)}
      />
    );
  }
  render(<Harness />);
  fireEvent.change(slider(), { target: { value: '0.5' } });
  expect(slider().disabled).toBe(false);
  fireEvent.change(slider(), { target: { value: '1.0' } });
  fireEvent.change(slider(), { target: { value: '1.7' } });
  expect(slider().value).toBe('1.7');
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.resolve({ selection: { model: 'model', reasoningEffort: 'low', temperature: 0.5 } });
  });
  expect(api).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string).temperature).toBe(1.7);
  expect(slider().value).toBe('1.7');
  await act(async () => {
    last.resolve({ selection: { model: 'model', reasoningEffort: 'low', temperature: 1.7 } });
  });
  await waitFor(() => expect(slider().value).toBe('1.7'));
  expect(slider().disabled).toBe(false);
  expect(report).not.toHaveBeenCalled();
});

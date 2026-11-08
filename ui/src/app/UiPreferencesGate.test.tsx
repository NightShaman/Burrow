import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  retry: vi.fn(),
  status: 'saved',
  listeners: new Set<() => void>(),
}));
vi.mock('./uiPreferences', () => ({
  uiPreferenceSync: {
    initialize: mocks.initialize,
    retry: mocks.retry,
    getStatus: () => mocks.status,
    subscribe: (fn: () => void) => {
      mocks.listeners.add(fn);
      return () => mocks.listeners.delete(fn);
    },
  },
}));
import { UiPreferencesGate } from './UiPreferencesGate';
afterEach(cleanup);
beforeEach(() => {
  mocks.status = 'saved';
  mocks.listeners.clear();
  mocks.initialize.mockReset();
  mocks.retry.mockReset();
});

it('does not mount preference hooks until hydration completes', async () => {
  let resolve!: () => void;
  mocks.initialize.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const child = vi.fn(() => <div>Workspace</div>);
  const Child = child;
  render(
    <UiPreferencesGate>
      <Child />
    </UiPreferencesGate>,
  );
  expect(screen.getByRole('status').textContent).toBe('Restoring your workspace…');
  expect(child).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(screen.getByText('Workspace')).toBeTruthy();
});

it('shows a recoverable load failure and retries without mounting defaults', async () => {
  mocks.initialize.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  render(
    <UiPreferencesGate>
      <div>Workspace</div>
    </UiPreferencesGate>,
  );
  await screen.findByRole('alert');
  expect(screen.queryByText('Workspace')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Workspace');
  expect(mocks.initialize).toHaveBeenCalledTimes(2);
});

it('offers explicit browser-only recovery with an honest unsynced warning', async () => {
  mocks.initialize.mockRejectedValueOnce(new Error('offline'));
  render(
    <UiPreferencesGate>
      <div>Workspace</div>
    </UiPreferencesGate>,
  );
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Use this browser only' }));
  expect(screen.getByText('Workspace')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Changes will not follow you');
});

it('keeps the workspace mounted during save errors and retry', async () => {
  mocks.initialize.mockResolvedValue(undefined);
  const Child = vi.fn(() => <div>Workspace</div>);
  render(
    <UiPreferencesGate>
      <Child />
    </UiPreferencesGate>,
  );
  await screen.findByText('Workspace');
  const mounted = Child.mock.calls.length;
  act(() => {
    mocks.status = 'error';
    mocks.listeners.forEach((fn) => fn());
  });
  expect(screen.getByRole('alert').textContent).toContain("haven't synced");
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(mocks.retry).toHaveBeenCalledTimes(1);
  expect(Child).toHaveBeenCalledTimes(mounted);
});

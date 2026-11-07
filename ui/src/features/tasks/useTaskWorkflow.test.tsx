import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { useTaskWorkflow } from './useTaskWorkflow';
import type { BoardTask } from './taskDomain';

const task: BoardTask = {
  id: 'a',
  projectId: 'p',
  title: 'Original',
  description: '',
  status: 'todo',
  priority: 'normal',
  assignedAgentId: 'agent',
  metadata: {},
  createdAt: '1',
  updatedAt: '1',
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('polls board data without replacing the opening snapshot or dirty draft, and aborts on cleanup', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/projects'))
      return response({ projects: [{ id: 'p', name: 'Project' }] });
    signal = init?.signal;
    return response({ tasks: [{ ...task, title: init?.signal ? 'Remote' : 'Original' }] });
  });
  vi.stubGlobal('fetch', fetch);
  const { result, unmount } = renderHook(() => useTaskWorkflow(), { wrapper: ConfirmProvider });
  await act(async () => {});
  act(() => result.current.setEditor({ mode: 'edit', task }));
  act(() => result.current.changeDraft('title', 'Dirty'));
  const owner = result.current.editor?.owner;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(result.current.tasks[0].title).toBe('Remote');
  expect(result.current.editingTask?.title).toBe('Original');
  expect(result.current.draft.title).toBe('Dirty');
  expect(result.current.editor?.owner).toBe(owner);
  unmount();
  expect(signal?.aborted).toBe(true);
  const count = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(count);
});

it('late execution updates board but cannot reconcile or dispatch into a reopened same-task editor', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/execute')) return pending;
      return response(
        String(input).endsWith('/projects')
          ? { projects: [{ id: 'p', name: 'Project' }] }
          : { tasks: [task] },
      );
    }),
  );
  const dispatch = vi.fn();
  const { result } = renderHook(() => useTaskWorkflow(dispatch), { wrapper: ConfirmProvider });
  await act(async () => {});
  act(() => result.current.setEditor({ mode: 'edit', task }));
  let execution!: Promise<void>;
  act(() => {
    execution = result.current.executeTask();
  });
  expect(result.current.saving).toBe(true);
  const oldOwner = result.current.editor?.owner;
  act(() => {
    result.current.setEditor(null);
    result.current.setEditor({ mode: 'edit', task });
  });
  act(() => result.current.changeDraft('description', 'New opening'));
  expect(result.current.editor?.owner).not.toBe(oldOwner);
  expect(result.current.saving).toBe(false);
  await act(async () => {
    finish(
      response({
        task: { ...task, status: 'in_progress' },
        execution: { sessionId: 's', agentId: 'agent' },
      }),
    );
    await execution;
  });
  expect(result.current.tasks[0].status).toBe('in_progress');
  expect(result.current.editingTask?.status).toBe('todo');
  expect(result.current.draft.description).toBe('New opening');
  expect(result.current.pending.size).toBe(0);
  expect(dispatch).not.toHaveBeenCalled();
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { archiveRepository, type ArchivePage } from './archiveRepository';
import type { ArchiveWorkflowEvent } from './archiveTypes';
import { WorkflowEventsArchiveShelf, workflowArchiveRunUrl } from './WorkflowEventsArchiveShelf';

const event = (id: string, agentId = 'a'): ArchiveWorkflowEvent => ({
  id, agentId, watchId: 'watch', repository: 'owner/repo', workflow: `CI ${id}`,
  runId: '123', runAttempt: 2, headSha: 'abc123', conclusion: 'failure',
  url: 'https://github.com/owner/repo/actions/runs/123', completedAt: '2026-10-25T10:00:00Z',
  sessionId: 'ci-session', instruction: 'Inspect CI', status: 'succeeded', createdAt: '2026-10-25T10:01:00Z',
});
const page = (items: ArchiveWorkflowEvent[], nextCursor: string | null = null): ArchivePage<ArchiveWorkflowEvent> => ({ items, nextCursor, hasMore: !!nextCursor });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const props = { archiveRepository, selectedAgent: '', selectedDate: '', search: '', queryKey: 'initial', agentNames: new Map([['a', 'Agent A']]) };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows cold loading, empty, error and shelf-only retry', async () => {
  const pending = deferred<ArchivePage<ArchiveWorkflowEvent>>();
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents').mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([]));
  render(<WorkflowEventsArchiveShelf {...props} />);
  expect(screen.getByRole('status').textContent).toContain('Loading workflow events');
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  await act(async () => pending.reject(new Error('Archive offline')));
  expect(screen.getByRole('alert').textContent).toContain('Archive offline');
  expect(screen.queryByText('No workflow events match this shelf.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry workflow events' }));
  await screen.findByText('No workflow events match this shelf.');
  expect(list).toHaveBeenCalledTimes(2);
});

it('shows received time in the list and retains both timestamps in details', async () => {
  vi.spyOn(archiveRepository, 'listWorkflowEvents').mockResolvedValue(page([event('one')]));
  const row = await screenRow();
  expect(row.textContent).toContain(`Received ${new Date(event('one').createdAt).toLocaleString()}`);
  expect(row.textContent).not.toContain(new Date(event('one').completedAt!).toLocaleString());
  fireEvent.click(row);
  const reader = within(screen.getByRole('region', { name: 'Workflow event details' }));
  expect(reader.getByText(new Date(event('one').createdAt).toLocaleString())).toBeTruthy();
  expect(reader.getByText(new Date(event('one').completedAt!).toLocaleString())).toBeTruthy();
});

async function screenRow() {
  render(<WorkflowEventsArchiveShelf {...props} />);
  return screen.findByRole('button', { name: /CI one/ });
}

it('reads literal event details and separates GitHub conclusion from Burrow handling', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  vi.spyOn(archiveRepository, 'listWorkflowEvents').mockResolvedValue(page([{ ...event('one'), instruction: payload, result: { output: '<script>bad()</script>' }, error: '<b>literal error</b>', chatRunId: 'burrow-run' }]));
  const { container } = render(<WorkflowEventsArchiveShelf {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /CI one/ }));
  const reader = within(screen.getByRole('region', { name: 'Workflow event details' }));
  expect(reader.getByText('failure')).toBeTruthy();
  expect(reader.getByText('succeeded')).toBeTruthy();
  expect(reader.getByText(payload)).toBeTruthy();
  expect(reader.getByText(/"output": "<script>bad/)).toBeTruthy();
  expect(reader.getByText('ci-session')).toBeTruthy();
  expect(reader.getByText('burrow-run')).toBeTruthy();
  expect(reader.getByText('Agent A')).toBeTruthy();
  expect(container.querySelector('img, script')).toBeNull();
  const link = reader.getByRole('link', { name: 'Open GitHub run #123' });
  expect(link.getAttribute('href')).toBe(event('one').url);
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it.each(['javascript:alert(1)', 'https://github.com.evil.invalid/o/r/actions/runs/1', 'https://github.com@evil.invalid/o/r/actions/runs/1', 'http://github.com/o/r/actions/runs/1', 'https://user:pass@github.com/o/r/actions/runs/1', 'https://github.com/o/r', 'https://github.com/o/r/actions/runs/1?secret=x'])('does not link unsafe event URL %s', async url => {
  expect(workflowArchiveRunUrl(url)).toBeUndefined();
  vi.spyOn(archiveRepository, 'listWorkflowEvents').mockResolvedValue(page([{ ...event('unsafe'), url }]));
  render(<WorkflowEventsArchiveShelf {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /CI unsafe/ }));
  expect(screen.queryByRole('link')).toBeNull();
});

it('paginates with the same filters, deduplicates identity and preserves selection on failure/retry', async () => {
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents')
    .mockResolvedValueOnce(page([event('one')], 'next'))
    .mockRejectedValueOnce(new Error('More offline'))
    .mockResolvedValueOnce(page([event('one'), event('one', 'b'), event('two')]));
  render(<WorkflowEventsArchiveShelf {...props} selectedAgent="a" selectedDate="2026-10-25" search="CI" />);
  fireEvent.click(await screen.findByRole('button', { name: /CI one/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more workflow events' }));
  await screen.findByText('More offline');
  expect(screen.getByRole('heading', { level: 2, name: 'CI one' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry more workflow events' }));
  await screen.findByRole('button', { name: /CI two/ });
  expect(screen.getAllByRole('button', { name: /CI one/ })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Load more workflow events' })).toBeNull();
  expect(list).toHaveBeenLastCalledWith('CI', expect.any(AbortSignal), 'next', '2026-10-25', 'a');
});

it.each(['search', 'selectedAgent', 'selectedDate', 'unmount'] as const)('aborts pending pagination and discards late rows on %s change', async change => {
  const pending = deferred<ArchivePage<ArchiveWorkflowEvent>>();
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents').mockImplementation((_q, _signal, cursor) => cursor ? pending.promise : Promise.resolve(page([event('one')], 'next')));
  const view = render(<WorkflowEventsArchiveShelf {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /CI one/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more workflow events' }));
  const signal = list.mock.calls.at(-1)![1];
  if (change === 'unmount') view.unmount();
  else view.rerender(<WorkflowEventsArchiveShelf {...props} {...{ [change]: 'changed' }} queryKey={change} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(page([event('intruder')])));
  expect(screen.queryByText('CI intruder')).toBeNull();
  expect(screen.queryByRole('heading', { level: 2, name: 'CI one' })).toBeNull();
});

it('ignores an older first-page rejection after a filter replacement', async () => {
  const old = deferred<ArchivePage<ArchiveWorkflowEvent>>();
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents').mockReturnValueOnce(old.promise).mockResolvedValue(page([event('current')]));
  const view = render(<WorkflowEventsArchiveShelf {...props} />);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  view.rerender(<WorkflowEventsArchiveShelf {...props} search="current" queryKey="current" />);
  expect(list.mock.calls[0][1]?.aborted).toBe(true);
  await screen.findByRole('button', { name: /CI current/ });
  await act(async () => old.reject(new Error('Late failure')));
  expect(screen.queryByText('Late failure')).toBeNull();
});

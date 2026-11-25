import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskActivity } from './TaskActivity';
import { ConfirmProvider } from '../../app/ConfirmDialog';
const actor = { type: 'operator', id: 'default', name: 'Rob' };
const event = (id: string) => ({
  id,
  action: id,
  actor,
  at: '2026-10-18',
  changes: { status: { before: 'todo', after: 'done' } },
  details: {},
  runId: 'r',
  sessionId: 's',
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  failUpload = false,
  waits = async (_url: string) => response({ waits: [], hasMore: false, nextCursor: null }),
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'POST')
        return failUpload
          ? response({ error: 'task_attachment_too_large' }, 413)
          : response({ ok: true });
      if (url.includes('/workflow-waits?')) return waits(url);
      if (url.includes('/attachments')) return response({ attachments: [] });
      return response(
        url.includes('before=')
          ? { events: [event('oldest')], hasMore: false, nextCursor: null }
          : { events: [event('newest'), event('middle')], hasMore: true, nextCursor: 'key+/=' },
      );
    }),
  );
  render(
    <ConfirmProvider>
      <TaskActivity taskId="t" revision="1" />
    </ConfirmProvider>,
  );
  return calls;
}
it('reverses newest-first pages and prepends older history with opaque cursor', async () => {
  const calls = fixture();
  await screen.findByText('middle');
  expect(
    screen.getAllByRole('listitem').map((el) => el.querySelector('strong')?.textContent),
  ).toEqual(['middle', 'newest']);
  fireEvent.click(screen.getByText('Load older activity'));
  await screen.findByText('oldest');
  expect(
    screen.getAllByRole('listitem').map((el) => el.querySelector('strong')?.textContent),
  ).toEqual(['oldest', 'middle', 'newest']);
  expect(calls.some((c) => c.url.endsWith('before=key%2B%2F%3D'))).toBe(true);
  expect(screen.getAllByText('status: todo → done')).toHaveLength(3);
});
it('uploads a JSON data URL and refreshes history', async () => {
  const calls = fixture();
  await screen.findByText('middle');
  fireEvent.change(screen.getByLabelText('Attach document'), {
    target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
  });
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  const payload = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
  expect(payload).toEqual({
    name: 'notes.txt',
    mimeType: 'text/plain',
    content: 'data:text/plain;base64,aGVsbG8=',
  });
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/history')).length).toBe(2));
});
it('retains activity and exposes upload rejection', async () => {
  fixture(true);
  await screen.findByText('middle');
  fireEvent.change(screen.getByLabelText('Attach document'), {
    target: { files: [new File(['x'], 'x.txt')] },
  });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('middle')).toBeTruthy();
});
it('omits technical disclosures and uses an intentional upload button', async () => {
  fixture();
  await screen.findByText('middle');
  expect(screen.getByRole('button', { name: 'Attach document' })).toBeTruthy();
  expect(screen.getByLabelText('Attach document').hasAttribute('hidden')).toBe(true);
  expect(document.querySelector('details')).toBeNull();
  expect(screen.queryByText('Session: s · Run: r')).toBeNull();
  expect(
    screen
      .getByRole('button', { name: 'Attach document' })
      .classList.contains('task-attach-button'),
  ).toBe(true);
});
it('shows unknown attribution honestly without exposing an actor ID', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      response(
        String(input).includes('/workflow-waits?')
          ? { waits: [], hasMore: false, nextCursor: null }
          : String(input).includes('/attachments')
            ? { attachments: [] }
            : {
                events: [
                  {
                    ...event('created'),
                    actor: { type: 'unknown', id: null, name: null },
                    runId: null,
                    sessionId: null,
                  },
                ],
                hasMore: false,
                nextCursor: null,
              },
      ),
    ),
  );
  render(
    <ConfirmProvider>
      <TaskActivity taskId="t" revision="1" />
    </ConfirmProvider>,
  );
  expect(await screen.findByText('Unknown actor')).toBeTruthy();
});

const wait = {
  id: 'wait1',
  repository: 'NightShaman/Burrow',
  workflow: 'Public release',
  runId: '991',
  runAttempt: 2,
  headSha: 'b'.repeat(40),
  checkpoint: 'Verify the frozen tree.\nDo not publish.',
  status: 'waiting',
  reason: null,
  reasonCode: null,
  registeredAt: '2026-11-24T18:10:00Z',
  matchedAt: null,
  resumedAt: null,
  finishedAt: null,
  source: { agentId: 'hatchet', sessionId: 'default', runId: 'source-run' },
  trigger: null,
  continuation: null,
  outcome: null,
};
const waitsPage = (waits: unknown[], nextCursor: string | null = null) =>
  response({ ok: true, waits, nextCursor, hasMore: !!nextCursor });

it('refreshes a wait on the same task and keeps admission, GitHub conclusion and actual outcome separate', async () => {
  const resumed = {
    ...wait,
    status: 'resumed',
    reason: 'Exact workflow completion admitted',
    trigger: { id: 'delivery2', conclusion: 'failure', completedAt: '2026-11-24T18:15:00Z' },
    continuation: { agentId: 'hatchet', sessionId: 'default', runId: 'resumed-run' },
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(waitsPage([wait]))
    .mockResolvedValueOnce(waitsPage([resumed]))
    .mockResolvedValueOnce(
      waitsPage([
        {
          ...resumed,
          outcome: {
            status: 'completed',
            result: { answerText: 'Reviewed upstream failure; nothing published.' },
          },
        },
      ]),
    );
  fixture(false, read);
  fireEvent.click((await screen.findByText('Waiting')).closest('summary')!);
  expect(screen.getByText('NightShaman/Burrow · #991 · attempt 2')).toBeTruthy();
  expect(screen.getByText(wait.headSha)).toBeTruthy();
  expect(screen.getByText('Verify the frozen tree. Do not publish.').textContent).toBe(
    wait.checkpoint,
  );
  expect(screen.queryByText('Continuation outcome')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  await screen.findByText('No outcome recorded yet');
  expect(screen.getByText('failure')).toBeTruthy();
  expect(screen.getByText('delivery2')).toBeTruthy();
  expect(screen.getByText('hatchet / default / resumed-run')).toBeTruthy();
  expect(screen.getByText('Exact workflow completion admitted')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  await screen.findByText('Reviewed upstream failure; nothing published.');
  expect(screen.getByText('completed')).toBeTruthy();
  expect(read.mock.calls.map(([url]) => url)).toEqual(
    Array(3).fill('/api/task-board/tasks/t/workflow-waits?limit=50'),
  );
});

it('retains documents/history on wait read failure and retries the failed older page without duplicating waits', async () => {
  const expired = {
    ...wait,
    id: 'older',
    status: 'skipped',
    reason: 'Task was cancelled before admission',
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(response({ error: 'wait_read_failed' }, 503))
    .mockResolvedValueOnce(waitsPage([wait], 'wait+/='))
    .mockResolvedValueOnce(response({ error: 'page_read_failed' }, 503))
    .mockResolvedValueOnce(waitsPage([wait, expired]));
  fixture(false, read);
  expect((await screen.findByRole('alert')).textContent).toContain('wait_read_failed');
  expect(screen.getByText('middle')).toBeTruthy();
  expect(screen.getByText('No documents attached.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry workflow waits' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load older waits' }));
  expect((await screen.findByRole('alert')).textContent).toContain('page_read_failed');
  expect(screen.getByText('Waiting')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry workflow waits' }));
  fireEvent.click((await screen.findByText('Skipped')).closest('summary')!);
  expect(screen.getByText(expired.reason)).toBeTruthy();
  expect(screen.queryByText('Continuation run')).toBeNull();
  expect(document.querySelectorAll('.task-wait-record')).toHaveLength(2);
  expect(read.mock.calls.slice(2).map(([url]) => url)).toEqual(
    Array(2).fill('/api/task-board/tasks/t/workflow-waits?limit=50&cursor=wait%2B%2F%3D'),
  );
});

it('discards a superseded wait page when the first page is refreshed', async () => {
  let finish!: (value: Response) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(waitsPage([wait], 'older'))
    .mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)))
    .mockResolvedValueOnce(waitsPage([{ ...wait, status: 'matched' }]));
  fixture(false, read);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older waits' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  await screen.findByText('Matched');
  await act(async () => finish(waitsPage([{ ...wait, id: 'stale', workflow: 'Stale wait' }])));
  expect(screen.queryByText(/Stale wait/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load older waits' })).toBeNull();
});

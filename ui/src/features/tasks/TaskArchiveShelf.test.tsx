import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskArchiveShelf, taskArchiveDate } from './TaskArchiveShelf';
import { Tasks } from './TasksPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
const task = { id: 'archived', projectId: 'p', title: 'Completed interface', description: 'The complete details', status: 'done', priority: 'normal', assignedAgentId: null, metadata: {}, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z', archivedAt: '2026-10-22T12:00:00Z', archived: true };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function setup(fail = false) {
 const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/projects')) return response({ projects: [{ id: 'p', name: 'Burrow' }] });
  if (init?.method === 'PATCH') return fail ? new Response('unavailable', { status: 500 }) : response({ task: { ...task, status: 'todo', archived: false, archivedAt: null } });
  if (url.endsWith('/attachments')) return response({ attachments: [{ id: 'f', name: 'result.txt', size: 12, createdAt: task.createdAt, createdBy: { type: 'operator', name: 'Rob' } }] });
  if (url.includes('/history?')) return response({ events: [{ id: 'e', action: 'updated', at: task.updatedAt, actor: { type: 'operator', name: 'Rob' }, changes: { status: { before: 'review', after: 'done' } }, details: {} }], hasMore: false });
  return response({ tasks: [task, { ...task, id: 'fresh', title: 'Recent completion', archived: false, archivedAt: null }] });
 });
 vi.stubGlobal('fetch', fetch); return fetch;
}
function shelf(props = {}) {
 return render(<ConfirmProvider><TaskArchiveShelf agents={[]} selectedAgent="" selectedDate="" search="" onCount={vi.fn()} onDates={vi.fn()} {...props} /></ConfirmProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('hides only archived tasks from the board', async () => {
 setup(); render(<ConfirmProvider><Tasks agents={[]} /></ConfirmProvider>);
 await screen.findByText('Recent completion');
 expect(screen.queryByText(task.title)).toBeNull();
});
it('reads details, documents and history without document mutation controls; reopens with status only', async () => {
 const fetch = setup(); shelf();
 fireEvent.click(await screen.findByRole('button', { name: /Completed interface/ }));
 expect(await screen.findByRole('button', { name: /Download\s*result.txt/ })).toBeTruthy();
 expect(screen.getByText('status: review → done')).toBeTruthy();
 expect(screen.queryByRole('button', { name: /Attach document|Remove result/ })).toBeNull();
 expect(screen.queryByText('Recent completion')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }));
 await waitFor(() => expect(screen.queryByRole('button', { name: /Completed interface/ })).toBeNull());
 const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
 expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ status: 'todo' });
});
it('keeps the record and exposes a retryable reopen failure', async () => {
 setup(true); shelf(); fireEvent.click(await screen.findByRole('button', { name: /Completed interface/ }));
 fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }));
 expect(await screen.findByRole('alert')).toBeTruthy();
 expect((screen.getByRole('button', { name: 'Reopen task' }) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.getByRole('heading', { level: 2, name: task.title })).toBeTruthy();
});
it.each([{ search: 'missing' }, { selectedAgent: 'other' }, { selectedDate: '2026-10-01' }])('filters task results (%j)', async props => {
 setup(); shelf(props); expect(await screen.findByText('No archived tasks match.')).toBeTruthy();
});
it('reports calendar dates in local time and rejects invalid timestamps', () => {
 expect(taskArchiveDate(task.archivedAt)).toBe(taskArchiveDate(new Date(task.archivedAt).toISOString()));
 expect(taskArchiveDate('invalid')).toBe('');
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './TasksPage';
import { Forge } from '../forge/ForgePage';
import { Archive } from './ArchivePage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { setActiveApiTarget } from '../../app/api';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import { targetOwnerKey } from '../../app/useOwnedApi';
const A = { id: 'a', name: 'A', enabled: true, baseUrl: 'https://a.invalid' };
const B = { ...A, id: 'b', name: 'B', baseUrl: 'https://b.invalid' };
const task = (title: string) => ({ id: 'same', projectId: 'p', title, description: '', status: 'todo', priority: 'normal', assignedAgentId: null, metadata: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
function fixture() {
 const calls: Array<{ url: string; method: string }> = [];
 const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); calls.push({ url, method: init?.method ?? 'GET' });
  const owner = url.startsWith(A.baseUrl) ? 'A' : url.startsWith(B.baseUrl) ? 'B' : 'Local';
  let body: unknown = {};
  if (url.includes('/task-board/projects')) body = { projects: [{ id: 'p', name: owner }] };
  if (url.endsWith('/task-board/tasks')) body = { tasks: [task(owner + ' task')] };
  if (url.includes('/forge/catalog')) body = { models: [], music: { available: false, models: [] } };
  if (url.includes('/forge/jobs')) body = { jobs: [{ id: 'same', kind: 'image', modelId: 'm', prompt: owner + ' job', status: 'succeeded', createdAt: '2026-01-01', artifacts: [] }] };
  if (url.includes('/forge/selections')) body = { selections: {} };
  if (url.includes('/archive/sessions?')) body = { sessions: [{ id: 'same', sessionId: 'same', agentId: 'agent', title: owner + ' session', summary: '', updatedAt: '2026-01-01' }], hasMore: false, nextCursor: null };
  if (url.includes('/continuity/cards')) body = { cards: [], hasMore: false };
  if (url.includes('/archive/calendar')) body = { dates: [] };
  if (url.includes('/mods')) body = { mods: [] };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
 });
 vi.stubGlobal('fetch', fetch); return { calls, fetch };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); setActiveApiTarget(undefined); });
function board(target: ApiTarget) { return <ConfirmProvider><Tasks key={targetOwnerKey(target)} target={target} agents={[]} /></ConfirmProvider>; }
it('regresses the archived wrong-node DELETE: a global switch cannot retarget a displayed local record', async () => {
 const { calls } = fixture(); render(board(localApiTarget));
 fireEvent.click(await screen.findByText('Local task'));
 setActiveApiTarget(B);
 fireEvent.click(screen.getByRole('button', { name: /Delete$/ }));
 fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }));
 await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
 expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/api/task-board/tasks/same']);
});
it.each([true, false])('retired delayed confirmation (%s) cannot delete identical B IDs', async (answer) => {
 const { calls } = fixture(); const view = render(board(A));
 fireEvent.click(await screen.findByText('A task'));
 fireEvent.click(screen.getByRole('button', { name: /Delete$/ }));
 await screen.findByRole('alertdialog'); view.rerender(board(B));
 await screen.findByText('B task');
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: answer ? 'Delete task' : 'Cancel' })); });
 expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);
});
it.each(['forge', 'archive'] as const)('%s resets A → Local → B with identical IDs', async (kind) => {
 fixture();
 const page = (target: ApiTarget) => kind === 'forge' ? <Forge key={targetOwnerKey(target)} target={target} selectedAgentId="agent" sessionId="s" /> : <Archive key={targetOwnerKey(target)} target={target} agents={[]} />;
 const view = render(page(A));
 for (const [target, label] of [[A, 'A'], [localApiTarget, 'Local'], [B, 'B']] as const) {
  view.rerender(page(target));
  await screen.findByText(kind === 'forge' ? label + ' job' : label + ' session');
  for (const other of ['A', 'Local', 'B'].filter(x => x !== label)) expect(screen.queryByText(other + (kind === 'forge' ? ' job' : ' session'))).toBeNull();
 }
});
it('unavailable and disabled owners fail closed', async () => {
 const { calls } = fixture(); const view = render(<Forge target={null} selectedAgentId="a" sessionId="s" />);
 await screen.findByText(/Runtime owner unavailable/);
 view.rerender(<Forge key="disabled" target={{ ...B, enabled: false }} selectedAgentId="a" sessionId="s" />);
 await screen.findByText(/Runtime owner unavailable/); expect(calls).toEqual([]);
});

it('FE002 retains the captured task mutation owner after A → Local → B', async () => {
 const { calls } = fixture();
 const view = render(board(A));
 fireEvent.click(await screen.findByText('A task'));
 view.rerender(board(localApiTarget)); await screen.findByText('Local task');
 view.rerender(board(B)); await screen.findByText('B task');
 fireEvent.click(screen.getByText('B task'));
 fireEvent.click(screen.getByRole('button', { name: /Delete$/ }));
 fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }));
 await waitFor(() => expect(calls.filter(c => c.method === 'DELETE').length).toBe(1));
 expect(calls.filter(c => c.method === 'DELETE').at(-1)?.url).toBe('https://b.invalid/api/task-board/tasks/same');
 expect(calls.filter(c => c.method === 'DELETE').some(c => c.url.includes('a.invalid'))).toBe(false);
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskActivity } from './TaskActivity';
import { ConfirmProvider } from '../../app/ConfirmDialog';
const actor = { type: 'operator', id: 'default', name: 'Rob' };
const event = (id: string) => ({ id, action: id, actor, at: '2026-10-18', changes: { status: { before: 'todo', after: 'done' } }, details: {}, runId: 'r', sessionId: 's' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture(failUpload = false) {
 const calls: Array<{ url: string; init?: RequestInit }> = [];
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); calls.push({ url, init });
  if (init?.method === 'POST') return failUpload ? response({ error: 'task_attachment_too_large' }, 413) : response({ ok: true });
  if (url.includes('/attachments')) return response({ attachments: [] });
  return response(url.includes('before=') ? { events: [event('oldest')], hasMore: false, nextCursor: null } : { events: [event('newest'), event('middle')], hasMore: true, nextCursor: 'key+/=' });
 }));
 render(<ConfirmProvider><TaskActivity taskId="t" revision="1" /></ConfirmProvider>);
 return calls;
}
it('reverses newest-first pages and prepends older history with opaque cursor', async () => {
 const calls = fixture(); await screen.findByText('middle');
 expect(screen.getAllByRole('listitem').map(el => el.querySelector('strong')?.textContent)).toEqual(['middle', 'newest']);
 fireEvent.click(screen.getByText('Load older activity')); await screen.findByText('oldest');
 expect(screen.getAllByRole('listitem').map(el => el.querySelector('strong')?.textContent)).toEqual(['oldest', 'middle', 'newest']);
 expect(calls.some(c => c.url.endsWith('before=key%2B%2F%3D'))).toBe(true);
 expect(screen.getAllByText('status: todo → done')).toHaveLength(3);
});
it('uploads a JSON data URL and refreshes history', async () => {
 const calls = fixture(); await screen.findByText('middle');
 fireEvent.change(screen.getByLabelText('Attach document'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
 await waitFor(() => expect(calls.some(c => c.init?.method === 'POST')).toBe(true));
 const payload = JSON.parse(String(calls.find(c => c.init?.method === 'POST')!.init!.body));
 expect(payload).toEqual({ name: 'notes.txt', mimeType: 'text/plain', content: 'data:text/plain;base64,aGVsbG8=' });
 await waitFor(() => expect(calls.filter(c => c.url.includes('/history')).length).toBe(2));
});
it('retains activity and exposes upload rejection', async () => {
 fixture(true); await screen.findByText('middle');
 fireEvent.change(screen.getByLabelText('Attach document'), { target: { files: [new File(['x'], 'x.txt')] } });
 expect(await screen.findByRole('alert')).toBeTruthy(); expect(screen.getByText('middle')).toBeTruthy();
});
it('keeps execution identifiers behind a disclosure and uses an intentional upload button', async () => {
 fixture(); await screen.findByText('middle');
 expect(screen.getByRole('button', { name: 'Attach document' })).toBeTruthy();
 expect(screen.getByLabelText('Attach document').hasAttribute('hidden')).toBe(true);
 for (const details of document.querySelectorAll('details')) expect(details.open).toBe(false);
 expect(screen.getAllByText('Session: s · Run: r').every(el => !!el.closest('details'))).toBe(true);
});
it('shows unknown attribution honestly without exposing an actor ID', async () => {
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(String(input).includes('/attachments') ? { attachments: [] } : { events: [{ ...event('created'), actor: { type: 'unknown', id: null, name: null }, runId: null, sessionId: null }], hasMore: false, nextCursor: null })));
 render(<ConfirmProvider><TaskActivity taskId="t" revision="1" /></ConfirmProvider>);
 expect(await screen.findByText('Unknown actor')).toBeTruthy();
});

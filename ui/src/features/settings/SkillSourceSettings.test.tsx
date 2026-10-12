import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { SkillSourceSettings, type SkillRecord } from './SkillSourceSettings';
vi.mock('../../app/api', () => ({ api: vi.fn(), fetchApi: vi.fn() }));
const mocked = vi.mocked(api);
const skill: SkillRecord = { id: 'test', name: 'Test', description: '', content: '# Test', lifecycle: 'available', global: false, source: 'postgres', version: 'hash' };
const source = { repository: '/tmp/repo', ref: 'main', path: '.', enabled: false, cron: '0 */6 * * *', timezone: 'UTC', fetchTimeoutMs: 120000, installedRevision: 'commit', lastSuccessAt: '2026-10-11', syncing: false };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup(initial: typeof source | null = null, storage = 'postgres') {
  let current = initial;
  mocked.mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') { current = JSON.parse(String(init.body)); return {} as never; }
    if (init?.method === 'DELETE') { current = null; return {} as never; }
    if (path.endsWith('/sync')) return { status: 'updated' } as never;
    if (path.endsWith('/source')) return { source: current } as never;
    if (path.endsWith('/files')) return { files: storage === 'filesystem' ? [{ path: 'assets/icon.svg', bytes: 10, executable: false }] : [] } as never;
    return { history: [{ id: '1', status: 'failed', revision: null, contentHash: null, error: 'fetch failed', startedAt: '2026-10-10', completedAt: '2026-10-10' }], nextCursor: null } as never;
  });
  render(<ConfirmProvider><SkillSourceSettings skill={{ ...skill, storage }} onRefresh={vi.fn()} /></ConfirmProvider>);
}
it('connects and edits a complete Git source and manually syncs with JSON', async () => {
  setup();
  await waitFor(() => expect(screen.getByLabelText('Repository').closest('fieldset')?.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'https://example.org/repo.git' } });
  fireEvent.change(screen.getByLabelText('Skill path'), { target: { value: 'skills/test' } });
  fireEvent.click(screen.getByLabelText('Automatic sync'));
  fireEvent.click(screen.getByRole('button', { name: 'Connect Git source' }));
  expect(screen.queryByLabelText('Sync timezone')).toBeNull();
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/api/settings/skills/test/source', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ repository: 'https://example.org/repo.git', ref: 'main', path: 'skills/test', enabled: true, cron: '0 */6 * * *', fetchTimeoutMs: 120000 }) })));
  fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/api/settings/skills/test/sync', expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })));
  expect(await screen.findByText('Sync updated.')).toBeTruthy();
});
it('requires confirmation before detaching text and retains recorded history', async () => {
  setup(source);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove source' }));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(mocked.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));
  expect(screen.queryByLabelText('Sync timezone')).toBeNull();
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/api/settings/skills/test/source', { method: 'DELETE' }));
  expect(mocked.mock.calls.some(([path]) => path.includes('/history'))).toBe(false);
});
it('shows package artifacts and forbids detach while allowing schedule edits', async () => {
  setup(source, 'filesystem');
  await waitFor(() => expect(screen.getByLabelText('Repository').closest('fieldset')?.disabled).toBe(false));
  expect(screen.getByRole('button', { name: 'Remove source' })).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('Automatic sync').closest('fieldset')?.disabled).toBe(false);
  expect(screen.getByText(/Packages cannot be detached/)).toBeTruthy();
});
it('reports sync failure and refreshes the persisted result rather than showing success', async () => {
  setup(source);
  const original = mocked.getMockImplementation()!;
  mocked.mockImplementation(async (path, init) => { if (path.endsWith('/sync')) throw new Error('skill_local_changes'); return original(path, init); });
  fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
  expect((await screen.findByRole('alert')).textContent).toContain('skill_local_changes');
  expect(screen.queryByText('Sync updated.')).toBeNull();
});

it('retains unsaved source edits when refreshing status', async () => {
  setup(source);
  await waitFor(() => expect(screen.getByLabelText('Repository').closest('fieldset')?.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Ref'), { target: { value: 'draft-ref' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(screen.getByLabelText('Repository').closest('fieldset')?.disabled).toBe(false));
  expect(screen.getByLabelText('Ref')).toHaveProperty('value', 'draft-ref');
});
it('keeps request timeout distinct from terminal sync failure', async () => {
  setup(source);
  const original = mocked.getMockImplementation()!;
  mocked.mockImplementation(async (path, init) => { if (path.endsWith('/sync')) throw new DOMException('Request deadline exceeded', 'TimeoutError'); return original(path, init); });
  fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
  expect((await screen.findByRole('alert')).textContent).toContain('may still be running');
});
it('loads only configuration, never history or installed artifacts', async () => {
 setup(source,'filesystem');
 await waitFor(() => expect(screen.getByLabelText('Repository').closest('fieldset')?.disabled).toBe(false));
 expect(mocked.mock.calls.every(([path])=>path.endsWith('/source'))).toBe(true);
 expect(screen.queryByText('Sync history')).toBeNull();
 expect(screen.queryByText('Installed path')).toBeNull();
 expect(screen.queryByRole('button',{name:/Download/})).toBeNull();
});

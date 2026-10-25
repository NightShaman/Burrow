import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import type { Agent } from '../../app/types';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { SkillsSettings } from './SkillsSettings';
import { SkillRepositoryImport } from './SkillRepositoryImport';
import { SkillSourceSettings } from './SkillSourceSettings';

vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
const mocked = vi.mocked(api);
const item = { id: 'review', name: 'Review', description: '', content: '# Review', lifecycle: 'available', global: false, source: 'sqlite', version: '1' };
const agents = [{ id: 'agent', name: 'Agent' }] as Agent[];
function Leave() { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(() => document.body.setAttribute('data-left', 'yes'))}>Leave settings</button>; }
afterEach(() => { cleanup(); mocked.mockReset(); document.body.removeAttribute('data-left'); });

it('guards installed selection and retains failed-save edits', async () => {
  mocked.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') throw new Error('offline');
    return (path === '/api/settings/skills' ? { skills: [item, { ...item, id: 'other', name: 'Other' }] } : { assignedSkillIds: [], globalSkillIds: [] }) as never;
  });
  render(<ConfirmProvider><UnsavedChangesProvider><SkillsSettings agents={agents} agentId="agent" section="installed" /><Leave /></UnsavedChangesProvider></ConfirmProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Review/i }));
  fireEvent.change(screen.getByLabelText('Content'), { target: { value: '# Edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
  expect(screen.getByLabelText('Content')).toHaveProperty('value', '# Edited');
  expect(document.body.hasAttribute('data-left')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

it('guards a repository draft and does not install without a preview', async () => {
  mocked.mockResolvedValue({} as never);
  render(<UnsavedChangesProvider><SkillRepositoryImport onInstalled={vi.fn()} /><Leave /></UnsavedChangesProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: '/repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Preview a valid repository'));
  expect(mocked).not.toHaveBeenCalled();
  expect(document.body.hasAttribute('data-left')).toBe(false);
});

it('guards source edits, preserving failed writes and discard baseline', async () => {
  mocked.mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') throw new Error('offline');
    return { source: null } as never;
  });
  render(<ConfirmProvider><UnsavedChangesProvider><SkillSourceSettings skill={item} onRefresh={vi.fn()} /><Leave /></UnsavedChangesProvider></ConfirmProvider>);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Repository' }), { target: { value: '/repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
  expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveProperty('value', '/repo');
  fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveProperty('value', '');
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

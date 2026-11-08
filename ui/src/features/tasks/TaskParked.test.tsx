import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './TasksPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';

const task = {
  id: 'parked-task',
  projectId: 'p',
  title: 'A possibility, not an obligation',
  description: '',
  status: 'parked',
  priority: 'normal',
  assignedAgentId: 'a',
  metadata: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
function fixture() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body = url.includes('/projects')
        ? { projects: [{ id: 'p', name: 'Project' }] }
        : init?.method === 'PATCH'
          ? { task: { ...task, ...JSON.parse(String(init.body)) } }
          : url.endsWith('/tasks/parked-task')
            ? { task }
            : { tasks: [task, { ...task, id: 'active', title: 'Active work', status: 'todo' }] };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <ConfirmProvider>
      <Tasks agents={[]} />
    </ConfirmProvider>,
  );
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps parked cards and column absent until explicitly opened, without a count', async () => {
  fixture();
  await screen.findByText('Active work');
  const toggle = screen.getByRole('button', { name: 'Parked' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(task.title)).toBeNull();
  expect(document.querySelector('#parked-task-column')).toBeNull();
  fireEvent.click(toggle);
  const card = screen.getByRole('button', { name: new RegExp(task.title) });
  expect(card.className).toBe('task-card');
  const column = document.querySelector('#parked-task-column')!;
  expect(column.className).toBe('kanban-column');
  expect(column.querySelector('header strong')).toBeNull();
  fireEvent.click(toggle);
  expect(screen.queryByText(task.title)).toBeNull();
  expect(toggle.textContent).toBe('Parked');
});
it('supports parking/unparking in the normal editor and disables execution while parked', async () => {
  const calls = fixture();
  await screen.findByText('Active work');
  fireEvent.click(screen.getByRole('button', { name: 'Parked' }));
  fireEvent.click(screen.getByText(task.title));
  const dialog = screen.getByRole('dialog');
  const status = within(dialog).getByRole('combobox', { name: 'Status' }) as HTMLSelectElement;
  expect(status.value).toBe('parked');
  expect(
    (within(dialog).getByRole('button', { name: /Execute/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(status, { target: { value: 'todo' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
  expect(JSON.parse(String(calls.find((c) => c.init?.method === 'PATCH')!.init!.body)).status).toBe(
    'todo',
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByText(task.title));
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
    target: { value: 'parked' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(2));
  expect(
    JSON.parse(String(calls.filter((c) => c.init?.method === 'PATCH')[1].init!.body)).status,
  ).toBe('parked');
});

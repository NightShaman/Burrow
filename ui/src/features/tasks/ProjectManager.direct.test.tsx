import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import { ProjectManager } from './ProjectManager';
import type { Project } from './taskDomain';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const project: Project = { id: 'p1', name: 'Original' };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function Harness({ unmountOnClose = false }: { unmountOnClose?: boolean }) {
  const [open, setOpen] = useState(true);
  const [projects, setProjects] = useState([project]);
  return (
    <ConfirmProvider>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <div data-testid="board">{projects.map((p) => p.name).join(',')}</div>
      {(!unmountOnClose || open) && (
        <ProjectManager
          open={open}
          initiallyNew={false}
          onClose={() => setOpen(false)}
          projects={projects}
          setProjects={setProjects}
          onProjectCreated={vi.fn()}
          onProjectDeleted={vi.fn()}
          pending={new Set()}
          setSaving={vi.fn()}
          setError={vi.fn()}
          taskSaving={false}
        />
      )}
    </ConfirmProvider>
  );
}
function edit() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}
function name(value: string) {
  fireEvent.change(screen.getByLabelText('Project name *'), { target: { value } });
}

it.each([false, true])(
  'old save cannot affect reopened editor (unmount=%s)',
  async (unmountOnClose) => {
    const request = deferred<{ project: Project }>();
    vi.mocked(api).mockReturnValueOnce(request.promise);
    render(<Harness unmountOnClose={unmountOnClose} />);
    edit();
    name('Submitted');
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close project manager' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    edit();
    name('New draft');
    await act(async () => {
      request.resolve({ project: { ...project, name: 'Saved' } });
      await request.promise;
    });
    expect((screen.getByLabelText('Project name *') as HTMLInputElement).value).toBe('New draft');
    expect(screen.getByTestId('board').textContent).toBe('Saved');
  },
);
it('preserves edits made while the current save is pending', async () => {
  const request = deferred<{ project: Project }>();
  vi.mocked(api).mockReturnValueOnce(request.promise);
  render(<Harness />);
  edit();
  name('Submitted');
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
  name('Later edit');
  await act(async () => {
    request.resolve({ project: { ...project, name: 'Submitted' } });
    await request.promise;
  });
  expect((screen.getByLabelText('Project name *') as HTMLInputElement).value).toBe('Later edit');
  expect(screen.getByTestId('board').textContent).toBe('Submitted');
});

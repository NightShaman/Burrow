import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tasks } from '../../src/features/tasks/TasksPage';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';
const at = '2026-11-06T04:00:00Z';
const project = {
  id: 'fixture-project',
  name: 'Initial project',
  description: 'Synthetic',
  notes: '',
  pathEntries: [],
};
const task = {
  id: 'fixture-task',
  projectId: project.id,
  title: 'Initial task',
  description: 'Synthetic',
  status: 'todo',
  priority: 'normal',
  assignedAgentId: null,
  metadata: {},
  createdAt: at,
  updatedAt: at,
};
const requests: unknown[] = [],
  errors: string[] = [];
let release: (() => void) | null = null,
  hold = false;
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
Object.assign(window, {
  fixtureEvidence: { requests, errors },
  fixtureHoldSave: () => {
    hold = true;
  },
  fixtureReleaseSave: () => {
    if (!release) throw new Error('No pending save');
    const done = release;
    release = null;
    done();
  },
});
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push({ path, method, ...(method !== 'GET' ? { body } : {}) });
  if (hold && method !== 'GET' && /\/api\/task-board\/(tasks|projects)/.test(path)) {
    hold = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  let data: any;
  if (path === '/api/task-board/projects' && method === 'GET') data = { projects: [project] };
  else if (path === '/api/task-board/tasks' && method === 'GET') data = { tasks: [task] };
  else if (/^\/api\/task-board\/tasks\/[^/]+\/(history|attachments)/.test(path))
    data = path.endsWith('history')
      ? { events: [], hasMore: false, nextCursor: null }
      : { attachments: [] };
  else if (path === `/api/task-board/tasks/${task.id}` && method === 'PATCH') {
    Object.assign(task, body);
    data = { task };
  } else if (
    path === `/api/task-board/projects/${project.id}` &&
    (method === 'PATCH' || method === 'PUT')
  ) {
    Object.assign(project, body);
    data = { project };
  } else if (path === '/api/task-board/tasks' && method === 'POST') {
    Object.assign(task, body);
    data = { task };
  } else if (path === '/api/task-board/projects' && method === 'POST') {
    Object.assign(project, body);
    data = { project };
  } else throw new Error(`Unexpected mocked API ${method} ${path}`);
  return Response.json(data);
};
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <main className="cockpit" data-theme="smatchet">
      <header className="app-header">Actual Tasks editor — delayed synthetic saves</header>
      <section className="workspace">
        <Tasks agents={[]} />
      </section>
    </main>
  </ConfirmProvider>,
);

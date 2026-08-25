export function createTaskBoardRoutes({ readJsonBody, sendJson, validateBoundaryBody, withTaskBoard, taskStatuses, taskPriorities, executeBoardTask } = {}) {
  return async function handleTaskBoardRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/task-board/statuses') {
      sendJson(res, 200, { ok: true, statuses: taskStatuses });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/priorities') {
      sendJson(res, 200, { ok: true, priorities: taskPriorities });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/projects') {
      sendJson(res, 200, await withTaskBoard((store) => ({ ok: true, projects: store.listProjects() })));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/task-board/projects') {
      const body = validateBoundaryBody('project-create', await readJsonBody(req));
      sendJson(res, 201, await withTaskBoard((store) => ({ ok: true, project: store.createProject(body) })));
      return true;
    }
    if (url.pathname.startsWith('/api/task-board/projects/')) {
      const projectId = decodeURIComponent(url.pathname.slice('/api/task-board/projects/'.length));
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const project = await withTaskBoard((store) => store.updateProject(projectId, body));
        sendJson(res, project ? 200 : 404, project ? { ok: true, project } : { ok: false, error: 'project_not_found' });
        return true;
      }
      if (req.method === 'DELETE') {
        const project = await withTaskBoard((store) => store.deleteProject(projectId));
        sendJson(res, project ? 200 : 404, project ? { ok: true, project } : { ok: false, error: 'project_not_found' });
        return true;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/tasks') {
      sendJson(res, 200, await withTaskBoard((store) => ({ ok: true, tasks: store.listTasks({
        projectId: url.searchParams.get('projectId'),
        status: url.searchParams.get('status'),
        priority: url.searchParams.get('priority'),
        assignedAgentId: url.searchParams.get('assignedAgentId'),
      }) })));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/task-board/tasks') {
      const body = validateBoundaryBody('task-create', await readJsonBody(req));
      sendJson(res, 201, await withTaskBoard((store) => ({ ok: true, task: store.createTask(body) })));
      return true;
    }
    if (url.pathname.startsWith('/api/task-board/tasks/')) {
      const parts = url.pathname.slice('/api/task-board/tasks/'.length).split('/').map(decodeURIComponent);
      const taskId = parts[0];
      const action = parts[1] || null;
      if (req.method === 'POST' && action === 'execute') {
        sendJson(res, 200, await executeBoardTask(taskId));
        return true;
      }
      if (req.method === 'PATCH' && !action) {
        const body = await readJsonBody(req);
        const task = await withTaskBoard((store) => store.updateTask(taskId, body));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' });
        return true;
      }
      if (req.method === 'DELETE' && !action) {
        const task = await withTaskBoard((store) => store.deleteTask(taskId));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' });
        return true;
      }
      if (req.method === 'GET' && !action) {
        const task = await withTaskBoard((store) => store.getTask(taskId));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' });
        return true;
      }
    }
    return false;
  };
}

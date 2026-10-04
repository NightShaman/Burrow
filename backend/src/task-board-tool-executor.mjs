function text(value) { return String(value ?? '').trim(); }

function compactTask(task) {
  return task && {
    id: task.id, projectId: task.projectId, title: task.title,
    description: task.description, status: task.status, priority: task.priority,
    assignedAgentId: task.assignedAgentId, metadata: task.metadata,
    execution: task.execution, createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

async function resolveProjectId(taskBoard, projectRef) {
  const ref = text(projectRef);
  if (!ref) return ref;
  if (/^[A-Za-z0-9._-]{1,96}$/.test(ref) && await taskBoard.getProject(ref)) return ref;
  const matches = (await taskBoard.listProjects()).filter((project) => project.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error('task_project_name_ambiguous');
  return ref;
}

export async function executeTaskBoardListTool({ arguments: args = {}, store } = {}) {
  try {
    if (!store) throw new Error('task_board_store_required');
    const tasks = await store.listTasks({
      projectId: await resolveProjectId(store, args.projectId) || null,
      status: text(args.status) || null,
      priority: text(args.priority) || null,
      assignedAgentId: text(args.assignedAgentId) || null,
    });
    return { tool: 'tasks_list', ok: true, tasks: tasks.map(compactTask), resultCount: tasks.length, error: null };
  } catch (error) { return { tool: 'tasks_list', ok: false, tasks: [], resultCount: 0, error: error?.message || 'task_board_list_failed' }; }
}

// Assignment is board metadata, not dispatch. The store validates that an
// explicit assignee is a known agent via its foreign-key constraint.
export async function executeTaskBoardCreateTool({ arguments: args = {}, agentId = null, store } = {}) {
  if (!text(agentId)) return { tool: 'tasks_create', ok: false, error: 'task_board_agent_unavailable' };
  try {
    if (!store) throw new Error('task_board_store_required');
    const task = await store.createTask({
      projectId: await resolveProjectId(store, args.projectId), title: args.title, description: args.description,
      status: args.status, priority: args.priority, metadata: args.metadata,
      assignedAgentId: args.assignedAgentId === undefined ? agentId : (text(args.assignedAgentId) || null), actorAgentId: agentId,
    });
    return { tool: 'tasks_create', ok: true, task: compactTask(task), error: null };
  } catch (error) { return { tool: 'tasks_create', ok: false, error: error?.message || 'task_board_create_failed' }; }
}

// Task assignment is board metadata, not an edit boundary. A reviewed update
// may modify any existing task, including moving it to another existing agent.
export async function executeTaskBoardUpdateTool({ arguments: args = {}, agentId = null, store } = {}) {
  try {
    if (!store) throw new Error('task_board_store_required');
    {
      const current = await store.getTask(args.taskId);
      if (!current) return { tool: 'tasks_update', ok: false, error: 'task_not_found' };
      const task = await store.updateTask(args.taskId, {
        title: args.title, description: args.description, status: args.status,
        priority: args.priority, metadata: args.metadata,
        ...(args.assignedAgentId === undefined ? {} : { assignedAgentId: text(args.assignedAgentId) || null }),
        actorAgentId: agentId,
      });
      return { tool: 'tasks_update', ok: true, task: compactTask(task), error: null };
    }
  } catch (error) { return { tool: 'tasks_update', ok: false, error: error?.message || 'task_board_update_failed' }; }
}


export async function executeTaskBoardReassignTool({ arguments: args = {}, agentId = null, store } = {}) {
  if (!text(args.taskId) || !text(args.assignedAgentId)) return { tool: 'tasks_assign', ok: false, error: 'task_board_reassign_input_required' };
  try {
    if (!store) throw new Error('task_board_store_required');
    {
      const task = await store.updateTask(args.taskId, { assignedAgentId: text(args.assignedAgentId), actorAgentId: agentId });
      return task ? { tool: 'tasks_assign', ok: true, task: compactTask(task), error: null } : { tool: 'tasks_assign', ok: false, error: 'task_not_found' };
    }
  } catch (error) { return { tool: 'tasks_assign', ok: false, error: error?.message || 'task_board_reassign_failed' }; }
}

export async function executeTaskBoardDeleteTool({ arguments: args = {}, store } = {}) {
  if (!text(args.taskId)) return { tool: 'tasks_delete', ok: false, error: 'taskId_required' };
  try {
    if (!store) throw new Error('task_board_store_required');
    {
      const task = await store.deleteTask(args.taskId);
      return task ? { tool: 'tasks_delete', ok: true, task: compactTask(task), error: null } : { tool: 'tasks_delete', ok: false, error: 'task_not_found' };
    }
  } catch (error) { return { tool: 'tasks_delete', ok: false, error: error?.message || 'task_board_delete_failed' }; }
}

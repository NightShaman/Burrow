import { TaskBoardStore } from './task-board-store.mjs';

function text(value) { return String(value ?? '').trim(); }
function taskBoardDatabasePath(databasePath, store) { return store?.databasePath || databasePath || null; }

function compactTask(task) {
  return task && {
    id: task.id, projectId: task.projectId, title: task.title,
    description: task.description, status: task.status, priority: task.priority,
    assignedAgentId: task.assignedAgentId, metadata: task.metadata,
    execution: task.execution, createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

function resolveProjectId(taskBoard, projectRef) {
  const ref = text(projectRef);
  if (!ref) return ref;
  if (taskBoard.getProject(ref)) return ref;
  const matches = taskBoard.listProjects().filter((project) => project.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error('task_project_name_ambiguous');
  return ref;
}

function withStore(store, databasePath, operation) {
  const taskBoard = store || new TaskBoardStore({ databasePath });
  try { return operation(taskBoard); } finally { if (!store) taskBoard.close(); }
}

export function executeTaskBoardListTool({ arguments: args = {}, databasePath = null, store = null } = {}) {
  try {
    const tasks = withStore(store, databasePath, (taskBoard) => taskBoard.listTasks({
      projectId: resolveProjectId(taskBoard, args.projectId) || null,
      status: text(args.status) || null,
      priority: text(args.priority) || null,
      assignedAgentId: text(args.assignedAgentId) || null,
    }));
    return { tool: 'tasks_list', ok: true, databasePath: taskBoardDatabasePath(databasePath, store), tasks: tasks.map(compactTask), resultCount: tasks.length, error: null };
  } catch (error) { return { tool: 'tasks_list', ok: false, tasks: [], resultCount: 0, error: error?.message || 'task_board_list_failed' }; }
}

// Assignment is board metadata, not dispatch. The store validates that an
// explicit assignee is a known agent via its foreign-key constraint.
export function executeTaskBoardCreateTool({ arguments: args = {}, agentId = null, databasePath = null, store = null } = {}) {
  if (!text(agentId)) return { tool: 'tasks_create', ok: false, error: 'task_board_agent_unavailable' };
  try {
    const task = withStore(store, databasePath, (taskBoard) => taskBoard.createTask({
      projectId: resolveProjectId(taskBoard, args.projectId), title: args.title, description: args.description,
      status: args.status, priority: args.priority, metadata: args.metadata,
      assignedAgentId: args.assignedAgentId === undefined ? agentId : (text(args.assignedAgentId) || null), actorAgentId: agentId,
    }));
    return { tool: 'tasks_create', ok: true, databasePath: taskBoardDatabasePath(databasePath, store), task: compactTask(task), error: null };
  } catch (error) { return { tool: 'tasks_create', ok: false, error: error?.message || 'task_board_create_failed' }; }
}

// Task assignment is board metadata, not an edit boundary. A reviewed update
// may modify any existing task, including moving it to another existing agent.
export function executeTaskBoardUpdateTool({ arguments: args = {}, agentId = null, databasePath = null, store = null } = {}) {
  try {
    return withStore(store, databasePath, (taskBoard) => {
      const current = taskBoard.getTask(args.taskId);
      if (!current) return { tool: 'tasks_update', ok: false, error: 'task_not_found' };
      const task = taskBoard.updateTask(args.taskId, {
        title: args.title, description: args.description, status: args.status,
        priority: args.priority, metadata: args.metadata,
        ...(args.assignedAgentId === undefined ? {} : { assignedAgentId: text(args.assignedAgentId) || null }),
        actorAgentId: agentId,
      });
      return { tool: 'tasks_update', ok: true, databasePath: taskBoardDatabasePath(databasePath, store), task: compactTask(task), error: null };
    });
  } catch (error) { return { tool: 'tasks_update', ok: false, error: error?.message || 'task_board_update_failed' }; }
}


export function executeTaskBoardReassignTool({ arguments: args = {}, agentId = null, databasePath = null, store = null } = {}) {
  if (!text(args.taskId) || !text(args.assignedAgentId)) return { tool: 'tasks_assign', ok: false, error: 'task_board_reassign_input_required' };
  try {
    return withStore(store, databasePath, (taskBoard) => {
      const task = taskBoard.updateTask(args.taskId, { assignedAgentId: text(args.assignedAgentId), actorAgentId: agentId });
      return task ? { tool: 'tasks_assign', ok: true, databasePath: taskBoardDatabasePath(databasePath, store), task: compactTask(task), error: null } : { tool: 'tasks_assign', ok: false, error: 'task_not_found' };
    });
  } catch (error) { return { tool: 'tasks_assign', ok: false, error: error?.message || 'task_board_reassign_failed' }; }
}

export function executeTaskBoardDeleteTool({ arguments: args = {}, databasePath = null, store = null } = {}) {
  if (!text(args.taskId)) return { tool: 'tasks_delete', ok: false, error: 'taskId_required' };
  try {
    return withStore(store, databasePath, (taskBoard) => {
      const task = taskBoard.deleteTask(args.taskId);
      return task ? { tool: 'tasks_delete', ok: true, databasePath: taskBoardDatabasePath(databasePath, store), task: compactTask(task), error: null } : { tool: 'tasks_delete', ok: false, error: 'task_not_found' };
    });
  } catch (error) { return { tool: 'tasks_delete', ok: false, error: error?.message || 'task_board_delete_failed' }; }
}

import { randomUUID } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

export const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']);
export const TASK_PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);
const STATUS_SET = new Set(TASK_STATUSES);
const PRIORITY_SET = new Set(TASK_PRIORITIES);
const text = (value) => String(value ?? '').trim();
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? {});
const parseJson = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const PROVENANCE_KEYS = new Set(['createdBy', 'editedBy']);

function projectRow(row) { return row && { id: row.id, name: row.name, description: row.description || '', createdAt: row.created_at, updatedAt: row.updated_at }; }
function taskRow(row) { const metadata = parseJson(row?.metadata_json); return row && { id: row.id, projectId: row.project_id, title: row.title, description: row.description || '', status: row.status, priority: row.priority, assignedAgentId: row.assigned_agent_id || null, metadata, execution: parseJson(row.execution_json), createdAt: row.created_at, updatedAt: row.updated_at, terminalAt: metadata.terminalAt || null }; }
function id(value, field) { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error(`${field}_invalid`); return result; }
function actorId(value) { const result = text(value); if (!result) return null; return id(result, 'task_actor_agent_id'); }
function stripProvenance(metadata = {}) { return Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => !PROVENANCE_KEYS.has(key))); }
function actorEntry(agentId, at, extra = {}) { return { agentId: actorId(agentId), at, ...extra }; }
function editedLog(metadata = {}) { return Array.isArray(metadata.editedBy) ? metadata.editedBy.filter((entry) => entry && typeof entry === 'object').slice(-99) : []; }
function withCreatedBy(metadata = {}, { actorAgentId = null, timestamp }) {
  return { ...stripProvenance(metadata), createdBy: actorEntry(actorAgentId, timestamp), editedBy: [] };
}
function withEditedBy(currentMetadata = {}, nextMetadata = {}, { actorAgentId = null, timestamp, action = 'update', fields = [] } = {}) {
  const createdBy = currentMetadata.createdBy && typeof currentMetadata.createdBy === 'object' ? currentMetadata.createdBy : null;
  return {
    ...stripProvenance(nextMetadata),
    ...(createdBy ? { createdBy } : {}),
    editedBy: [...editedLog(currentMetadata), actorEntry(actorAgentId, timestamp, { action, fields: fields.map(text).filter(Boolean).slice(0, 24) })],
  };
}
function changedFields(current, task, nextStatus) {
  const fields = [];
  if (task.projectId !== undefined && task.projectId !== current.projectId) fields.push('projectId');
  if (task.title !== undefined && task.title !== current.title) fields.push('title');
  if (task.description !== undefined && task.description !== current.description) fields.push('description');
  if (task.status !== undefined && nextStatus !== current.status) fields.push('status');
  if (task.priority !== undefined && task.priority !== current.priority) fields.push('priority');
  if (task.assignedAgentId !== undefined && task.assignedAgentId !== current.assignedAgentId) fields.push('assignedAgentId');
  if (task.metadata !== undefined) fields.push('metadata');
  return fields;
}
function taskInput(input = {}, { partial = false } = {}) {
  const result = {};
  if (!partial || input.title !== undefined) { result.title = text(input.title); if (!result.title || result.title.length > 240) throw new Error('task_title_invalid'); }
  if (!partial || input.projectId !== undefined) result.projectId = id(input.projectId, 'task_project_id');
  if (input.description !== undefined) { result.description = text(input.description); if (result.description.length > 20_000) throw new Error('task_description_too_large'); }
  if (input.status !== undefined) { result.status = text(input.status).toLowerCase(); if (!STATUS_SET.has(result.status)) throw new Error('task_status_invalid'); }
  if (input.priority !== undefined) { result.priority = text(input.priority).toLowerCase(); if (!PRIORITY_SET.has(result.priority)) throw new Error('task_priority_invalid'); }
  if (input.assignedAgentId !== undefined) result.assignedAgentId = input.assignedAgentId === null || input.assignedAgentId === '' ? null : id(input.assignedAgentId, 'task_assigned_agent_id');
  if (input.metadata !== undefined) { if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) throw new Error('task_metadata_invalid'); result.metadata = input.metadata; }
  return result;
}

export class TaskBoardStore {
  constructor({ databasePath } = {}) { this.db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() }); }
  close() { this.db.close(); }
  listProjects() { return this.db.prepare('SELECT * FROM task_board_projects ORDER BY name COLLATE NOCASE, id').all().map(projectRow); }
  getProject(projectId) { return projectRow(this.db.prepare('SELECT * FROM task_board_projects WHERE id=?').get(id(projectId, 'project_id'))); }
  createProject(input = {}) { const name = text(input.name); if (!name || name.length > 160) throw new Error('project_name_invalid'); const description = text(input.description); if (description.length > 20_000) throw new Error('project_description_too_large'); const timestamp = now(); const projectId = input.id ? id(input.id, 'project_id') : randomUUID(); this.db.prepare('INSERT INTO task_board_projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, name, description, timestamp, timestamp); return this.getProject(projectId); }
  updateProject(projectId, input = {}) { const current = this.getProject(projectId); if (!current) return null; const name = input.name === undefined ? current.name : text(input.name); const description = input.description === undefined ? current.description : text(input.description); if (!name || name.length > 160) throw new Error('project_name_invalid'); if (description.length > 20_000) throw new Error('project_description_too_large'); this.db.prepare('UPDATE task_board_projects SET name=?, description=?, updated_at=? WHERE id=?').run(name, description, now(), current.id); return this.getProject(current.id); }
  deleteProject(projectId) { const current = this.getProject(projectId); if (!current) return null; this.db.prepare('DELETE FROM task_board_projects WHERE id=?').run(current.id); return current; }
  listTasks({ projectId = null, status = null, priority = null, assignedAgentId = null } = {}) { if (status && !STATUS_SET.has(text(status).toLowerCase())) throw new Error('task_status_invalid'); if (priority && !PRIORITY_SET.has(text(priority).toLowerCase())) throw new Error('task_priority_invalid'); return this.db.prepare(`SELECT * FROM task_board_tasks WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR status=?) AND (? IS NULL OR priority=?) AND (? IS NULL OR assigned_agent_id=?) ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC, created_at DESC`).all(projectId || null, projectId || null, status ? text(status).toLowerCase() : null, status ? text(status).toLowerCase() : null, priority ? text(priority).toLowerCase() : null, priority ? text(priority).toLowerCase() : null, assignedAgentId || null, assignedAgentId || null).map(taskRow); }
  getTask(taskId) { return taskRow(this.db.prepare('SELECT * FROM task_board_tasks WHERE id=?').get(id(taskId, 'task_id'))); }
  createTask(input = {}) { const task = taskInput(input); if (!this.getProject(task.projectId)) throw new Error('task_project_not_found'); const timestamp = now(); const taskId = input.id ? id(input.id, 'task_id') : randomUUID(); const metadata = withCreatedBy(task.metadata || {}, { actorAgentId: input.actorAgentId ?? task.assignedAgentId ?? null, timestamp }); this.db.prepare('INSERT INTO task_board_tasks (id,project_id,title,description,status,priority,assigned_agent_id,metadata_json,execution_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(taskId, task.projectId, task.title, task.description || '', task.status || 'backlog', task.priority || 'normal', task.assignedAgentId || null, json(metadata), json({}), timestamp, timestamp); return this.getTask(taskId); }
  updateTask(taskId, input = {}) { const current = this.getTask(taskId); if (!current) return null; const task = taskInput(input, { partial: true }); if (task.projectId && !this.getProject(task.projectId)) throw new Error('task_project_not_found'); const timestamp = now(); const nextStatus = task.status ?? current.status; const baseMetadata = { ...(task.metadata ?? current.metadata) }; if (['done', 'cancelled'].includes(nextStatus) && !['done', 'cancelled'].includes(current.status)) baseMetadata.terminalAt = timestamp; const fields = changedFields(current, task, nextStatus); const metadata = withEditedBy(current.metadata || {}, baseMetadata, { actorAgentId: input.actorAgentId ?? null, timestamp, fields }); this.db.prepare('UPDATE task_board_tasks SET project_id=?, title=?, description=?, status=?, priority=?, assigned_agent_id=?, metadata_json=?, updated_at=? WHERE id=?').run(task.projectId ?? current.projectId, task.title ?? current.title, task.description ?? current.description, nextStatus, task.priority ?? current.priority, task.assignedAgentId === undefined ? current.assignedAgentId : task.assignedAgentId, json(metadata), timestamp, current.id); return this.getTask(current.id); }
  deleteTask(taskId) { const current = this.getTask(taskId); if (!current) return null; this.db.prepare('DELETE FROM task_board_tasks WHERE id=?').run(current.id); return current; }
  startExecution(taskId, execution = {}) {
    const current = this.getTask(taskId);
    if (!current) return null;
    const dispatchedAt = now();
    const receipt = {
      taskId: current.id,
      agentId: text(execution.agentId) || current.assignedAgentId || null,
      sessionId: text(execution.sessionId) || 'default',
      runId: text(execution.runId) || null,
      status: 'running',
      dispatchedAt,
      traceDir: execution.traceDir || null,
      decision: null,
      ok: null,
      completedAt: null,
      error: null,
      result: null,
    };
    this.db.prepare('UPDATE task_board_tasks SET execution_json=?, updated_at=? WHERE id=?').run(json(receipt), dispatchedAt, current.id);
    return this.getTask(current.id);
  }
  recordExecution(taskId, execution = {}) {
    const current = this.getTask(taskId);
    if (!current) return null;
    const completedAt = now();
    const receipt = {
      ...(current.execution && typeof current.execution === 'object' ? current.execution : {}),
      taskId: current.id,
      agentId: text(execution.agentId) || current.assignedAgentId || null,
      sessionId: text(execution.sessionId) || 'default',
      runId: text(execution.runId) || null,
      status: execution.status || (execution.ok ? 'completed' : 'failed'),
      executedAt: execution.executedAt || completedAt,
      completedAt,
      traceDir: execution.traceDir || null,
      decision: execution.decision || null,
      ok: Boolean(execution.ok),
      error: execution.ok ? null : (execution.error || 'task_execution_failed'),
      result: execution.result && typeof execution.result === 'object' ? execution.result : null,
    };
    // Execution produces evidence, not a board-state decision. Rob moves the
    // task when the result is actually ready for review, done, or rework.
    this.db.prepare('UPDATE task_board_tasks SET execution_json=?, updated_at=? WHERE id=?').run(json(receipt), completedAt, current.id);
    return this.getTask(current.id);
  }
}
